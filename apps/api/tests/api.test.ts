import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/platform/persistence/store.js';
import type { VoiceAgentClient } from '../src/modules/call-management/infrastructure/voice-agent.js';

const internalToken = 'test-internal-token-at-least-32-characters';
Object.assign(process.env, {
  ADMIN_PASSWORD: 'test-password-at-least-16-characters',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  APP_ORIGIN: 'http://localhost:3000',
  TELEPHONY_PROVIDER: 'simulated',
  PUBLIC_BASE_URL: 'https://test.example',
  VOICE_AGENT_INTERNAL_TOKEN: internalToken,
});
const { createApp } = await import('../src/app.js');
const origin = 'http://localhost:3000';
const makeStore = (settings = {}) =>
  new Store(
    ':memory:',
    { storeName: 'Test Store', language: 'English', ...settings },
    '+919625532959',
  );

/** Stands in for the Pipecat service; records what Node forwards to it. */
function fakeVoiceAgent(providers = { gemini: true, sarvam: false }) {
  const offers: Parameters<VoiceAgentClient['practiceOffer']>[0][] = [];
  const client: VoiceAgentClient = {
    status: async () => ({ providers }),
    practiceOffer: async (input) => {
      offers.push(input);
      return { sdp: 'answer-sdp', type: 'answer' };
    },
  };
  return { client, offers };
}

async function appWith(voiceAgent = fakeVoiceAgent()) {
  const app = await createApp({
    store: makeStore(),
    logging: false,
    voiceAgent: voiceAgent.client,
  });
  return { app, voiceAgent };
}

async function login(app: Awaited<ReturnType<typeof createApp>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: {
      email: 'admin@orderline.local',
      password: process.env.ADMIN_PASSWORD,
    },
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: response.headers['set-cookie']!.toString().split(';')[0]!,
    origin,
  };
}

const internal = { authorization: `Bearer ${internalToken}` };

test('API requires authentication, rejects hostile origin/host, and exposes no secrets', async () => {
  const { app } = await appWith();
  try {
    assert.equal((await app.inject('/api/state')).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { email: 'admin@orderline.local', password: 'wrong' },
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
    assert.ok(!response.body.includes(internalToken));
    assert.ok(!response.body.includes(process.env.ADMIN_PASSWORD!));
    assert.equal(response.json().orders[0].phone, '+919625532959');
  } finally {
    await app.close();
  }
});

test('every operator route shares authentication, origin checks, and validation', async () => {
  const { app } = await appWith();
  const id = randomUUID();
  const routes = [
    { method: 'GET' as const, url: '/api/state' },
    { method: 'PUT' as const, url: '/api/settings' },
    { method: 'POST' as const, url: '/api/demo/reset' },
    { method: 'GET' as const, url: '/api/call-attempts' },
    { method: 'GET' as const, url: `/api/call-attempts/${id}` },
    { method: 'POST' as const, url: '/api/practice-sessions' },
    { method: 'POST' as const, url: `/api/practice-sessions/${id}/offer` },
    { method: 'POST' as const, url: '/api/logout' },
  ];
  try {
    for (const route of routes)
      assert.equal(
        (await app.inject({ ...route, headers: { origin } })).statusCode,
        401,
        route.url,
      );
    const headers = await login(app);
    for (const route of routes.filter((route) => route.method !== 'GET'))
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
    const invalidSettings = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { unexpected: true },
    });
    assert.equal(invalidSettings.statusCode, 400);
    assert.equal(
      (await app.inject({ url: '/api/call-attempts/invalid-id', headers }))
        .statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: `/api/call-attempts/${id}`, headers }))
        .statusCode,
      404,
    );
    const logout = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers,
    });
    assert.equal(logout.statusCode, 200);
    assert.match(String(logout.headers['set-cookie']), /session=;/);
  } finally {
    await app.close();
  }
});

