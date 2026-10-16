import { createHash } from 'node:crypto';
import {
  DEFAULT_CALL_WINDOW_HOURS,
  FINAL_ATTEMPT_STATUSES,
  MAX_CALL_ATTEMPTS,
  MAX_SCHEDULE_AHEAD_DAYS,
  type AttemptStatus,
  type CallRequest,
  type CallRequestReceipt,
  type FinalAttemptStatus,
} from '@orderline/contracts/integration';
import {
  isCallable,
  nextCallableTime,
  planAfterAttempt,
  type CallingPolicy,
} from './policy.js';
import type {
  CallManagementRepository,
  StoredAttempt,
  StoredCallRequest,
} from './repository.js';
import {
  TelephonyError,
  type ProviderCallStatus,
  type Telephony,
} from './telephony.js';

export class CallManagementError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AttemptFinishedEvent {
  /** The request after its status has been settled for this event. */
  request: StoredCallRequest;
  /** null when the request expired without a further attempt. */
  attempt: StoredAttempt | null;
}

type LogEvent = (fields: Record<string, unknown>, message: string) => void;
type Dependencies = {
  repository: CallManagementRepository;
  telephony: Telephony;
  policy: CallingPolicy;
  maxConcurrentCalls: number;
  maxCallSeconds: number;
  aiConfig: () => Record<string, unknown>;
  /**
   * Runs inside the transaction that settles the attempt, so it must be
   * synchronous and write only through the same database connection.
   */
  onAttemptFinished: (event: AttemptFinishedEvent) => void;
  now: () => Date;
  newId: () => string;
  log: { info: LogEvent; warn: LogEvent };
};

const HOUR_MS = 3_600_000;
// Allowance beyond the maximum call length for provider teardown and late callbacks.
const LIVE_GRACE_SECONDS = 120;
const STATUS_RANK: Record<AttemptStatus, number> = {
  dialing: 0,
  unknown: 0,
  ringing: 1,
  in_progress: 2,
  completed: 3,
  no_answer: 3,
  busy: 3,
  failed: 3,
};
const isFinal = (status: AttemptStatus): status is FinalAttemptStatus =>
  (FINAL_ATTEMPT_STATUSES as readonly string[]).includes(status);

