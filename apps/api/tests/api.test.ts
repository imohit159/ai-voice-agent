import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/platform/persistence/store.js';
import { issueToken, verifyToken } from '../src/platform/security/tokens.js';

Object.assign(process.env, {
  ADMIN_PASSWORD: 'test-password-at-least-16-characters',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  SARVAM_API_KEY: '',
  APP_ORIGIN: 'http://localhost:3000',
  GEMINI_API_KEY: 'test-key-not-a-real-credential',
  TELEPHONY_PROVIDER: 'simulated',
  PUBLIC_BASE_URL: 'https://test.example',
});
const { createApp } = await import('../src/app.js');
const origin = 'http://localhost:3000';
const makeStore = () =>
  new Store(
    ':memory:',
    { storeName: 'Test Store', language: 'English' },
    '+919625532959',
  );
async function login(app: Awaited<ReturnType<typeof createApp>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { password: process.env.ADMIN_PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: response.headers['set-cookie']!.toString().split(';')[0]!,
    origin,
  };
}
test('API requires authentication, rejects hostile origin/host, and exposes no secrets', async () => {
  const app = await createApp({ store: makeStore(), logging: false });
  try {
    assert.equal((await app.inject('/api/state')).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { password: 'wrong' },
        })
      ).statusCode,
      403,
    );
    const headers = await login(app);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: { ...headers, origin: 'https://attacker.example' },
          payload: { storeName: 'Bad', language: 'English' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/state',
          headers: { ...headers, host: 'attacker.example' },
        })
      ).statusCode,
      403,
    );
    const response = await app.inject({ url: '/api/state', headers });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes('test-key-not-a-real-credential'));
    assert.ok(!response.body.includes(process.env.ADMIN_PASSWORD!));
    assert.equal(response.json().orders[0].phone, '+919625532959');
  } finally {
    await app.close();
  }
});
test('every operator route shares authentication, origin checks, and validation after route registration', async () => {
  const app = await createApp({ store: makeStore(), logging: false });
  const id = randomUUID();
  const routes = [
    { method: 'GET' as const, url: '/api/state' },
    { method: 'PUT' as const, url: '/api/settings' },
    { method: 'POST' as const, url: '/api/demo/reset' },
    { method: 'GET' as const, url: `/api/calls/${id}` },
    { method: 'POST' as const, url: '/api/calls' },
    { method: 'POST' as const, url: `/api/calls/${id}/reconcile` },
    { method: 'POST' as const, url: '/api/logout' },
  ];
  try {
    for (const route of routes) {
      assert.equal(
        (await app.inject({ ...route, headers: { origin } })).statusCode,
        401,
        route.url,
      );
    }
    const headers = await login(app);
    for (const route of routes.filter((route) => route.method !== 'GET')) {
      assert.equal(
        (
          await app.inject({
            ...route,
            headers: { ...headers, origin: 'https://attacker.example' },
          })
        ).statusCode,
        403,
        route.url,
      );
    }
    for (const url of ['/api/settings', '/api/calls']) {
      const response = await app.inject({
        method: url === '/api/settings' ? 'PUT' : 'POST',
        url,
        headers,
        payload: { unexpected: true },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.json().error,
        'Invalid request. Check the supplied fields.',
      );
    }
    assert.equal(
      (await app.inject({ url: '/api/calls/invalid-id', headers })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: `/api/calls/${id}`, headers })).statusCode,
      404,
    );
    const logout = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers,
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(logout.json().authenticated, false);
    assert.match(String(logout.headers['set-cookie']), /session=;/);
    assert.equal(
      (await app.inject('/api/session')).json().authenticated,
      false,
    );
  } finally {
    await app.close();
  }
});
test(
  'unconnected practice tokens cannot be replayed',
  { timeout: 10000 },
  async () => {
    const db = makeStore();
    const app = await createApp({
      store: db,
      logging: false,
      voice: (socket) => {
        socket.on('message', () =>
          socket.send(JSON.stringify({ event: 'ready' })),
        );
      },
    });
    try {
      const headers = await login(app);
      const practice = await app.inject({
        method: 'POST',
        url: '/api/calls',
        headers,
        payload: {
          orderId: 'DEMO-1001',
          mode: 'browser',
          requestKey: randomUUID(),
        },
      });
      const token = practice.json().token;
      await app.ready();
      const client = await app.injectWS(`/ws/browser?token=${token}`, {
        headers,
      });
      const response = new Promise<string>((resolve) =>
        client.once('message', (data) => resolve(data.toString())),
      );
      client.send('ping');
      const received = await response;
      assert.equal(JSON.parse(received).event, 'ready');
      for (const socket of app.websocketServer.clients) socket.terminate();
      client.terminate();
      assert.equal(
        (await app.inject({ url: `/ws/browser?token=${token}`, headers }))
          .statusCode,
        403,
      );
    } finally {
      await app.close();
    }
  },
);

test('selected provider controls readiness and missing Sarvam credentials never fall back to Gemini', async () => {
  const db = makeStore();
  const app = await createApp({ store: db, logging: false });
  try {
    const headers = await login(app);
    let response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { ...db.settings(), voiceProvider: 'sarvam' },
    });
    assert.equal(response.statusCode, 200);
    response = await app.inject({ url: '/api/state', headers });
    assert.equal(response.json().connections.selectedConfigured, false);
    response = await app.inject({
      method: 'POST',
      url: '/api/calls',
      headers,
      payload: {
        orderId: 'DEMO-1001',
        mode: 'browser',
        requestKey: randomUUID(),
      },
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /SARVAM_API_KEY/);
    assert.equal(db.calls().length, 0);
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        ...db.settings(),
        voiceProvider: 'gemini',
        geminiModel: 'configured-live-model',
      },
    });
    response = await app.inject({
      method: 'POST',
      url: '/api/calls',
      headers,
      payload: {
        orderId: 'DEMO-1001',
        mode: 'browser',
        requestKey: randomUUID(),
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().call.agentSettings.geminiModel,
      'configured-live-model',
    );
  } finally {
    await app.close();
  }
});
test('the integration endpoint is disabled without a secret and does not change dashboard JSON parsing', async () => {
  const app = await createApp({ store: makeStore(), logging: false });
  const disabled = await app.inject({
    method: 'POST',
    url: '/integrations/v1/call-requests',
    headers: { 'content-type': 'application/json', 'x-signature': 't=1,v1=0' },
    payload: '{}',
  });
  assert.equal(disabled.statusCode, 503);
  const headers = await login(app);
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/calls',
    headers,
    payload: { orderId: 'DEMO-1001', mode: 'browser' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json().fields, ['requestKey']);
  await app.close();
});
