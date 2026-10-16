import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import {
  createPlivoTelephony,
  plivoFinalStatus,
  verifyPlivoSignature,
} from '../src/modules/call-management/infrastructure/plivo.js';
import {
  registerPlivoRoutes,
  VOICE_SESSION_TOKEN_PURPOSE,
} from '../src/modules/call-management/plivo.routes.js';
import { TelephonyError } from '../src/modules/call-management/telephony.js';
import { registerHttpSecurity } from '../src/platform/http/security.js';
import { verifyToken } from '../src/platform/security/tokens.js';
import { callRequest, harness } from './support.js';

const authToken = 'plivo-test-auth-token';
const nonce = '12345678901234567890';
const publicBaseUrl = 'https://agent.example.com';
const sessionSecret = 'session-secret-that-is-at-least-32-characters';
const streamUrl = 'wss://agent.example.com/voice/plivo';

// Generated with plivo-python's utils/signature_v3.py (the reference implementation).
const referenceVectors: {
  method: 'GET' | 'POST';
  url: string;
  params: Record<string, string>;
  signature: string;
}[] = [
  {
    method: 'POST',
    url: 'https://agent.example.com/hooks/plivo/hangup?attempt=6f1c2a9e-3b0d-4c55-9f1e-8a2b7c0d4e11',
    params: {
      CallUUID: 'c-1',
      RequestUUID: 'r-1',
      CallStatus: 'completed',
      HangupCauseCode: '4000',
      HangupCauseName: 'Normal Hangup',
      From: '+918000000000',
      To: '919625532959',
    },
    signature: 'Qvezabme6wGwrCAnThbiPIpQqMG1NwTNYu46TXbUbBA=',
  },
  {
    method: 'POST',
    url: 'https://agent.example.com/hooks/plivo/ring',
    params: { B: 'two words', A: 'x' },
    signature: 'K2qOpsaoYslocyDikfB1FO+0yuvqetR8q5pqKdS3bbE=',
  },
  {
    method: 'POST',
    url: 'https://agent.example.com/hooks/plivo/ring?b=2&a=1&a=0',
    params: {},
    signature: 'YVpCWRCpEIZF5xD3mjih1Gzq8JFg7c5FfbLz/TrJdmM=',
  },
  {
    method: 'GET',
    url: 'https://agent.example.com/stream?z=last&attempt=a%2Bb',
    params: {},
    signature: 'kpKacvgGzuLa2dMrX9Fc2cVFbQJTCvK4dW/atUKmn90=',
  },
];

test('Plivo V3 signatures match the reference implementation', () => {
  for (const vector of referenceVectors) {
    assert.equal(
      verifyPlivoSignature({ authToken, nonce, ...vector }),
      true,
      vector.url,
    );
    assert.equal(
      verifyPlivoSignature({ authToken: `${authToken}x`, nonce, ...vector }),
      false,
    );
    assert.equal(
      verifyPlivoSignature({ authToken, nonce: `${nonce}0`, ...vector }),
      false,
    );
  }
  const [hangup] = referenceVectors;
  assert.equal(
    verifyPlivoSignature({
      authToken,
      nonce,
      ...hangup!,
      params: { ...hangup!.params, HangupCauseCode: '3000' },
    }),
    false,
  );
  // Plivo sends one signature per active auth token, comma separated.
  assert.equal(
    verifyPlivoSignature({
      authToken,
      nonce,
      ...hangup!,
      signature: `AAAA,${hangup!.signature}`,
    }),
    true,
  );
  assert.equal(
    verifyPlivoSignature({ authToken, nonce: undefined, ...hangup! }),
    false,
  );
});

test('Plivo hangup causes map to attempt results', () => {
  const status = (causeCode: number | null, extra = {}) =>
    plivoFinalStatus({ answered: false, causeCode, ...extra });
  assert.equal(
    plivoFinalStatus({ answered: true, causeCode: 6020 }),
    'completed',
  );
  assert.equal(status(3010), 'busy');
  assert.equal(status(3020), 'busy');
  assert.equal(status(3000), 'no_answer');
  assert.equal(status(6010), 'no_answer');
  assert.equal(status(null, { callStatus: 'no-answer' }), 'no_answer');
  assert.equal(status(2000), 'failed');
  assert.equal(status(5030), 'failed');
});