test('practice runs through the voice agent without exposing its session token', async () => {
  const { app, voiceAgent } = await appWith();
  try {
    const headers = await login(app);
    const started = await app.inject({
      method: 'POST',
      url: '/api/practice-sessions',
      headers,
    });
    assert.equal(started.statusCode, 200);
    const { attemptId } = started.json();

    const offer = await app.inject({
      method: 'POST',
      url: `/api/practice-sessions/${attemptId}/offer`,
      headers,
      payload: { sdp: 'offer-sdp', type: 'offer' },
    });
    assert.equal(offer.statusCode, 200);
    assert.deepEqual(offer.json(), { sdp: 'answer-sdp', type: 'answer' });
    const { sessionToken } = voiceAgent.offers[0]!;
    assert.ok(!offer.body.includes(sessionToken));

    // The voice agent claims the session over the internal API, once.
    const claimBody = { attemptId, sessionToken, transport: 'webrtc' };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/v1/voice-sessions/claim',
          payload: claimBody,
        })
      ).statusCode,
      401,
    );
    const claim = await app.inject({
      method: 'POST',
      url: '/internal/v1/voice-sessions/claim',
      headers: internal,
      payload: claimBody,
    });
    assert.equal(claim.statusCode, 200);
    const context = claim.json();
    assert.equal(context.isPractice, true);
    assert.deepEqual(context.agent, {
      voiceProvider: 'gemini',
      model: 'gemini-3.8-live',
      language: 'English',
      storeName: 'Test Store',
    });
    assert.equal(context.order.total.amountMinor, 149900);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/v1/voice-sessions/claim',
          headers: internal,
          payload: claimBody,
        })
      ).statusCode,
      409,
    );

    const transcript = await app.inject({
      method: 'POST',
      url: `/internal/v1/voice-sessions/${attemptId}/transcript`,
      headers: internal,
      payload: {
        sessionToken,
        entries: [
          {
            role: 'agent',
            text: 'Hello, this is Test Store.',
            spokenAt: new Date().toISOString(),
          },
          {
            role: 'customer',
            text: 'Haan, boliye.',
            spokenAt: new Date().toISOString(),
          },
        ],
      },
    });
    assert.equal(transcript.statusCode, 204);
    const end = await app.inject({
      method: 'POST',
      url: `/internal/v1/voice-sessions/${attemptId}/end`,
      headers: internal,
      payload: { sessionToken, reason: 'disconnected' },
    });
    assert.equal(end.statusCode, 204);

    const detail = (
      await app.inject({ url: `/api/call-attempts/${attemptId}`, headers })
    ).json();
    assert.equal(detail.attempt.source, 'practice');
    assert.equal(detail.attempt.status, 'completed');
    assert.deepEqual(
      detail.transcript.map((entry: { role: string }) => entry.role),
      ['agent', 'customer'],
    );
    // A finished session accepts no more transcript or offers.
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/internal/v1/voice-sessions/${attemptId}/transcript`,
          headers: internal,
          payload: {
            sessionToken,
            entries: [
              {
                role: 'agent',
                text: 'Late',
                spokenAt: new Date().toISOString(),
              },
            ],
          },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/practice-sessions/${attemptId}/offer`,
          headers,
          payload: { sdp: 'offer-sdp', type: 'offer' },
        })
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
  }
});

