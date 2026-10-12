import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { issueToken, verifyToken } from '../server/security.js';
import { PcmResampler, ExotelAudioFrames, decodeAudio, exotelSampleRate } from '../server/agent/audio.js';
import { providerStatus } from '../shared/domain.js';

const secret = 'test-secret-that-is-at-least-32-characters';
test('Exotel documented PCM metadata accepts kbps and rejects compressed or mismatched audio', () => {
  assert.equal(exotelSampleRate({ encoding: 'raw', sample_rate: '8000', bit_rate: '128' }), 8000);
  assert.equal(exotelSampleRate({ encoding: 'slin', sample_rate: 16000, bit_rate: 256 }), 16000);
  assert.equal(exotelSampleRate({ encoding: 'audio/x-raw', sample_rate: 16000, bit_rate: 16 }), 16000);
  assert.throws(() => exotelSampleRate({ encoding: 'mulaw', sample_rate: 8000, bit_rate: 64 }));
  assert.throws(() => exotelSampleRate({ encoding: 'raw', sample_rate: 16000, bit_rate: 128 }));
});
function store() { return new Store(':memory:', { storeName: 'Test Store', language: 'English' }, '+919625532959'); }
test('signed tokens reject tampering, wrong purpose, and expiration', () => {
  const token = issueToken(secret, 'browser', 'call-123', 60);
  assert.equal(verifyToken(secret, token, 'browser'), 'call-123');
  assert.equal(verifyToken(secret, token, 'exotel-stream'), null);
  assert.equal(verifyToken(secret, `${token}a`, 'browser'), null);
  assert.equal(verifyToken(secret, issueToken(secret, 'browser', 'call', -1), 'browser'), null);
});
test('completed transport never confirms an order; browser decisions remain practice-only', () => {
  const db = store();
  const call = db.create('DEMO-1001', 'browser', 'practice');
  db.update(call.id, { status: 'active' });
  db.setOutcome(call.id, 'confirmed', 'Yes I confirm the test order');
  db.update(call.id, { status: 'completed' });
  assert.equal(db.call(call.id)?.outcome, 'confirmed');
  assert.equal(db.order('DEMO-1001')?.outcome, null);
  const phone = db.create('DEMO-1001', 'phone', 'phone');
  db.update(phone.id, { status: 'completed' });
  assert.equal(db.order('DEMO-1001')?.outcome, null);
  db.close();
});
test('phone outcomes persist atomically and contradictory decisions are rejected', () => {
  const db = store();
  const call = db.create('DEMO-1001', 'phone', 'phone');
  db.update(call.id, { status: 'active' });
  db.setOutcome(call.id, 'needs_follow_up', 'Please call me later');
  assert.equal(db.order('DEMO-1001')?.outcome, 'needs_follow_up');
  assert.throws(() => db.setOutcome(call.id, 'confirmed', 'Yes'), /already recorded/);
  db.close();
});
test('unknown attempts block duplicate phone calls and terminal events cannot regress', () => {
  const db = store();
  const call = db.create('DEMO-1001', 'phone', 'first');
  db.update(call.id, { status: 'unknown' });
  assert.throws(() => db.create('DEMO-1001', 'phone', 'second'));
  assert.equal(db.claim(call.id), true);
  assert.equal(db.claim(call.id), false);
  db.update(call.id, { status: 'completed' });
  db.update(call.id, { status: 'active' });
  assert.equal(db.call(call.id)?.status, 'completed');
  assert.throws(() => db.setOutcome(call.id, 'confirmed', 'Yes'), /not active/);
  db.close();
});
test('PCM conversion is continuous across split chunks and emits bounded Exotel frames', () => {
  const data = Buffer.alloc(9600);
  for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(Math.sin(i / 16) * 10000), i * 2);
  const full = new PcmResampler(24000, 16000).push(data);
  const split = new PcmResampler(24000, 16000);
  const pieces = [split.push(data.subarray(0, 2000)), split.push(data.subarray(2000, 5100)), split.push(data.subarray(5100))];
  assert.deepEqual(Buffer.concat(pieces), full);
  const frames: Buffer[] = [];
  const framer = new ExotelAudioFrames(frame => frames.push(frame));
  framer.push(full); framer.finish();
  assert.ok(frames.length >= 2);
  assert.ok(frames.every(frame => frame.length === 3200));
  assert.deepEqual(Buffer.concat(frames).subarray(0, full.length), full);
  assert.throws(() => decodeAudio('not-valid!'));
  assert.throws(() => decodeAudio(Buffer.from([1]).toString('base64')));
});
test('provider status maps no-answer and rejects unrecognized statuses', () => {
  assert.equal(providerStatus('no-answer'), 'no_answer');
  assert.equal(providerStatus('completed'), 'completed');
  assert.equal(providerStatus('made-up-state'), null);
});
