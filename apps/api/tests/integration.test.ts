import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import {
  SIGNATURE_HEADER,
  callResultSchema,
} from '@orderline/contracts/integration';
import { openDatabase } from '../src/platform/persistence/database.js';
import { migrations } from '../src/platform/persistence/migrations.js';
import {
  signBody,
  verifySignature,
} from '../src/platform/security/signatures.js';
import { registerHttpSecurity } from '../src/platform/http/security.js';
import { registerIntegrationRoutes } from '../src/modules/integrations/routes.js';
import { postSignedJson } from '../src/modules/integrations/infrastructure/webhook.js';
import type { WebhookResponse } from '../src/modules/integrations/service.js';
import { START, callRequest, harness } from './support.js';

const secret = 'integration-secret-that-is-at-least-32-chars';
const url = '/integrations/v1/call-requests';

async function intakeApp() {
  const h = harness();
  const app = Fastify({ logger: false });
  registerHttpSecurity(app, {
    origin: 'http://localhost:3000',
    isLoggedIn: () => false,
  });
  await registerIntegrationRoutes(app, h.calls, secret);
  const send = (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signature ?? signBody(secret, body),
      },
      payload: body,
    });
  };
  return { ...h, app, send };
}

test('signatures reject tampered bodies, stale timestamps and malformed headers', () => {
  const body = '{"a":1}';
  const at = 1_760_000_000;
  const header = signBody(secret, body, at);
  assert.equal(verifySignature(secret, header, body, 300, at + 299), true);
  assert.equal(verifySignature(secret, header, '{"a":2}', 300, at), false);
  assert.equal(verifySignature(secret, header, body, 300, at + 301), false);
  assert.equal(verifySignature(`${secret}x`, header, body, 300, at), false);
  assert.equal(verifySignature(secret, undefined, body, 300, at), false);
  assert.equal(verifySignature(secret, 't=abc,v1=00', body, 300, at), false);
  assert.equal(
    verifySignature(secret, `v1=${'0'.repeat(64)}`, body, 300, at),
    false,
  );
});

test('a signed call request is accepted once and replays return the same receipt', async () => {
  const { app, send, repository } = await intakeApp();
  const first = await send(callRequest());
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json(), {
    requestId: 'req-1001',
    status: 'pending',
    acceptedAt: START.toISOString(),
  });
  const replay = await send(callRequest());
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());

  const stored = repository.requestByRequestId('req-1001')!;
  assert.equal(stored.maxAttempts, 3);
  assert.equal(stored.notBefore, START.toISOString());
  assert.equal(stored.nextAttemptAt, START.toISOString());
  assert.equal(stored.notAfter, '2026-10-17T06:00:00.000Z');
  assert.equal(stored.payload.customer.phone, '+919625532959');
  await app.close();
});

test('conflicting reuse of a request ID or a second open request for the order is rejected', async () => {
  const { app, send } = await intakeApp();
  assert.equal((await send(callRequest())).statusCode, 202);
  const changed = callRequest();
  changed.order.deliveryAddress = 'Koramangala, Bengaluru 560034';
  const reused = await send(changed);
  assert.equal(reused.statusCode, 409);
  assert.match(reused.json().error, /different payload/);
  const second = await send(callRequest({ requestId: 'req-1002' }));
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /open call request/);
  await app.close();
});

test('unsigned, invalid and out-of-window requests are rejected without being stored', async () => {
  const { app, db, send } = await intakeApp();
  assert.equal(
    (await send(callRequest(), `t=1,v1=${'0'.repeat(64)}`)).statusCode,
    401,
  );
  const invalid = await send({
    ...callRequest(),
    customer: { reference: 'c', name: 'A', phone: '9625532959' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json().fields, ['customer.phone']);
  assert.equal(
    (await send({ ...callRequest(), discount: 50 })).statusCode,
    400,
  );
  for (const schedule of [
    { notAfter: '2026-10-16T05:00:00Z' },
    { notAfter: '2026-10-24T06:00:01Z' },
    { notBefore: '2026-10-16T10:00:00Z', notAfter: '2026-10-16T09:00:00Z' },
  ]) {
    const response = await send(callRequest({ schedule }));
    assert.equal(response.statusCode, 422, JSON.stringify(schedule));
  }
  const malformed = await app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signBody(secret, '{bad'),
    },
    payload: '{bad',
  });
  assert.equal(malformed.statusCode, 400);
  const count = db.prepare('SELECT count(*) AS n FROM call_requests').get() as {
    n: number;
  };
  assert.equal(count.n, 0);
  await app.close();
});

test('a narrowed window and attempt limit are stored as requested', async () => {
  const { app, send, repository } = await intakeApp();
  const response = await send(
    callRequest({
      schedule: {
        notBefore: '2026-10-16T12:00:00+05:30',
        notAfter: '2026-10-16T18:00:00+05:30',
        maxAttempts: 2,
      },
    }),
  );
  assert.equal(response.statusCode, 202);
  const stored = repository.requestByRequestId('req-1001')!;
  assert.equal(stored.notBefore, '2026-10-16T06:30:00.000Z');
  assert.equal(stored.notAfter, '2026-10-16T12:30:00.000Z');
  assert.equal(stored.maxAttempts, 2);
  await app.close();
});