test('a session token only opens the attempt it was issued for', async () => {
  const { app, voiceAgent } = await appWith();
  try {
    const headers = await login(app);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { attemptId } = (
        await app.inject({
          method: 'POST',
          url: '/api/practice-sessions',
          headers,
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/api/practice-sessions/${attemptId}/offer`,
        headers,
        payload: { sdp: 'offer-sdp', type: 'offer' },
      });
      ids.push(attemptId);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/voice-sessions/claim',
      headers: internal,
      payload: {
        attemptId: ids[1],
        sessionToken: voiceAgent.offers[0]!.sessionToken,
        transport: 'webrtc',
      },
    });
    assert.equal(response.statusCode, 403);
    const asPhone = await app.inject({
      method: 'POST',
      url: '/internal/v1/voice-sessions/claim',
      headers: internal,
      payload: {
        attemptId: ids[0],
        sessionToken: voiceAgent.offers[0]!.sessionToken,
        transport: 'plivo',
        providerLegId: 'leg-1',
      },
    });
    assert.equal(asPhone.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('readiness follows the voice agent and blocks practice for a provider it cannot serve', async () => {
  const { app } = await appWith(
    fakeVoiceAgent({ gemini: true, sarvam: false }),
  );
  try {
    const headers = await login(app);
    const settings = (await app.inject({ url: '/api/state', headers })).json()
      .settings;
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: { ...settings, voiceProvider: 'sarvam' },
    });
    const state = (await app.inject({ url: '/api/state', headers })).json();
    assert.equal(state.connections.selectedConfigured, false);
    assert.equal(state.connections.geminiConfigured, true);
    const practice = await app.inject({
      method: 'POST',
      url: '/api/practice-sessions',
      headers,
    });
    assert.equal(practice.statusCode, 503);
  } finally {
    await app.close();
  }
});

test('saved settings naming a retired Sarvam model fall back to a supported one', () => {
  const store = makeStore({
    sarvamTtsModel: 'bulbul:v4-flash',
    sarvamSttModel: 'saaras:v3-realtime',
  });
  assert.equal(store.settings().sarvamTtsModel, 'bulbul:v3');
  assert.equal(store.settings().sarvamSttModel, 'saaras:v4');
  store.close();
});

test('the integration endpoint is disabled without a secret and validation lists fields', async () => {
  const { app } = await appWith();
  try {
    const disabled = await app.inject({
      method: 'POST',
      url: '/integrations/v1/call-requests',
      headers: {
        'content-type': 'application/json',
        'x-signature': 't=1,v1=0',
      },
      payload: '{}',
    });
    assert.equal(disabled.statusCode, 503);
    const headers = await login(app);
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/practice-sessions/${randomUUID()}/offer`,
      headers,
      payload: { sdp: 'x' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json().fields, ['type']);
  } finally {
    await app.close();
  }
});

async function loginAs(
  app: Awaited<ReturnType<typeof createApp>>,
  email: string,
  password: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { email, password },
  });
  return {
    status: response.statusCode,
    headers: {
      cookie: String(response.headers['set-cookie'] ?? '').split(';')[0]!,
      origin,
    },
  };
}

test('viewers read but cannot administer; admins manage users safely', async () => {
  const { app } = await appWith();
  try {
    const admin = await login(app);
    const session = (
      await app.inject({ url: '/api/session', headers: admin })
    ).json();
    assert.equal(session.user.role, 'admin');

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: admin,
      payload: {
        email: 'viewer@example.com',
        name: 'Viewer',
        role: 'viewer',
        password: 'viewer-password-123',
      },
    });
    assert.equal(created.statusCode, 200);
    const viewerId = created.json().user.id;
    assert.ok(!created.body.includes('viewer-password-123'));
    assert.ok(!created.body.includes('scrypt'));

    const viewer = await loginAs(
      app,
      'VIEWER@example.com',
      'viewer-password-123',
    );
    assert.equal(viewer.status, 200, 'email is case-insensitive');
    assert.equal(
      (await app.inject({ url: '/api/call-attempts', headers: viewer.headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/result-deliveries',
          headers: viewer.headers,
        })
      ).statusCode,
      200,
    );
    for (const route of [
      { method: 'PUT' as const, url: '/api/settings', payload: {} },
      { method: 'GET' as const, url: '/api/users' },
      { method: 'GET' as const, url: '/api/audit-events' },
      { method: 'POST' as const, url: '/api/demo/reset' },
      {
        method: 'POST' as const,
        url: `/api/result-deliveries/${randomUUID()}/retry`,
      },
    ])
      assert.equal(
        (await app.inject({ ...route, headers: viewer.headers })).statusCode,
        403,
        route.url,
      );

    // Disabling a user ends their existing session immediately.
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/users/${viewerId}`,
          headers: admin,
          payload: { disabled: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: '/api/call-attempts', headers: viewer.headers }))
        .statusCode,
      401,
    );
    assert.equal(
      (await loginAs(app, 'viewer@example.com', 'viewer-password-123')).status,
      401,
    );

    // The last administrator cannot lock everyone out.
    const adminId = session.user.id;
    const selfDemote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: admin,
      payload: { role: 'viewer' },
    });
    assert.equal(selfDemote.statusCode, 409);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: admin,
      payload: {
        email: 'viewer@example.com',
        name: 'Again',
        role: 'viewer',
        password: 'another-password-1',
      },
    });
    assert.equal(duplicate.statusCode, 409);
    const weak = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: admin,
      payload: {
        email: 'weak@example.com',
        name: 'Weak',
        role: 'viewer',
        password: 'short',
      },
    });
    assert.deepEqual(weak.json().fields, ['password']);
  } finally {
    await app.close();
  }
});

test('changing your password signs out other sessions but keeps this one', async () => {
  const { app } = await appWith();
  try {
    const first = await login(app);
    const second = await login(app);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: first,
      payload: {
        currentPassword: process.env.ADMIN_PASSWORD,
        newPassword: 'a-brand-new-password-1',
      },
    });
    assert.equal(changed.statusCode, 200);
    const renewed = {
      cookie: String(changed.headers['set-cookie']).split(';')[0]!,
      origin,
    };
    assert.equal(
      (await app.inject({ url: '/api/state', headers: renewed })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: '/api/state', headers: second })).statusCode,
      401,
    );
    assert.equal(
      (await loginAs(app, 'admin@orderline.local', 'a-brand-new-password-1'))
        .status,
      200,
    );
  } finally {
    await app.close();
  }
});

test('the audit trail records logins, settings changes and practice starts', async () => {
  const { app } = await appWith();
  try {
    const admin = await login(app);
    const settings = (
      await app.inject({ url: '/api/state', headers: admin })
    ).json().settings;
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: admin,
      payload: settings,
    });
    await app.inject({
      method: 'POST',
      url: '/api/practice-sessions',
      headers: admin,
    });
    const events = (
      await app.inject({ url: '/api/audit-events', headers: admin })
    ).json().events;
    assert.deepEqual(
      events.map((e: { action: string }) => e.action).reverse(),
      ['auth.login', 'settings.updated', 'practice.started'],
    );
    assert.equal(events[0].userEmail, 'admin@orderline.local');
  } finally {
    await app.close();
  }
});
