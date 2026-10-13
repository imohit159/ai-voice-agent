import { providerStatus, type Call, type Settings } from '@orderline/contracts';
import type { Store } from '../../platform/persistence/store.js';

export class CallError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public uncertain: boolean,
  ) {
    super(message);
  }
}

type CallRequest = { orderId: string; mode: Call['mode']; requestKey: string };
type ProviderCall = { Sid: string; Status: string };
type LogEvent = (fields: Record<string, unknown>, message: string) => void;
type Dependencies = {
  store: Store;
  maxConcurrentCalls: number;
  voiceReadiness: (provider: Settings['voiceProvider']) => string[];
  phoneReadiness: (provider: Settings['voiceProvider']) => string[];
  dialCall: (call: Call, phone: string) => Promise<ProviderCall>;
  lookupCall: (sid: string) => Promise<ProviderCall>;
  log: { info: LogEvent; warn: LogEvent };
};

export function createCalls({
  store,
  maxConcurrentCalls,
  voiceReadiness,
  phoneReadiness,
  dialCall,
  lookupCall,
  log,
}: Dependencies) {
  async function start(body: CallRequest): Promise<Call> {
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
    if (body.mode === 'phone') {
      const missingPhone = phoneReadiness(store.settings().voiceProvider);
      if (missingPhone.length)
        throw new CallError(
          409,
          `Finish Exotel setup: ${missingPhone.join(', ')}.`,
        );
      if (order.outcome === 'confirmed' || order.outcome === 'declined')
        throw new CallError(
          409,
          'This test order already has a decision. Reset the demo to test again.',
        );
      if (store.hasActivePhoneCall(order.id))
        throw new CallError(
          409,
          'This order has an active or uncertain phone attempt. Reconcile before retrying.',
        );
    }
    if (store.activeCount() >= maxConcurrentCalls)
      throw new CallError(
        409,
        'The configured call limit has been reached. Finish or reconcile an active attempt first.',
      );
    const call = store.create(order.id, body.mode, body.requestKey);
    log.info({ callId: call.id, mode: call.mode }, 'Call attempt created');
    if (call.mode === 'browser') return call;
    try {
      const result = await dialCall(call, order.phone);
      const current = store.call(call.id)!;
      if (current.providerSid && current.providerSid !== result.Sid)
        throw new ProviderError(
          'Exotel returned a different call identifier. Reconcile this attempt.',
          true,
        );
      store.update(call.id, {
        providerSid: result.Sid,
        status: providerStatus(result.Status) ?? 'unknown',
      });
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              'Unexpected calling-provider failure. Reconcile before retrying.',
              true,
            );
      store.update(call.id, {
        status: providerError.uncertain ? 'unknown' : 'failed',
        error: providerError.message,
      });
      log.warn(
        { callId: call.id, uncertain: providerError.uncertain },
        'Call dial did not complete',
      );
    }
    return store.call(call.id)!;
  }

  async function reconcile(id: string): Promise<Call> {
    const call = store.call(id);
    if (!call || call.mode !== 'phone')
      throw new CallError(404, 'Phone call not found.');
    if (!call.providerSid)
      throw new CallError(
        409,
        'No provider call ID was received. Match this attempt in Exotel logs; wait for its callback before retrying.',
      );
    try {
      const result = await lookupCall(call.providerSid);
      const status = providerStatus(result.Status);
      if (!status) throw new CallError(409, 'Exotel status is not recognized.');
      return store.update(id, { status, error: null });
    } catch (error) {
      if (error instanceof CallError) throw error;
      throw new CallError(
        502,
        'Could not reconcile with Exotel. The attempt remains blocked against duplicate dialing.',
      );
    }
  }

  function receiveStatus(
    id: string,
    providerSid: string,
    providerState: string,
  ): Call {
    const call = store.call(id);
    if (!call || call.mode !== 'phone')
      throw new CallError(404, 'Call not found.');
    if (call.providerSid && call.providerSid !== providerSid)
      throw new CallError(403, 'Call identity mismatch.');
    const status = providerStatus(providerState);
    if (!status) throw new CallError(400, 'Unknown call status.');
    const updated = store.update(id, { providerSid, status, error: null });
    log.info({ callId: id, status }, 'Exotel status received');
    return updated;
  }

  return { start, reconcile, receiveStatus };
}
