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
  ENABLE_PHONE_CALLS: 'true',
  EXOTEL_ACCOUNT_SID: 'test-account',
  EXOTEL_API_KEY: 'test-key',
  EXOTEL_API_TOKEN: 'test-token',
  EXOTEL_CALLER_ID: '08000000000',
  EXOTEL_FLOW_ID: '',
  PUBLIC_BASE_URL: 'https://test.example',
});
const { createApp } = await import('../src/app.js');
const { ProviderError, dial } =
  await import('../src/modules/calls/infrastructure/exotel.js');
const { config } = await import('../src/config/index.js');
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
test('Exotel dial sends the documented multipart streaming request without automatic retries', async (t) => {
  const db = makeStore();
  const call = db.create('DEMO-1001', 'phone', randomUUID());
  let attempts = 0;
  let request: Request | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      attempts++;
      request = new Request(input, init);
      return new Response('', { status: 503 });
    },
  );
  try {
    await assert.rejects(
      dial(call, '+919625532959'),
      (error) => error instanceof ProviderError && error.uncertain,
    );
    assert.equal(attempts, 1);
    assert.ok(request);
    assert.match(request.url, /\/Calls\/connect\.json$/);
    assert.match(
      request.headers.get('content-type')!,
      /^multipart\/form-data; boundary=/,
    );
    assert.equal(request.headers.get('accept'), 'application/json');
    const form = await request.formData();
    assert.equal(form.get('From'), '+919625532959');
    assert.equal(form.get('StreamType'), 'bidirectional');
    assert.equal(form.get('Record'), 'false');
    assert.deepEqual(form.getAll('StatusCallbackEvents[]'), [
      'terminal',
      'answered',
    ]);
    const stream = new URL(String(form.get('StreamUrl')));
    assert.equal(stream.protocol, 'wss:');
    assert.equal(stream.searchParams.get('sample-rate'), '16000');
    assert.equal(
      verifyToken(
        process.env.SESSION_SECRET!,
        stream.searchParams.get('token')!,
        'exotel-stream',
      ),
      call.id,
    );
    const callback = new URL(String(form.get('StatusCallback')));
    assert.equal(
      verifyToken(
        process.env.SESSION_SECRET!,
        callback.searchParams.get('token')!,
        'exotel-callback',
      ),
      call.id,
    );
  } finally {
    db.close();
  }
});
test('flow dialing targets the Voicebot flow without direct-stream parameters', async (t) => {
  const db = makeStore();
  const previous = config.EXOTEL_FLOW_ID;
  config.EXOTEL_FLOW_ID = '1359335';
  let request: Request | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ Call: { Sid: 'flow-call', Status: 'queued' } });
    },
  );
  try {
    assert.equal(
      (
        await dial(
          db.create('DEMO-1001', 'phone', randomUUID()),
          '+919625532959',
        )
      ).Sid,
      'flow-call',
    );
    assert.match(
      request!.headers.get('content-type')!,
      /^application\/x-www-form-urlencoded/,
    );
    const form = await request!.formData();
    assert.equal(
      form.get('Url'),
      'http://my.exotel.com/test-account/exoml/start_voice/1359335',
    );
    assert.equal(form.get('StatusCallbackEvents'), 'terminal');
    assert.equal(form.get('StreamUrl'), null);
    assert.equal(form.get('StreamType'), null);
    assert.equal(form.get('CallType'), 'trans');
  } finally {
    config.EXOTEL_FLOW_ID = previous;
    db.close();
  }
});
test('flow resolver only issues stream tokens for known, recent, live phone calls', async (t) => {
  const previous = config.EXOTEL_FLOW_ID;
  config.EXOTEL_FLOW_ID = '1359335';
  const db = makeStore();
  const app = await createApp({ store: db, logging: false });
  const call = db.create('DEMO-1001', 'phone', randomUUID());
  db.update(call.id, { providerSid: 'flow-call', status: 'connecting' });
  const token = issueToken(
    config.SESSION_SECRET,
    'exotel-flow',
    config.EXOTEL_FLOW_ID,
    86400,
  );
  const url = `/hooks/exotel/stream-url?token=${token}&CallSid=flow-call`;
  try {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const stream = new URL(response.json().url);
    assert.equal(
      verifyToken(
        config.SESSION_SECRET,
        stream.searchParams.get('token')!,
        'exotel-stream',
      ),
      call.id,
    );
    assert.equal(
      (await app.inject(url.replace('flow-call', 'unrelated-call'))).statusCode,
      403,
    );
    assert.equal(
      (await app.inject(url.replace(token, 'invalid'))).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject(
          url.replace(
            token,
            issueToken(
              config.SESSION_SECRET,
              'exotel-flow',
              'another-flow',
              60,
            ),
          ),
        )
      ).statusCode,
      403,
    );
    t.mock.method(
      Date,
      'now',
      () => Date.parse(call.createdAt) + (config.MAX_CALL_SECONDS + 121) * 1000,
    );
    assert.equal((await app.inject(url)).statusCode, 403);
    t.mock.restoreAll();
    db.update(call.id, { status: 'completed' });
    assert.equal((await app.inject(url)).statusCode, 403);
    const practice = db.create('DEMO-1001', 'browser', randomUUID());
    db.update(practice.id, { providerSid: 'practice-call' });
    assert.equal(
      (await app.inject(url.replace('flow-call', 'practice-call'))).statusCode,
      403,
    );
  } finally {
    config.EXOTEL_FLOW_ID = previous;
    await app.close();
  }
});
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
test('same idempotency key dials only once; completed call callback does not confirm order', async () => {
  let dials = 0;
  const db = makeStore();
  const app = await createApp({
    store: db,
    logging: false,
    dial: async () => {
      dials++;
      return { Sid: 'test-call-sid', Status: 'queued' };
    },
  });
  try {
    const headers = await login(app);
    const payload = {
      orderId: 'DEMO-1001',
      mode: 'phone',
      requestKey: randomUUID(),
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/calls',
      headers,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/calls',
      headers,
      payload,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(dials, 1);
    const call = first.json().call;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/calls',
          headers,
          payload: { ...payload, requestKey: randomUUID() },
        })
      ).statusCode,
      409,
    );
    const token = issueToken(
      process.env.SESSION_SECRET!,
      'exotel-callback',
      call.id,
      60,
    );
    const callback = await app.inject({
      method: 'POST',
      url: `/hooks/exotel?token=${token}`,
      payload: { CallSid: 'test-call-sid', Status: 'completed' },
    });
    assert.equal(callback.statusCode, 200);
    assert.equal(db.call(call.id)?.status, 'completed');
    assert.equal(db.order('DEMO-1001')?.outcome, null);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/hooks/exotel?token=${token}`,
          payload: { CallSid: 'different-call', Status: 'failed' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/hooks/exotel?token=invalid',
          payload: { CallSid: 'test-call-sid', Status: 'completed' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/calls',
          headers,
          payload: { ...payload, mode: 'browser' },
        })
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
  }
});
test(
  'uncertain dial is not retried, and unconnected practice tokens cannot be replayed',
  { timeout: 10000 },
  async () => {
    let attempts = 0;
    const db = makeStore();
    const app = await createApp({
      store: db,
      logging: false,
      dial: async () => {
        attempts++;
        throw new ProviderError('Dial request timed out.', true);
      },
      voice: (socket) => {
        socket.on('message', () =>
          socket.send(JSON.stringify({ event: 'ready' })),
        );
      },
    });
    try {
      const headers = await login(app);
      const payload = {
        orderId: 'DEMO-1001',
        mode: 'phone',
        requestKey: randomUUID(),
      };
      const result = await app.inject({
        method: 'POST',
        url: '/api/calls',
        headers,
        payload,
      });
      assert.equal(result.json().call.status, 'unknown');
      await app.inject({ method: 'POST', url: '/api/calls', headers, payload });
      assert.equal(attempts, 1);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/calls',
            headers,
            payload: { ...payload, requestKey: randomUUID() },
          })
        ).statusCode,
        409,
      );
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
      assert.equal(
        (await app.inject({ url: `/ws/exotel?token=${token}`, headers }))
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
    assert.deepEqual(response.json().connections.missing, ['SARVAM_API_KEY']);
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
