import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { SarvamAgent, wavPcm24k } from '../server/agent/sarvam.js';
import { recordOutcome } from '../server/agent/outcome.js';
import { settingsSchema } from '../shared/domain.js';
import { Store } from '../server/store.js';

function wav() {
  const data = Buffer.alloc(44 + 960);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(960, 40); data.fill(1, 44);
  return data;
}
class SpeechSocket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  terminate() { this.readyState = 3; }
  event(event: object) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
const settings = settingsSchema.parse({ storeName: 'Demo', language: 'English', voiceProvider: 'sarvam' });
const db = () => new Store(':memory:', settings, '+919625532959');

test('settings persist provider selection and calls retain a snapshot', () => {
  const store = db();
  try {
    const first = store.create('DEMO-1001', 'browser', 'one');
    store.saveSettings({ ...store.settings(), voiceProvider: 'gemini', geminiModel: 'different-live-model' });
    const second = store.create('DEMO-1001', 'browser', 'two');
    assert.equal(store.call(first.id)?.agentSettings?.voiceProvider, 'sarvam');
    assert.equal(second.agentSettings?.geminiModel, 'different-live-model');
    assert.throws(() => settingsSchema.parse({ ...settings, sarvamSttModel: 'made-up' }));
    assert.throws(() => settingsSchema.parse({ ...settings, geminiModel: 'https://attacker.example/?key=x' }));
  } finally { store.close(); }
});
test('both providers share actual-customer-quote validation and reject contradictory outcomes', () => {
  const store = db();
  try {
    const call = store.create('DEMO-1001', 'browser', 'quote'); store.update(call.id, { status: 'active' });
    const output = { outcome() {} };
    assert.ok(recordOutcome(call, store, 'Hello there', { outcome: 'confirmed', evidence: 'Yes I confirm' }, output).error);
    assert.equal(store.call(call.id)?.outcome, null);
    assert.equal(recordOutcome(call, store, 'Yes, I confirm this test order.', { outcome: 'confirmed', evidence: 'Yes, I confirm this test order.' }, output).recorded, 'confirmed');
    assert.ok(recordOutcome(call, store, 'Please decline it', { outcome: 'declined', evidence: 'Please decline it' }, output).error);
    assert.equal(store.order('DEMO-1001')?.outcome, null);
  } finally { store.close(); }
});
test('Sarvam WAV parser removes metadata and rejects compressed/wrong-rate/truncated audio', () => {
  const data = wav();
  assert.deepEqual(wavPcm24k(data.toString('base64')), data.subarray(44));
  const invalid = Buffer.from(data); invalid.writeUInt32LE(16000, 24);
  assert.throws(() => wavPcm24k(invalid.toString('base64')));
  assert.throws(() => wavPcm24k(data.subarray(0, 60).toString('base64')));
  invalid.writeUInt32LE(24000, 24); invalid.writeUInt16LE(3, 20);
  assert.throws(() => wavPcm24k(invalid.toString('base64')));
});

