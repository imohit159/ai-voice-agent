import { createHash } from 'node:crypto';
import {
  DEFAULT_CALL_WINDOW_HOURS,
  MAX_CALL_ATTEMPTS,
  MAX_SCHEDULE_AHEAD_DAYS,
  type CallRequest,
  type CallRequestReceipt,
} from '@orderline/contracts/integration';
import type { CallRequestRepository, StoredCallRequest } from './repository.js';

export class IntegrationError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type LogEvent = (fields: Record<string, unknown>, message: string) => void;
type Dependencies = {
  requests: CallRequestRepository;
  now: () => Date;
  newId: () => string;
  log: { info: LogEvent };
};

const HOUR_MS = 3_600_000;

const receiptOf = (record: StoredCallRequest): CallRequestReceipt => ({
  requestId: record.requestId,
  status: record.status,
  acceptedAt: record.createdAt,
});

export function createIntegrations({
  requests,
  now,
  newId,
  log,
}: Dependencies) {
  // The window is an absolute bound the business may narrow; the daily calling
  // hours are applied on top of it when attempts are scheduled.
  function resolveWindow(schedule: CallRequest['schedule'], at: Date) {
    const notBefore = Math.max(
      at.getTime(),
      schedule?.notBefore ? Date.parse(schedule.notBefore) : 0,
    );
    const notAfter = schedule?.notAfter
      ? Date.parse(schedule.notAfter)
      : notBefore + DEFAULT_CALL_WINDOW_HOURS * HOUR_MS;
    if (notAfter <= notBefore)
      throw new IntegrationError(
        422,
        'schedule.notAfter must be later than schedule.notBefore and the current time.',
      );
    if (notAfter > at.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 24 * HOUR_MS)
      throw new IntegrationError(
        422,
        `schedule.notAfter must be within ${MAX_SCHEDULE_AHEAD_DAYS} days.`,
      );
    return {
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(notAfter).toISOString(),
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
    const existing = requests.findByRequestId(request.requestId);
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new IntegrationError(
          409,
          'requestId was already used with a different payload.',
        );
      return { receipt: receiptOf(existing), created: false };
    }
    const at = now();
    const window = resolveWindow(request.schedule, at);
    if (requests.hasOpenRequest(request.useCase, request.order.id))
      throw new IntegrationError(
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
    requests.insert(record);
    log.info(
      { requestId: record.requestId, useCase: record.useCase },
      'Call request accepted',
    );
    return { receipt: receiptOf(record), created: true };
  }

  return { acceptCallRequest };
}
