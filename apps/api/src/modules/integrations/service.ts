import {
  callResultSchema,
  type AttemptResult,
  type CallResult,
} from '@orderline/contracts/integration';
import type {
  AttemptFinishedEvent,
  StoredAttempt,
} from '../call-management/module.js';
import type { ResultDeliveryRepository } from './repository.js';

export class ResultDeliveryError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type WebhookResponse = { ok: true } | { ok: false; error: string };

type LogEvent = (fields: Record<string, unknown>, message: string) => void;
type Dependencies = {
  deliveries: ResultDeliveryRepository;
  /** null when no result destination is configured; results then wait in the outbox. */
  send: ((body: string) => Promise<WebhookResponse>) | null;
  /** Seconds to wait after each failed delivery; its length bounds the retries. */
  retryDelaysSeconds: readonly number[];
  now: () => Date;
  newId: () => string;
  log: { info: LogEvent; warn: LogEvent };
};

const BATCH_SIZE = 10;

const resultOf = (status: StoredAttempt['status']): AttemptResult => {
  switch (status) {
    case 'completed':
      return 'answered';
    case 'no_answer':
    case 'busy':
    case 'failed':
      return status;
    default:
      throw new Error(`Attempt is not finished: ${status}`);
  }
};

function buildResult(
  { request, attempt }: AttemptFinishedEvent,
  eventId: string,
  occurredAt: string,
): CallResult {
  const answeredAt = attempt?.answeredAt ?? null;
  return callResultSchema.parse({
    eventId,
    occurredAt,
    requestId: request.requestId,
    requestStatus: request.status,
    useCase: request.useCase,
    attempt: attempt && {
      id: attempt.id,
      number: attempt.attemptNumber,
      result: resultOf(attempt.status),
      startedAt: attempt.startedAt,
      answeredAt,
      endedAt: attempt.endedAt,
      durationSeconds: answeredAt
        ? Math.max(
            0,
            Math.round(
              (Date.parse(attempt.endedAt!) - Date.parse(answeredAt)) / 1000,
            ),
          )
        : 0,
      failureReason: attempt.failureReason,
    },
    outcome: attempt?.outcome
      ? {
          code: attempt.outcome,
          summary: attempt.outcomeSummary ?? '',
          callbackAt: attempt.callbackAt,
        }
      : null,
    ...(request.payload.metadata && { metadata: request.payload.metadata }),
  });
}

export function createResults({
  deliveries,
  send,
  retryDelaysSeconds,
  now,
  newId,
  log,
}: Dependencies) {
  /** Writes the result to the outbox; runs inside the attempt's settling transaction. */
  function record(event: AttemptFinishedEvent) {
    if (event.request.source !== 'integration') return;
    const createdAt = now().toISOString();
    const eventId = newId();
    deliveries.insert({
      eventId,
      callRequestId: event.request.id,
      attemptId: event.attempt?.id ?? null,
      payload: buildResult(event, eventId, createdAt),
      createdAt,
    });
  }

  /** At-least-once delivery: receivers deduplicate by eventId. */
  async function deliverDue(): Promise<void> {
    if (!send) return;
    for (const delivery of deliveries.due(now().toISOString(), BATCH_SIZE)) {
      const response = await send(JSON.stringify(delivery.payload));
      const at = now();
      const fields = {
        eventId: delivery.eventId,
        requestId: delivery.payload.requestId,
      };
      if (response.ok) {
        deliveries.recordAttempt(delivery.eventId, {
          status: 'delivered',
          nextAttemptAt: delivery.nextAttemptAt,
          lastError: null,
          deliveredAt: at.toISOString(),
        });
        log.info(fields, 'Call result delivered');
        continue;
      }
      const delay = retryDelaysSeconds[delivery.deliveryAttempts];
      deliveries.recordAttempt(delivery.eventId, {
        status: delay === undefined ? 'failed' : 'pending',
        nextAttemptAt: new Date(
          at.getTime() + (delay ?? 0) * 1000,
        ).toISOString(),
        lastError: response.error,
        deliveredAt: null,
      });
      log.warn(
        { ...fields, error: response.error, exhausted: delay === undefined },
        'Call result delivery failed',
      );
    }
  }

  /**
   * Manual recovery after automatic retries gave up: one more immediate attempt.
   * If it fails again the delivery returns to failed for another decision.
   */
  function retryFailed(eventId: string) {
    if (!deliveries.requeueFailed(eventId, now().toISOString()))
      throw new ResultDeliveryError(
        409,
        'Only failed deliveries can be retried.',
      );
  }

  return { record, deliverDue, retryFailed, list: deliveries.summaries };
}