export function createCallManagement({
  repository,
  telephony,
  policy,
  maxConcurrentCalls,
  maxCallSeconds,
  aiConfig,
  onAttemptFinished,
  now,
  newId,
  log,
}: Dependencies) {
  // The window is an absolute bound the business may narrow; calling hours
  // apply on top of it when attempts are scheduled.
  function resolveWindow(schedule: CallRequest['schedule'], at: Date) {
    const notBefore = Math.max(
      at.getTime(),
      schedule?.notBefore ? Date.parse(schedule.notBefore) : 0,
    );
    const notAfter = schedule?.notAfter
      ? Date.parse(schedule.notAfter)
      : notBefore + DEFAULT_CALL_WINDOW_HOURS * HOUR_MS;
    if (notAfter <= notBefore)
      throw new CallManagementError(
        422,
        'schedule.notAfter must be later than schedule.notBefore and the current time.',
      );
    if (notAfter > at.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 24 * HOUR_MS)
      throw new CallManagementError(
        422,
        `schedule.notAfter must be within ${MAX_SCHEDULE_AHEAD_DAYS} days.`,
      );
    const firstCall = nextCallableTime(notBefore, policy);
    if (firstCall >= notAfter)
      throw new CallManagementError(
        422,
        `The schedule window contains no calling hours (${policy.startHour}:00–${policy.endHour}:00 IST).`,
      );
    return {
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(notAfter).toISOString(),
      nextAttemptAt: new Date(firstCall).toISOString(),
    };
  }

  function acceptCallRequest(request: CallRequest): {
    receipt: CallRequestReceipt;
    created: boolean;
  } {
    // Schema-parsed objects serialise in schema key order, so identical retries hash identically.
    const payloadHash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const existing = repository.requestByRequestId(request.requestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new CallManagementError(
          409,
          'requestId was already used with a different payload.',
        );
      return { receipt: receiptOf(existing), created: false };
    }
    const at = now();
    const window = resolveWindow(request.schedule, at);
    if (repository.hasOpenRequest(request.useCase, request.order.id))
      throw new CallManagementError(
        409,
        'An open call request already exists for this order.',
      );
    const timestamp = at.toISOString();
    const record: StoredCallRequest = {
      id: newId(),
      requestId: request.requestId,
      source: 'integration',
      useCase: request.useCase,
      orderRef: request.order.id,
      status: 'pending',
      maxAttempts: request.schedule?.maxAttempts ?? MAX_CALL_ATTEMPTS,
      ...window,
      payload: request,
      payloadHash,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    repository.insertRequest(record);
    log.info(
      { requestId: record.requestId, useCase: record.useCase },
      'Call request accepted',
    );
    return { receipt: receiptOf(record), created: true };
  }

  function finishAttempt(
    attempt: StoredAttempt,
    status: FinalAttemptStatus,
    providerCallId: string | null,
    failureReason: string | null,
  ): StoredAttempt {
    const at = now();
    const finished = repository.transaction(() => {
      const ended = repository.updateAttempt(attempt.id, {
        status,
        providerCallId: providerCallId ?? attempt.providerCallId,
        failureReason,
        answeredAt: attempt.answeredAt,
        endedAt: at.toISOString(),
      });
      const request = repository.requestById(attempt.callRequestId)!;
      const plan = planAfterAttempt(
        { status, number: attempt.attemptNumber, endedAt: at.getTime() },
        {
          maxAttempts: request.maxAttempts,
          notAfter: Date.parse(request.notAfter),
        },
        policy,
      );
      const settled = repository.updateRequest(request.id, {
        status: plan.status,
        nextAttemptAt: plan.nextAttemptAt
          ? new Date(plan.nextAttemptAt).toISOString()
          : null,
        updatedAt: at.toISOString(),
      });
      onAttemptFinished({ request: settled, attempt: ended });
      return { ended, settled };
    });
    log.info(
      {
        requestId: finished.settled.requestId,
        attemptId: attempt.id,
        status,
        requestStatus: finished.settled.status,
      },
      'Call attempt finished',
    );
    return finished.ended;
  }

  /** Applies a provider status report. Idempotent; never moves an attempt backwards. */
  function applyProviderEvent(
    attemptId: string,
    providerCallId: string,
    status: ProviderCallStatus,
  ): StoredAttempt {
    const attempt = repository.attemptById(attemptId);
    if (!attempt) throw new CallManagementError(404, 'Call attempt not found.');
    if (attempt.providerCallId && attempt.providerCallId !== providerCallId)
      throw new CallManagementError(403, 'Call identity mismatch.');
    if (isFinal(attempt.status)) return attempt;
    if (isFinal(status))
      return finishAttempt(attempt, status, providerCallId, null);
    if (
      STATUS_RANK[status] < STATUS_RANK[attempt.status] ||
      (status === attempt.status && attempt.providerCallId)
    )
      return attempt;
    return repository.updateAttempt(attempt.id, {
      status,
      providerCallId,
      failureReason: null,
      answeredAt:
        status === 'in_progress'
          ? (attempt.answeredAt ?? now().toISOString())
          : attempt.answeredAt,
      endedAt: null,
    });
  }

  async function startAttempt(request: StoredCallRequest) {
    const startedAt = now().toISOString();
    const attempt = repository.transaction(() => {
      const record: StoredAttempt = {
        id: newId(),
        callRequestId: request.id,
        attemptNumber: repository.attemptCount(request.id) + 1,
        status: 'dialing',
        provider: telephony.name,
        providerCallId: null,
        aiConfig: aiConfig(),
        outcome: null,
        outcomeSummary: null,
        callbackAt: null,
        failureReason: null,
        startedAt,
        answeredAt: null,
        endedAt: null,
      };
      repository.insertAttempt(record);
      repository.updateRequest(request.id, {
        status: 'in_progress',
        nextAttemptAt: null,
        updatedAt: startedAt,
      });
      return record;
    });
    log.info(
      {
        requestId: request.requestId,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
      },
      'Dialling call attempt',
    );
    try {
      const dialled = await telephony.dial({
        attemptId: attempt.id,
        phone: request.payload.customer.phone,
      });
      applyProviderEvent(attempt.id, dialled.providerCallId, dialled.status);
    } catch (error) {
      const failure =
        error instanceof TelephonyError
          ? error
          : new TelephonyError('Unexpected telephony failure.', true);
      const current = repository.attemptById(attempt.id)!;
      if (isFinal(current.status)) return;
      if (failure.uncertain) {
        // The provider may have placed the call: block redialling until reconciled.
        repository.updateAttempt(attempt.id, {
          ...current,
          status: 'unknown',
          failureReason: failure.message,
        });
        log.warn(
          { requestId: request.requestId, attemptId: attempt.id },
          'Dial outcome uncertain; attempt needs reconciliation',
        );
      } else {
        finishAttempt(current, 'failed', null, failure.message);
      }
    }
  }

  /** Expires closed windows, then dials due requests within calling hours and capacity. */
  async function runSchedule(): Promise<void> {
    const at = now();
    const timestamp = at.toISOString();
    for (const request of repository.overdueRequests(timestamp)) {
      repository.transaction(() => {
        const expired = repository.updateRequest(request.id, {
          status: 'expired',
          nextAttemptAt: null,
          updatedAt: timestamp,
        });
        onAttemptFinished({ request: expired, attempt: null });
      });
      log.info({ requestId: request.requestId }, 'Call request expired');
    }
    if (!isCallable(at.getTime(), policy)) return;
    const liveSince = new Date(
      at.getTime() - (maxCallSeconds + LIVE_GRACE_SECONDS) * 1000,
    ).toISOString();
    const capacity =
      maxConcurrentCalls - repository.liveAttemptCount(liveSince);
    if (capacity <= 0) return;
    await Promise.all(
      repository.dueRequests(timestamp, capacity).map(startAttempt),
    );
  }

  /** A dial interrupted by a restart may or may not have reached the provider. */
  function recoverAfterRestart() {
    for (const attempt of repository.attemptsWithStatus('dialing')) {
      repository.updateAttempt(attempt.id, {
        ...attempt,
        status: 'unknown',
        failureReason: 'Server restarted while dialling.',
      });
      log.warn(
        { attemptId: attempt.id },
        'Interrupted dial needs reconciliation',
      );
    }
  }

  async function reconcile(): Promise<void> {
    const staleBefore = new Date(
      now().getTime() - (maxCallSeconds + LIVE_GRACE_SECONDS) * 1000,
    ).toISOString();
    for (const attempt of repository.attemptsToReconcile(staleBefore)) {
      try {
        const status = await telephony.lookup(attempt.providerCallId!);
        applyProviderEvent(attempt.id, attempt.providerCallId!, status);
      } catch {
        log.warn(
          { attemptId: attempt.id },
          'Could not reconcile call attempt with provider',
        );
      }
    }
  }

  return {
    acceptCallRequest,
    applyProviderEvent,
    runSchedule,
    recoverAfterRestart,
    reconcile,
  };
}

export type CallManagement = ReturnType<typeof createCallManagement>;

const receiptOf = (record: StoredCallRequest): CallRequestReceipt => ({
  requestId: record.requestId,
  status: record.status,
  acceptedAt: record.createdAt,
});