test('Sarvam speech → conversation → synthesis records a supported practice outcome and ignores repeated final transcripts', { timeout: 5000 }, async () => {
  const store = db(); const socket = new SpeechSocket(); const events = new EventEmitter();
  const call = store.create('DEMO-1001', 'browser', 'pipeline'); store.update(call.id, { status: 'active' });
  const customer = 'Yes, I confirm this test order.';
  const paths: string[] = []; let completions = 0; let bytes = 0;
  const agent = new SarvamAgent(call, store, {
    audio(data) { bytes += Buffer.from(data, 'base64').length; }, interrupted() {}, transcript() {}, outcome() {}, failure(message) { events.emit('failure', message); }, turnComplete(outcome) { events.emit('turn', outcome); },
  }, {
    socket(url, options) { assert.equal(url.searchParams.get('sample_rate'), '16000'); assert.ok(options.headers); return socket as unknown as WebSocket; },
    request: (async (url, options) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      const body = JSON.parse(String(options?.body));
      if (path === '/v1/chat/completions') {
        completions++; assert.equal(body.model, settings.sarvamModel);
        return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: 'Your test confirmation is recorded. Goodbye.', outcome: 'confirmed', evidence: customer }) } }] });
      }
      assert.equal(body.speech_sample_rate, 24000);
      if (completions === 0) assert.match(body.text, /speaking with Sarvam/);
      return Response.json({ audios: [wav().toString('base64')] });
    }) as typeof fetch,
  });
  const turn = () => new Promise<boolean>((resolve, reject) => { events.once('turn', resolve); events.once('failure', message => reject(new Error(message))); });
  try {
    const firstTurn = turn(); const connected = agent.connect(store.order('DEMO-1001')!, settings);
    socket.event({ event: 'session.begin' }); assert.equal(await connected, true); assert.equal(await firstTurn, false);
    agent.audio('AQABAA=='); assert.equal(JSON.parse(socket.sent[0]!).event, 'audio_input');
    const finalTurn = turn(); socket.event({ event: 'vad.speech_start' });
    socket.event({ event: 'transcript.final', utterance_idx: 0, text: customer });
    socket.event({ event: 'transcript.final', utterance_idx: 0, text: customer });
    assert.equal(await finalTurn, true); assert.equal(completions, 1); assert.equal(bytes, 1920);
    assert.deepEqual(paths, ['/text-to-speech', '/v1/chat/completions', '/text-to-speech']);
    assert.equal(store.call(call.id)?.outcome, 'confirmed'); assert.equal(store.order('DEMO-1001')?.outcome, null);
  } finally { agent.close(); store.close(); }
});

test('Sarvam cancellation drops stale synthesis and shutdown resolves pending startup', { timeout: 5000 }, async () => {
  const store = db(); const socket = new SpeechSocket(); const call = store.create('DEMO-1001', 'browser', 'cancel');
  store.update(call.id, { status: 'active' });
  let release!: (response: Response) => void; let notify!: () => void; let audio = 0;
  const pendingTts = new Promise<Response>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { notify = resolve; });
  const output = { audio() { audio++; }, interrupted() {}, turnComplete() {}, transcript() {}, outcome() {}, failure() {} };
  const agent = new SarvamAgent(call, store, output, {
    socket: () => socket as unknown as WebSocket,
    request: (async url => {
      if (String(url).endsWith('/v1/chat/completions')) return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: 'Hello', outcome: null, evidence: null }) } }] });
      notify(); return pendingTts;
    }) as typeof fetch,
  });
  try {
    const connected = agent.connect(store.order('DEMO-1001')!, settings); socket.event({ event: 'session.begin' }); await connected; await requested;
    socket.event({ event: 'vad.speech_start' }); release(Response.json({ audios: [wav().toString('base64')] }));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(audio, 0);
    agent.close();
    const unopened = new SarvamAgent(call, store, output, { socket: () => new SpeechSocket() as unknown as WebSocket, request: fetch });
    const pending = unopened.connect(store.order('DEMO-1001')!, settings); unopened.close(); assert.equal(await pending, false);
  } finally { agent.close(); store.close(); }
});

test('legacy settings preserve store/language and receive configured model defaults on startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-settings-'));
  const path = join(directory, 'test.sqlite');
  try {
    let store = new Store(path, settings, '+919625532959'); store.close();
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify({ storeName: 'Existing Store', language: 'Hindi' })); raw.close();
    store = new Store(path, { ...settings, geminiModel: 'custom-live-model' }, '+919625532959');
    assert.equal(store.settings().storeName, 'Existing Store'); assert.equal(store.settings().language, 'Hindi');
    assert.equal(store.settings().voiceProvider, 'sarvam'); assert.equal(store.settings().geminiModel, 'custom-live-model'); store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