// Signs a form POST the way Plivo does for URLs that carry a query string.
function plivoHeaders(path: string, params: Record<string, string>) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  const [base, query] = `${publicBaseUrl}${path}`.split('?');
  const canonical = `${base}?${query}.${sorted}`;
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'x-plivo-signature-v3-nonce': nonce,
    'x-plivo-signature-v3': createHmac('sha256', authToken)
      .update(`${canonical}.${nonce}`)
      .digest('base64'),
  };
}

async function callbackApp() {
  const h = harness();
  const app = Fastify({ logger: false });
  await app.register(formbody);
  registerHttpSecurity(app, {
    origin: 'http://localhost:3000',
    resolve: () => null,
  });
  registerPlivoRoutes(app, h.calls, {
    authToken,
    publicBaseUrl,
    streamUrl,
    sessionSecret,
    maxCallSeconds: 180,
  });
  const post = (
    event: string,
    attemptId: string,
    params: Record<string, string>,
    headers = plivoHeaders(
      `/hooks/plivo/${event}?attempt=${attemptId}`,
      params,
    ),
  ) =>
    app.inject({
      method: 'POST',
      url: `/hooks/plivo/${event}?attempt=${attemptId}`,
      headers,
      payload: new URLSearchParams(params).toString(),
    });
  h.calls.acceptCallRequest(callRequest());
  await h.calls.runSchedule();
  const dialled = h.provider.dialled[0]!;
  return { ...h, app, post, dialled };
}

