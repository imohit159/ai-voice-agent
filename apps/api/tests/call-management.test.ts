import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCallable,
  nextCallableTime,
  planAfterAttempt,
} from '../src/modules/call-management/policy.js';
import { TelephonyError } from '../src/modules/call-management/telephony.js';
import { START, callRequest, harness } from './support.js';

const policy = { startHour: 10, endHour: 19, retryDelaysMinutes: [30, 120] };
const at = (iso: string) => Date.parse(iso);

test('calling hours are applied in IST regardless of the server time zone', () => {
  // 08:30 IST → opens at 10:00 IST the same day.
  assert.equal(
    nextCallableTime(at('2026-10-16T03:00:00Z'), policy),
    at('2026-10-16T04:30:00Z'),
  );
  assert.equal(
    nextCallableTime(at('2026-10-16T06:00:00Z'), policy),
    at('2026-10-16T06:00:00Z'),
  );
  // 19:00 IST is closed → 10:00 IST next day; 23:00 IST crosses the UTC date too.
  assert.equal(
    nextCallableTime(at('2026-10-16T13:30:00Z'), policy),
    at('2026-10-17T04:30:00Z'),
  );
  assert.equal(
    nextCallableTime(at('2026-10-16T17:30:00Z'), policy),
    at('2026-10-17T04:30:00Z'),
  );
  assert.equal(isCallable(at('2026-10-16T13:29:59Z'), policy), true);
  assert.equal(isCallable(at('2026-10-16T04:29:59Z'), policy), false);
});

test('the retry plan follows the backoff, the attempt limit and the window', () => {
  const window = { maxAttempts: 3, notAfter: at('2026-10-17T06:00:00Z') };
  const ended = at('2026-10-16T06:00:00Z');
  assert.deepEqual(
    planAfterAttempt(
      { status: 'completed', number: 1, endedAt: ended },
      window,
      policy,
    ),
    { status: 'completed', nextAttemptAt: null },
  );
  assert.deepEqual(
    planAfterAttempt(
      { status: 'no_answer', number: 1, endedAt: ended },
      window,
      policy,
    ),
    { status: 'pending', nextAttemptAt: at('2026-10-16T06:30:00Z') },
  );
  assert.deepEqual(
    planAfterAttempt(
      { status: 'busy', number: 2, endedAt: ended },
      window,
      policy,
    ),
    { status: 'pending', nextAttemptAt: at('2026-10-16T08:00:00Z') },
  );
  assert.deepEqual(
    planAfterAttempt(
      { status: 'failed', number: 3, endedAt: ended },
      window,
      policy,
    ),
    { status: 'exhausted', nextAttemptAt: null },
  );
  // 18:45 IST + 30 minutes is after hours → next morning, still inside the window.
  assert.deepEqual(
    planAfterAttempt(
      { status: 'no_answer', number: 1, endedAt: at('2026-10-16T13:15:00Z') },
      window,
      policy,
    ),
    { status: 'pending', nextAttemptAt: at('2026-10-17T04:30:00Z') },
  );
  assert.deepEqual(
    planAfterAttempt(
      { status: 'no_answer', number: 1, endedAt: ended },
      { maxAttempts: 3, notAfter: at('2026-10-16T06:20:00Z') },
      policy,
    ),
    { status: 'expired', nextAttemptAt: null },
  );
});

test('an answered call completes the request and queues one answered result', async () => {
  const h = harness();
  h.calls.acceptCallRequest(callRequest());
  await h.calls.runSchedule();
  assert.equal(h.provider.dialled.length, 1);
  const { attemptId, phone, providerCallId } = h.provider.dialled[0]!;
  assert.equal(phone, '+919625532959');
  assert.equal(h.repository.attemptById(attemptId)!.status, 'ringing');
  assert.deepEqual(h.repository.attemptById(attemptId)!.aiConfig, {
    voiceProvider: 'gemini',
    model: 'test-model',
  });
  assert.equal(
    h.repository.requestByRequestId('req-1001')!.status,
    'in_progress',
  );

  h.advance(0.5);
  h.calls.applyProviderEvent(attemptId, providerCallId, 'in_progress');
  h.advance(2);
  h.calls.applyProviderEvent(attemptId, providerCallId, 'completed');
  // Duplicate and out-of-order reports change nothing.
  h.calls.applyProviderEvent(attemptId, providerCallId, 'completed');
  h.calls.applyProviderEvent(attemptId, providerCallId, 'ringing');

  assert.equal(
    h.repository.requestByRequestId('req-1001')!.status,
    'completed',
  );
  const [delivery, ...rest] = h.outbox();
  assert.equal(rest.length, 0);
  assert.equal(delivery!.payload.requestStatus, 'completed');
  assert.equal(delivery!.payload.attempt!.result, 'answered');
  assert.equal(delivery!.payload.attempt!.durationSeconds, 120);
  assert.equal(delivery!.payload.outcome, null);
});

