import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorCodec, ValidationError } from '../../src/index.js';

const secret = 'cursor-test-secret-that-is-at-least-32-bytes';
const sessionId = '11111111-1111-4111-8111-111111111111';

test('cursor round-trips a bounded versioned session position', () => {
  const codec = new CursorCodec({ secret, clock: () => 1_000 });
  const token = codec.encode({ sessionId, position: 17, expiresAtMs: 10_000 });
  assert.deepEqual(codec.decode(token), { sessionId, position: 17, expiresAtMs: 10_000 });
  assert.equal(token.split('.').length, 2);
});

test('cursor rejects tampering, expiry, aliases, and weak secrets', () => {
  const codec = new CursorCodec({ secret, clock: () => 1_000 });
  const token = codec.encode({ sessionId, position: 1, expiresAtMs: 2_000 });
  const [payload, signature] = token.split('.');
  const changedLastCharacter = payload.at(-1) === 'A' ? 'B' : 'A';
  assert.throws(() => codec.decode(`${payload.slice(0, -1)}${changedLastCharacter}.${signature}`), ValidationError);
  assert.throws(() => codec.decode(`${payload}.${signature}=`), ValidationError);
  assert.throws(() => new CursorCodec({ secret: 'too-short' }), ValidationError);
  assert.throws(() => new CursorCodec({ secret, clock: () => 2_000 }).decode(token), ValidationError);
});

test('cursor field contract rejects validly signed unsupported payloads', () => {
  const codec = new CursorCodec({ secret, clock: () => 1_000 });
  assert.throws(() => codec.encode({ sessionId, position: 501, expiresAtMs: 10_000 }), ValidationError);
  assert.throws(() => codec.encode({ sessionId: 'not-a-uuid', position: 0, expiresAtMs: 10_000 }), ValidationError);
});