test('signed Plivo callbacks drive an answered call and stream it to the voice agent', async () => {
  const { app, post, dialled, repository, outbox } = await callbackApp();
  const { attemptId, providerCallId } = dialled;
  const ids = { RequestUUID: providerCallId, CallUUID: 'leg-1' };

  assert.equal(
    (await post('ring', attemptId, { ...ids, CallStatus: 'ringing' }))
      .statusCode,
    204,
  );
  assert.equal(repository.attemptById(attemptId)!.providerLegId, 'leg-1');

  const answer = await post('answer', attemptId, {
    ...ids,
    CallStatus: 'in-progress',
  });
  assert.equal(answer.statusCode, 200);
  assert.match(answer.headers['content-type']!, /application\/xml/);
  assert.match(
    answer.body,
    /<Stream bidirectional="true" keepCallAlive="true" contentType="audio\/x-mulaw;rate=8000"/,
  );
  assert.match(answer.body, new RegExp(`>${streamUrl}</Stream>`));
  const token = answer.body.match(/sessionToken=([^"&;]+)/)![1]!;
  assert.match(answer.body, new RegExp(`attemptId=${attemptId}`));
  assert.equal(
    verifyToken(sessionSecret, token, VOICE_SESSION_TOKEN_PURPOSE),
    attemptId,
  );
  assert.equal(repository.attemptById(attemptId)!.status, 'in_progress');

  // A dropped line after answer still counts as answered.
  const hangup = await post('hangup', attemptId, {
    ...ids,
    CallStatus: 'completed',
    HangupCauseCode: '3010',
    HangupCauseName: 'Busy Line',
  });
  assert.equal(hangup.statusCode, 204);
  assert.equal(repository.attemptById(attemptId)!.status, 'completed');
  assert.equal(outbox()[0]!.payload.attempt!.result, 'answered');

  // A late answer for a finished attempt must not open a stream.
  const late = await post('answer', attemptId, ids);
  assert.match(late.body, /<Hangup\/>/);
  await app.close();
});

test('an unanswered Plivo call records the hangup cause and schedules a retry', async () => {
  const { app, post, dialled, repository, outbox } = await callbackApp();
  const response = await post('hangup', dialled.attemptId, {
    RequestUUID: dialled.providerCallId,
    CallUUID: 'leg-2',
    CallStatus: 'completed',
    HangupCauseCode: '3000',
    HangupCauseName: 'No Answer',
    BillDuration: '0',
  });
  assert.equal(response.statusCode, 204);
  const attempt = repository.attemptById(dialled.attemptId)!;
  assert.equal(attempt.status, 'no_answer');
  assert.equal(attempt.failureReason, 'No Answer');
  assert.equal(outbox()[0]!.payload.requestStatus, 'pending');
  await app.close();
});

test('forged or mismatched Plivo callbacks change nothing and never open a stream', async () => {
  const { app, post, dialled, repository } = await callbackApp();
  const { attemptId, providerCallId } = dialled;
  const params = { RequestUUID: providerCallId, CallUUID: 'leg-1' };

  const forged = await post('hangup', attemptId, params, {
    ...plivoHeaders(`/hooks/plivo/hangup?attempt=${attemptId}`, params),
    'x-plivo-signature-v3': 'Zm9yZ2Vk',
  });
  assert.equal(forged.statusCode, 403);
  // A valid signature for one attempt cannot be replayed against another.
  const replayed = await post(
    'answer',
    crypto.randomUUID(),
    params,
    plivoHeaders(`/hooks/plivo/answer?attempt=${attemptId}`, params),
  );
  assert.equal(replayed.statusCode, 403);

  await post('ring', attemptId, params);
  const otherLeg = await post('answer', attemptId, {
    ...params,
    CallUUID: 'leg-9',
  });
  assert.match(otherLeg.body, /<Hangup\/>/);
  const otherRequest = await post('hangup', attemptId, {
    ...params,
    RequestUUID: 'other',
  });
  assert.equal(otherRequest.statusCode, 403);
  assert.equal(repository.attemptById(attemptId)!.status, 'ringing');
  await app.close();
});

test('the Plivo client dials with per-attempt callbacks and classifies failures', async (t) => {
  const telephony = createPlivoTelephony({
    authId: 'MATEST',
    authToken,
    fromNumber: '+918000000000',
    publicBaseUrl,
    maxCallSeconds: 180,
  });
  const requests: Request[] = [];
  const responses: (Response | Error)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
  );
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });

  responses.push(
    json(201, { message: 'call fired', request_uuid: 'req-uuid-1' }),
  );
  assert.deepEqual(
    await telephony.dial({ attemptId: 'a-1', phone: '+919625532959' }),
    { providerCallId: 'req-uuid-1', status: 'ringing' },
  );
  const sent = requests[0]!;
  assert.equal(sent.url, 'https://api.plivo.com/v1/Account/MATEST/Call/');
  assert.equal(
    sent.headers.get('authorization'),
    `Basic ${Buffer.from(`MATEST:${authToken}`).toString('base64')}`,
  );
  const body = (await sent.json()) as Record<string, unknown>;
  assert.equal(body.from, '918000000000');
  assert.equal(body.to, '919625532959');
  assert.equal(
    body.answer_url,
    `${publicBaseUrl}/hooks/plivo/answer?attempt=a-1`,
  );
  assert.equal(
    body.hangup_url,
    `${publicBaseUrl}/hooks/plivo/hangup?attempt=a-1`,
  );
  assert.equal(body.ring_url, `${publicBaseUrl}/hooks/plivo/ring?attempt=a-1`);
  assert.equal(body.time_limit, 180);

  const dialFailure = async () =>
    telephony.dial({ attemptId: 'a-2', phone: '+919625532959' }).then(
      () => assert.fail('expected a failure'),
      (error: TelephonyError) => error,
    );
  responses.push(json(400, { error: 'invalid number' }));
  assert.equal((await dialFailure()).uncertain, false);
  responses.push(json(503, {}));
  assert.equal((await dialFailure()).uncertain, true);
  responses.push(new TypeError('fetch failed'));
  assert.equal((await dialFailure()).uncertain, true);
  responses.push(json(201, { message: 'call fired' }));
  assert.equal((await dialFailure()).uncertain, true);

  responses.push(
    json(200, {
      answer_time: null,
      bill_duration: 0,
      hangup_cause_code: 3010,
      hangup_cause_name: 'Busy Line',
    }),
  );
  assert.deepEqual(
    await telephony.lookup({
      providerCallId: 'req-uuid-1',
      providerLegId: 'leg-1',
    }),
    { status: 'busy', detail: 'Busy Line' },
  );
  responses.push(json(404, {}), json(200, { call_status: 'in-progress' }));
  assert.deepEqual(
    await telephony.lookup({
      providerCallId: 'req-uuid-1',
      providerLegId: 'leg-1',
    }),
    { status: 'in_progress' },
  );
  assert.match(requests.at(-1)!.url, /\/Call\/leg-1\/\?status=live$/);
  responses.push(json(404, {}), json(404, {}));
  await assert.rejects(
    telephony.lookup({ providerCallId: 'req-uuid-1', providerLegId: 'leg-1' }),
    (error: TelephonyError) => error.uncertain,
  );
  await assert.rejects(
    telephony.lookup({ providerCallId: 'req-uuid-1', providerLegId: null }),
    (error: TelephonyError) => error.uncertain,
  );
});
