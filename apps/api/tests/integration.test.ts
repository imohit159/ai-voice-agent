import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  SIGNATURE_HEADER,
  callResultSchema,
  type CallRequest,
} from '@orderline/contracts/integration';
import { openDatabase } from '../src/platform/persistence/database.js';
import { migrations } from '../src/platform/persistence/migrations.js';
import {
  signBody,
  verifySignature,
} from '../src/platform/security/signatures.js';
import { registerHttpSecurity } from '../src/platform/http/security.js';
import { createCallRequestRepository } from '../src/modules/integrations/repository.js';
import { createIntegrations } from '../src/modules/integrations/service.js';
import { registerIntegrationRoutes } from '../src/modules/integrations/routes.js';

const secret = 'integration-secret-that-is-at-least-32-chars';
const now = new Date('2026-10-16T06:00:00.000Z');
const url = '/integrations/v1/call-requests';

function callRequest(overrides: Partial<CallRequest> = {}): CallRequest {
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

async function integrationApp() {
  const db = openDatabase(':memory:');
  const app = Fastify({ logger: false });
  registerHttpSecurity(app, {
    origin: 'http://localhost:3000',
    isLoggedIn: () => false,
  });
  const integrations = createIntegrations({
    requests: createCallRequestRepository(db),
    now: () => now,
    newId: () => crypto.randomUUID(),
    log: { info: () => {} },
  });
  await registerIntegrationRoutes(app, integrations, secret);
  const send = (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]:
          signature ?? signBody(secret, body, Math.floor(Date.now() / 1000)),
      },
      payload: body,
    });
  };
  return { app, db, send };
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
  const { app, db, send } = await integrationApp();
  const first = await send(callRequest());
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json(), {
    requestId: 'req-1001',
    status: 'pending',
    acceptedAt: now.toISOString(),
  });
  const replay = await send(callRequest());
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());

  const stored = createCallRequestRepository(db).findByRequestId('req-1001')!;
  assert.equal(stored.maxAttempts, 3);
  assert.equal(stored.notBefore, now.toISOString());
  assert.equal(stored.notAfter, '2026-10-17T06:00:00.000Z');
  assert.equal(stored.payload.customer.phone, '+919625532959');
  await app.close();
});

test('conflicting reuse of a request ID or a second open request for the order is rejected', async () => {
  const { app, send } = await integrationApp();
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
  const { app, db, send } = await integrationApp();
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
  const unknownField = await send({ ...callRequest(), discount: 50 });
  assert.equal(unknownField.statusCode, 400);
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
  const { app, db, send } = await integrationApp();
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
  const stored = createCallRequestRepository(db).findByRequestId('req-1001')!;
  assert.equal(stored.notBefore, '2026-10-16T06:30:00.000Z');
  assert.equal(stored.notAfter, '2026-10-16T12:30:00.000Z');
  assert.equal(stored.maxAttempts, 2);
  await app.close();
});

test('the database rejects a second open request for the same order', () => {
  const db = openDatabase(':memory:');
  const insert = (id: string, status: string) =>
    db
      .prepare(
        `INSERT INTO call_requests VALUES (?,?,'integration','order_confirmation','ORD-1',?,3,
          '2026-10-16T06:00:00Z','2026-10-17T06:00:00Z','{}','h','t','t')`,
      )
      .run(id, id, status);
  insert('a', 'completed');
  insert('b', 'pending');
  assert.throws(() => insert('c', 'in_progress'), /UNIQUE constraint failed/);
  assert.throws(() => insert('d', 'unknown'), /CHECK constraint failed/);
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

test('the result contract accepts a final answered attempt and rejects unknown outcomes', () => {
  const result = {
    eventId: crypto.randomUUID(),
    occurredAt: '2026-10-16T06:05:00Z',
    requestId: 'req-1001',
    requestStatus: 'completed',
    useCase: 'order_confirmation',
    attempt: {
      id: crypto.randomUUID(),
      number: 1,
      result: 'answered',
      startedAt: '2026-10-16T06:00:00Z',
      answeredAt: '2026-10-16T06:00:08Z',
      endedAt: '2026-10-16T06:02:00Z',
      durationSeconds: 112,
      failureReason: null,
    },
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
