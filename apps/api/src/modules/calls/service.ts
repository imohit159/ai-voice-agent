import type { Call, Settings } from '@orderline/contracts';
import type { Store } from '../../platform/persistence/store.js';

// Legacy browser practice. Phone calls run through the call-management module;
// this module is replaced by Pipecat-backed practice sessions.

export class CallError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type CallRequest = { orderId: string; mode: 'browser'; requestKey: string };
type LogEvent = (fields: Record<string, unknown>, message: string) => void;
type Dependencies = {
  store: Store;
  maxConcurrentCalls: number;
  voiceReadiness: (provider: Settings['voiceProvider']) => string[];
  log: { info: LogEvent };
};

export function createCalls({
  store,
  maxConcurrentCalls,
  voiceReadiness,
  log,
}: Dependencies) {
  function start(body: CallRequest): Call {
    const existing = store.byKey(body.requestKey);
    if (existing) {
      if (existing.orderId !== body.orderId || existing.mode !== body.mode)
        throw new CallError(
          409,
          'Request key already used for a different call.',
        );
      return existing;
    }
    const order = store.order(body.orderId);
    if (!order) throw new CallError(404, 'Order not found.');
    const missingVoice = voiceReadiness(store.settings().voiceProvider);
    if (missingVoice.length)
      throw new CallError(
        409,
        `Configure ${missingVoice.join(', ')} on the server first.`,
      );
    if (store.activeCount() >= maxConcurrentCalls)
      throw new CallError(
        409,
        'The configured call limit has been reached. Finish an active practice session first.',
      );
    const call = store.create(order.id, body.mode, body.requestKey);
    log.info({ callId: call.id, mode: call.mode }, 'Call attempt created');
    return call;
  }

  return { start };
}