test('unanswered calls retry with backoff, then exhaust with a result per attempt', async () => {
  const h = harness();
  h.calls.acceptCallRequest(callRequest());
  for (const [index, waitMinutes] of [0, 30, 120].entries()) {
    h.advance(waitMinutes - 1);
    await h.calls.runSchedule();
    assert.equal(h.provider.dialled.length, index, 'not before backoff');
    h.advance(1);
    await h.calls.runSchedule();
    const call = h.provider.dialled[index]!;
    h.calls.applyProviderEvent(
      call.attemptId,
      call.providerCallId,
      'no_answer',
    );
  }
  await h.calls.runSchedule();
  assert.equal(h.provider.dialled.length, 3);
  assert.equal(
    h.repository.requestByRequestId('req-1001')!.status,
    'exhausted',
  );
  assert.deepEqual(
    h.outbox().map((d) => [d.payload.attempt!.number, d.payload.requestStatus]),
    [
      [1, 'pending'],
      [2, 'pending'],
      [3, 'exhausted'],
    ],
  );
});

test('the scheduler respects capacity and calling hours', async () => {
  const h = harness({ maxConcurrentCalls: 2 });
  for (const n of [1, 2, 3])
    h.calls.acceptCallRequest(
      callRequest({
        requestId: `req-${n}`,
        order: { ...callRequest().order, id: `ORD-${n}` },
      }),
    );
  await h.calls.runSchedule();
  assert.equal(h.provider.dialled.length, 2);
  await h.calls.runSchedule();
  assert.equal(h.provider.dialled.length, 2, 'no slot until a call ends');
  const first = h.provider.dialled[0]!;
  h.calls.applyProviderEvent(
    first.attemptId,
    first.providerCallId,
    'completed',
  );
  await h.calls.runSchedule();
  assert.equal(h.provider.dialled.length, 3);

  const late = harness();
  late.clock.now = new Date('2026-10-16T14:00:00Z'); // 19:30 IST
  late.calls.acceptCallRequest(callRequest());
  await late.calls.runSchedule();
  assert.equal(late.provider.dialled.length, 0);
  assert.equal(
    late.repository.requestByRequestId('req-1001')!.nextAttemptAt,
    '2026-10-17T04:30:00.000Z',
  );
});

test('an uncertain dial blocks redialling and is never reported as a result', async () => {
  const h = harness();
  h.provider.queued.push({ error: new TelephonyError('Timed out.', true) });
  h.calls.acceptCallRequest(callRequest());
  await h.calls.runSchedule();
  const [attempt] = h.repository.attemptsWithStatus('unknown');
  assert.ok(attempt);
  assert.equal(attempt.failureReason, 'Timed out.');
  h.advance(600);
  await h.calls.runSchedule();
  await h.calls.reconcile();
  assert.equal(h.repository.attemptsWithStatus('unknown').length, 1);
  assert.equal(h.outbox().length, 0);
  assert.equal(
    h.repository.requestByRequestId('req-1001')!.status,
    'in_progress',
  );
});

test('a definite dial failure is finished and retried', async () => {
  const h = harness();
  h.provider.queued.push({ error: new TelephonyError('Rejected.', false) });
  h.calls.acceptCallRequest(callRequest());
  await h.calls.runSchedule();
  const [delivery] = h.outbox();
  assert.equal(delivery!.payload.attempt!.result, 'failed');
  assert.equal(delivery!.payload.attempt!.failureReason, 'Rejected.');
  assert.equal(delivery!.payload.requestStatus, 'pending');
});

test('provider events for another call are rejected', async () => {
  const h = harness();
  h.calls.acceptCallRequest(callRequest());
  await h.calls.runSchedule();
  const { attemptId } = h.provider.dialled[0]!;
  assert.throws(
    () => h.calls.applyProviderEvent(attemptId, 'someone-else', 'completed'),
    { statusCode: 403 },
  );
  assert.throws(
    () => h.calls.applyProviderEvent(crypto.randomUUID(), 'x', 'completed'),
    { statusCode: 404 },
  );
});

test('restart recovery and reconciliation settle interrupted calls', async () => {
  const h = harness();
  h.calls.acceptCallRequest(callRequest());
  await h.calls.runSchedule();
  const { attemptId, providerCallId } = h.provider.dialled[0]!;
  // Simulate a crash between creating the attempt and the dial response.
  h.repository.updateAttempt(attemptId, {
    ...h.repository.attemptById(attemptId)!,
    status: 'dialing',
  });
  h.calls.recoverAfterRestart();
  assert.equal(h.repository.attemptById(attemptId)!.status, 'unknown');

  h.provider.states.set(providerCallId, 'busy');
  await h.calls.reconcile();
  assert.equal(h.repository.attemptById(attemptId)!.status, 'busy');
  assert.equal(h.outbox()[0]!.payload.attempt!.result, 'busy');
});

test('an overdue request expires with a result that has no attempt', async () => {
  const h = harness();
  h.calls.acceptCallRequest(
    callRequest({ schedule: { notAfter: '2026-10-16T07:00:00Z' } }),
  );
  h.advance(61);
  await h.calls.runSchedule();
  assert.equal(h.provider.dialled.length, 0);
  assert.equal(h.repository.requestByRequestId('req-1001')!.status, 'expired');
  const [delivery] = h.outbox();
  assert.equal(delivery!.payload.attempt, null);
  assert.equal(delivery!.payload.requestStatus, 'expired');
});

test('a window without calling hours is rejected at intake', () => {
  const h = harness();
  assert.throws(
    () =>
      h.calls.acceptCallRequest(
        callRequest({
          schedule: {
            notBefore: '2026-10-16T20:00:00+05:30',
            notAfter: '2026-10-16T23:00:00+05:30',
          },
        }),
      ),
    { statusCode: 422 },
  );
  assert.equal(START.toISOString(), h.clock.now.toISOString());
});
