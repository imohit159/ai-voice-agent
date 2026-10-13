import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createCalls,
  CallError,
  ProviderError,
} from '../src/modules/calls/index.js';
import { Store } from '../src/platform/persistence/store.js';

const makeStore = () =>
  new Store(
    ':memory:',
    { storeName: 'Test Store', language: 'English' },
    '+919625532959',
  );
const request = () => ({
  orderId: 'DEMO-1001',
  mode: 'phone' as const,
  requestKey: randomUUID(),
});
function makeCalls(
  store: Store,
  overrides: Partial<Parameters<typeof createCalls>[0]> = {},
) {
  return createCalls({
    store,
    maxConcurrentCalls: 2,
    voiceReadiness: () => [],
    phoneReadiness: () => [],
    dialCall: async () => ({ Sid: 'provider-call', Status: 'queued' }),
    lookupCall: async () => ({ Sid: 'provider-call', Status: 'completed' }),
    log: { info() {}, warn() {} },
    ...overrides,
  });
}

test('in-flight dialing is idempotent, reserves capacity, and preserves an earlier terminal callback', async () => {
  const store = makeStore();
  let attempts = 0;
  let finishDial!: (result: { Sid: string; Status: string }) => void;
  const calls = makeCalls(store, {
    maxConcurrentCalls: 1,
    dialCall: async () => {
      attempts++;
      return new Promise((resolve) => {
        finishDial = resolve;
      });
    },
  });
  try {
    const body = request();
    const pending = calls.start(body);
    const replay = await calls.start(body);
    assert.equal(attempts, 1);
    assert.equal(replay.status, 'queued');
    await assert.rejects(
      calls.start({ ...request(), mode: 'browser' }),
      (error) => error instanceof CallError && error.statusCode === 409,
    );
    calls.receiveStatus(replay.id, 'provider-call', 'completed');
    finishDial({ Sid: 'provider-call', Status: 'queued' });
    const completed = await pending;
    assert.equal(completed.id, replay.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.outcome, null);
    assert.equal(store.order(body.orderId)?.outcome, null);
  } finally {
    store.close();
  }
});

test('a conflicting callback identity during dialing remains uncertain and blocks another dial', async () => {
  const store = makeStore();
  let finishDial!: (result: { Sid: string; Status: string }) => void;
  const calls = makeCalls(store, {
    dialCall: async () =>
      new Promise((resolve) => {
        finishDial = resolve;
      }),
  });
  try {
    const body = request();
    const pending = calls.start(body);
    const replay = await calls.start(body);
    calls.receiveStatus(replay.id, 'callback-call', 'answered');
    finishDial({ Sid: 'different-call', Status: 'queued' });
    const uncertain = await pending;
    assert.equal(uncertain.status, 'unknown');
    assert.equal(uncertain.providerSid, 'callback-call');
    await assert.rejects(
      calls.start(request()),
      (error) => error instanceof CallError && error.statusCode === 409,
    );
  } finally {
    store.close();
  }
});

test('failed and unrecognized reconciliation preserve uncertainty until a recognized terminal status', async () => {
  const store = makeStore();
  let state = 'unavailable';
  const calls = makeCalls(store, {
    dialCall: async () => ({ Sid: 'provider-call', Status: 'unrecognized' }),
    lookupCall: async () => {
      if (state === 'unavailable')
        throw new ProviderError('Unavailable', false);
      return { Sid: 'provider-call', Status: state };
    },
  });
  try {
    const body = request();
    const call = await calls.start(body);
    assert.equal(call.status, 'unknown');
    await assert.rejects(
      calls.reconcile(call.id),
      (error) => error instanceof CallError && error.statusCode === 502,
    );
    assert.equal((await calls.start(body)).status, 'unknown');
    state = 'unrecognized';
    await assert.rejects(
      calls.reconcile(call.id),
      (error) => error instanceof CallError && error.statusCode === 409,
    );
    await assert.rejects(
      calls.start(request()),
      (error) => error instanceof CallError && error.statusCode === 409,
    );
    state = 'completed';
    assert.equal((await calls.reconcile(call.id)).status, 'completed');
    assert.equal((await calls.start(request())).status, 'unknown');
  } finally {
    store.close();
  }
});

test('active phone attempts remain protected after more than 200 newer history entries', async () => {
  const store = makeStore();
  let attempts = 0;
  const calls = makeCalls(store, {
    dialCall: async () => {
      attempts++;
      return { Sid: 'provider-call', Status: 'queued' };
    },
  });
  try {
    await calls.start(request());
    for (let i = 0; i < 201; i++) {
      const history = store.create('DEMO-1001', 'browser', randomUUID());
      store.update(history.id, { status: 'completed' });
    }
    await assert.rejects(
      calls.start(request()),
      (error) =>
        error instanceof CallError &&
        error.statusCode === 409 &&
        /active or uncertain phone attempt/.test(error.message),
    );
    assert.equal(attempts, 1);
  } finally {
    store.close();
  }
});
