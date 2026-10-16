import test from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyToken } from '../src/platform/security/tokens.js';

const secret = 'test-secret-that-is-at-least-32-characters';
test('signed tokens reject tampering, wrong purpose, and expiration', () => {
  const token = issueToken(secret, 'browser', 'call-123', 60);
  assert.equal(verifyToken(secret, token, 'browser'), 'call-123');
  assert.equal(verifyToken(secret, token, 'exotel-stream'), null);
  assert.equal(verifyToken(secret, `${token}a`, 'browser'), null);
  assert.equal(
    verifyToken(secret, issueToken(secret, 'browser', 'call', -1), 'browser'),
    null,
  );
});