test('result delivery retries with backoff, then stops for manual recovery', async () => {
  const responses: WebhookResponse[] = [
    { ok: false, error: 'HTTP 500' },
    { ok: false, error: 'Timed out' },
    { ok: false, error: 'HTTP 503' },
  ];
  const sent: string[] = [];
  const h = harness({
    send: async (body) => {
      sent.push(body);
      return responses.shift() ?? { ok: true };
    },
  });
  h.calls.acceptCallRequest(callRequest({ metadata: { campaign: 'cod' } }));
  await h.calls.runSchedule();
  const call = h.provider.dialled[0]!;
  h.calls.applyProviderEvent({
    attemptId: call.attemptId,
    providerCallId: call.providerCallId,
    status: 'completed',
  });

  await h.results.deliverDue();
  assert.equal(h.outbox()[0]!.status, 'pending');
  await h.results.deliverDue();
  assert.equal(sent.length, 1, 'waits for the retry delay');
  h.advance(1);
  await h.results.deliverDue();
  h.advance(5);
  await h.results.deliverDue();
  const [delivery] = h.outbox();
  assert.equal(delivery!.status, 'failed');
  assert.equal(delivery!.deliveryAttempts, 3);
  assert.equal(delivery!.lastError, 'HTTP 503');
  assert.equal(sent.length, 3);
  const body = callResultSchema.parse(JSON.parse(sent[0]!));
  assert.deepEqual(body.metadata, { campaign: 'cod' });
  assert.ok(
    sent.every((s) => s === sent[0]),
    'retries resend the same event',
  );
});

test('results are delivered and wait in the outbox while no destination is set', async () => {
  const unconfigured = harness({ send: null });
  unconfigured.calls.acceptCallRequest(callRequest());
  await unconfigured.calls.runSchedule();
  const call = unconfigured.provider.dialled[0]!;
  unconfigured.calls.applyProviderEvent({
    attemptId: call.attemptId,
    providerCallId: call.providerCallId,
    status: 'busy',
  });
  await unconfigured.results.deliverDue();
  assert.equal(unconfigured.outbox()[0]!.status, 'pending');

  const configured = harness();
  configured.calls.acceptCallRequest(callRequest());
  await configured.calls.runSchedule();
  const answered = configured.provider.dialled[0]!;
  configured.calls.applyProviderEvent({
    attemptId: answered.attemptId,
    providerCallId: answered.providerCallId,
    status: 'completed',
  });
  await configured.results.deliverDue();
  const [delivered] = configured.outbox();
  assert.equal(delivered!.status, 'delivered');
  assert.equal(delivered!.deliveredAt, START.toISOString());
});

test('webhook posts are signed and redirects are refused', async () => {
  const received: { body: string; signature?: string }[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({
      body,
      signature: request.headers[SIGNATURE_HEADER] as string,
    });
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/results' }).end();
      return;
    }
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(
      await postSignedJson(`${base}/results`, secret, '{"x":1}'),
      { ok: true },
    );
    assert.equal(
      verifySignature(secret, received[0]!.signature, received[0]!.body, 300),
      true,
    );
    assert.deepEqual(
      await postSignedJson(`${base}/redirect`, secret, '{"x":1}'),
      { ok: false, error: 'HTTP 302' },
    );
    assert.equal(received.length, 2, 'the redirect was not followed');
  } finally {
    server.close();
  }
});

test('the database rejects a second open request or live attempt for the same order', () => {
  const db = openDatabase(':memory:');
  const insert = (id: string, status: string) =>
    db
      .prepare(
        `INSERT INTO call_requests (id, request_id, source, use_case, order_ref, status,
          max_attempts, not_before, not_after, payload, payload_hash, created_at, updated_at)
          VALUES (?,?,'integration','order_confirmation','ORD-1',?,3,
          '2026-10-16T06:00:00Z','2026-10-17T06:00:00Z','{}','h','t','t')`,
      )
      .run(id, id, status);
  insert('a', 'completed');
  insert('b', 'pending');
  assert.throws(() => insert('c', 'in_progress'), /UNIQUE constraint failed/);
  assert.throws(() => insert('d', 'unknown'), /CHECK constraint failed/);

  const attempt = (id: string, number: number, status: string) =>
    db
      .prepare(
        `INSERT INTO call_attempts (id, call_request_id, attempt_number, status, provider,
          ai_config, started_at) VALUES (?, 'b', ?, ?, 'fake', '{}', 't')`,
      )
      .run(id, number, status);
  attempt('x', 1, 'no_answer');
  attempt('y', 2, 'ringing');
  assert.throws(() => attempt('z', 3, 'dialing'), /UNIQUE constraint failed/);
  assert.throws(() => attempt('w', 4, 'busy'), /CHECK constraint failed/);
});

test('migrations adopt a pre-versioning database and refuse a newer schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-agent-db-'));
  const path = join(directory, 'agent.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(migrations[0]!);
    legacy
      .prepare('INSERT INTO orders VALUES (?,?)')
      .run('DEMO-1001', '{"kept":true}');
    legacy.close();

    const upgraded = openDatabase(path);
    const version = upgraded.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    assert.equal(version.user_version, migrations.length);
    assert.ok(upgraded.prepare('SELECT 1 FROM orders').get());
    upgraded.exec(`PRAGMA user_version=${migrations.length + 1}`);
    upgraded.close();
    assert.throws(() => openDatabase(path), /newer than this application/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the result contract rejects unknown outcomes', () => {
  const result = {
    eventId: crypto.randomUUID(),
    occurredAt: '2026-10-16T06:05:00Z',
    requestId: 'req-1001',
    requestStatus: 'completed',
    useCase: 'order_confirmation',
    attempt: null,
    outcome: {
      code: 'confirmed',
      summary: 'Customer confirmed.',
      callbackAt: null,
    },
  };
  assert.ok(callResultSchema.safeParse(result).success);
  assert.equal(
    callResultSchema.safeParse({
      ...result,
      outcome: { ...result.outcome, code: 'declined' },
    }).success,
    false,
  );
});
