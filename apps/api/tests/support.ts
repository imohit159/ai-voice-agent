import { randomUUID } from 'node:crypto';
import type { CallRequest } from '@orderline/contracts/integration';
import { openDatabase } from '../src/platform/persistence/database.js';
import { createCallManagementRepository } from '../src/modules/call-management/repository.js';
import {
  createCallManagement,
  type AttemptFinishedEvent,
} from '../src/modules/call-management/service.js';
import {
  TelephonyError,
  type ProviderCallStatus,
  type Telephony,
} from '../src/modules/call-management/telephony.js';
import { createResultDeliveryRepository } from '../src/modules/integrations/repository.js';
import {
  createResults,
  type WebhookResponse,
} from '../src/modules/integrations/service.js';

export const quietLog = { info: () => {}, warn: () => {} };

/** 06:00 UTC is 11:30 IST: inside default calling hours. */
export const START = new Date('2026-10-16T06:00:00.000Z');

export function callRequest(overrides: Partial<CallRequest> = {}): CallRequest {
  return {
    requestId: 'req-1001',
    useCase: 'order_confirmation',
    customer: { reference: 'cust-1', name: 'Asha', phone: '+919625532959' },
    order: {
      id: 'ORD-1001',
      items: [{ name: 'Wireless headphones', quantity: 1 }],
      total: { amountMinor: 149900, currency: 'INR' },
      paymentMethod: 'cash_on_delivery',
      deliveryAddress: 'Indiranagar, Bengaluru 560038',
    },
    ...overrides,
  };
}

type DialBehaviour = { status: ProviderCallStatus } | { error: TelephonyError };

/** Fake provider: dials succeed with `ringing` unless a behaviour is queued. */
export function fakeTelephony() {
  const dialled: {
    attemptId: string;
    phone: string;
    providerCallId: string;
  }[] = [];
  const queued: DialBehaviour[] = [];
  const states = new Map<string, ProviderCallStatus>();
  const telephony: Telephony = {
    name: 'fake',
    async dial({ attemptId, phone }) {
      const behaviour = queued.shift() ?? { status: 'ringing' };
      if ('error' in behaviour) throw behaviour.error;
      const providerCallId = `fake-${dialled.length + 1}`;
      dialled.push({ attemptId, phone, providerCallId });
      states.set(providerCallId, behaviour.status);
      return { providerCallId, status: behaviour.status };
    },
    async lookup({ providerCallId }) {
      const status = states.get(providerCallId);
      if (!status) throw new TelephonyError('Unknown call.', false);
      return { status };
    },
  };
  return { telephony, dialled, queued, states };
}

export function harness(
  options: {
    maxConcurrentCalls?: number;
    send?: ((body: string) => Promise<WebhookResponse>) | null;
  } = {},
) {
  const db = openDatabase(':memory:');
  const clock = { now: new Date(START) };
  const advance = (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
  };
  const provider = fakeTelephony();
  const events: AttemptFinishedEvent[] = [];
  const deliveries = createResultDeliveryRepository(db);
  const results = createResults({
    deliveries,
    send:
      options.send === undefined ? async () => ({ ok: true }) : options.send,
    retryDelaysSeconds: [60, 300],
    now: () => clock.now,
    newId: randomUUID,
    log: quietLog,
  });
  const repository = createCallManagementRepository(db);
  const calls = createCallManagement({
    repository,
    telephony: provider.telephony,
    policy: { startHour: 10, endHour: 19, retryDelaysMinutes: [30, 120] },
    maxConcurrentCalls: options.maxConcurrentCalls ?? 2,
    maxCallSeconds: 180,
    aiConfig: () => ({ voiceProvider: 'gemini', model: 'test-model' }),
    onAttemptFinished: (event) => {
      events.push(event);
      results.record(event);
    },
    now: () => clock.now,
    newId: randomUUID,
    log: quietLog,
  });
  const outbox = () =>
    (
      db
        .prepare('SELECT event_id FROM result_deliveries ORDER BY rowid')
        .all() as { event_id: string }[]
    ).map((row) => deliveries.byEventId(row.event_id)!);
  return {
    db,
    clock,
    advance,
    provider,
    events,
    results,
    repository,
    calls,
    outbox,
  };
}
