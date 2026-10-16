import WebSocket from 'ws';
import type { Order, Settings } from '@orderline/contracts';
import { config } from '../src/config/index.js';

// This check uses sample text in a browser-practice session. It never places a phone call.
const base = `http://127.0.0.1:${config.PORT}`;
const origin = new URL(config.APP_ORIGIN).origin;
type PracticeState = { settings: Settings; orders: Order[] };
async function request<T = unknown>(path: string, cookie = '', body?: object) {
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { origin, cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Local request failed (HTTP ${response.status}).`);
  return {
    body: (await response.json()) as T,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie,
  };
}
try {
  const login = await request('/api/login', '', {
    password: config.ADMIN_PASSWORD,
  });
  const before = await request<PracticeState>('/api/state', login.cookie);
  const practice = await request<{ token: string }>(
    '/api/calls',
    login.cookie,
    {
      orderId: 'DEMO-1001',
      mode: 'browser',
      requestKey: crypto.randomUUID(),
    },
  );
  const url = new URL(
    `/ws/browser?token=${encodeURIComponent(practice.body.token)}`,
    base,
  );
  url.protocol = 'ws:';
  const socket = new WebSocket(url, {
    headers: { origin, cookie: login.cookie },
  });
  let audioBytes = 0;
  let transcripts = 0;
  let openingTranscript = '';
  let openingVerified = false;
  const providerNames =
    before.body.settings.voiceProvider === 'sarvam'
      ? /Sarvam|सर्वम|सरवम/i
      : /Gemini|जेमिनी|जैमिनी/i;
  let step = 0;
  let outcome: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Voice verification timed out.'));
    }, 60000);
    socket.on('error', () => {
      clearTimeout(timeout);
      reject(new Error('Practice socket failed.'));
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (outcome) resolve();
      else reject(new Error('Practice ended without a decision.'));
    });
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.event === 'error') {
        clearTimeout(timeout);
        socket.terminate();
        reject(new Error(event.message));
      }
      if (event.event === 'audio')
        audioBytes += Buffer.from(event.data, 'base64').length;
      if (event.event === 'transcript') {
        transcripts++;
        if (!openingVerified && event.role === 'agent')
          openingTranscript += event.text;
      }
      if (event.event === 'outcome') outcome = event.call.outcome;
      if (event.event === 'turn_complete') {
        if (!openingVerified) {
          if (!providerNames.test(openingTranscript)) {
            clearTimeout(timeout);
            socket.terminate();
            reject(
              new Error(
                'Opening introduction did not name the selected voice provider.',
              ),
            );
            return;
          }
          openingVerified = true;
        }
        if (outcome) {
          if (event.hasOutcome) socket.send(JSON.stringify({ event: 'stop' }));
          return;
        }
        const text =
          step++ === 0
            ? 'Yes, I am the test customer and now is a good time. Please speak English.'
            : 'Yes, I confirm the test order for the wireless headphones at 1499 rupees.';
        if (step > 4) {
          clearTimeout(timeout);
          socket.terminate();
          reject(
            new Error('Agent did not record an explicit test confirmation.'),
          );
          return;
        }
        socket.send(JSON.stringify({ event: 'text', text }));
      }
    });
  });
  const after = await request<PracticeState>('/api/state', login.cookie);
  const beforeOrder = before.body.orders[0];
  const afterOrder = after.body.orders[0];
  if (
    !beforeOrder ||
    !afterOrder ||
    outcome !== 'confirmed' ||
    !audioBytes ||
    !transcripts ||
    beforeOrder.outcome !== afterOrder.outcome
  )
    throw new Error('Voice verification invariants failed.');
  console.log(
    `Voice verification passed: ${audioBytes} PCM audio bytes, ${transcripts} transcript events, provider announced in introduction, confirmed practice outcome, test order unchanged. No phone call was placed.`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Voice verification failed.',
  );
  process.exitCode = 1;
}
