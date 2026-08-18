import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ValidationError,
  canonicalJson,
  normalizeIdempotencyKey,
  normalizePageLimit,
  normalizePostRequest,
  normalizeUserId,
  sha256,
} from '../../src/index.js';

test('canonical JSON ignores object insertion order and preserves array order', () => {
  const left = { z: 1, nested: { b: 'two', a: 'one' }, list: ['a', 'b'] };
  const right = { list: ['a', 'b'], nested: { a: 'one', b: 'two' }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256(left), sha256(right));
  assert.notEqual(sha256(left), sha256({ ...right, list: ['b', 'a'] }));
});

test('post input preserves exact text while bounding shape and UTF-8 bytes', () => {
  assert.deepEqual(normalizePostRequest({ content: '  exact text  ' }), { content: '  exact text  ' });
  assert.throws(() => normalizePostRequest({ content: '   ' }), ValidationError);
  assert.throws(() => normalizePostRequest({ content: 'ok', media: [] }), ValidationError);
  assert.throws(() => normalizePostRequest({ content: '你'.repeat(1_366) }), ValidationError);
});

test('user, idempotency, and page contracts reject ambiguous inputs', () => {
  assert.equal(normalizeUserId('user-001'), 'user-001');
  assert.equal(normalizeIdempotencyKey('publish-key-000001'), 'publish-key-000001');
  assert.equal(normalizePageLimit(undefined), 20);
  assert.equal(normalizePageLimit('50'), 50);
  assert.throws(() => normalizeUserId('user id'), ValidationError);
  assert.throws(() => normalizeIdempotencyKey('short'), ValidationError);
  assert.throws(() => normalizePageLimit('1.5'), ValidationError);
  assert.throws(() => normalizePageLimit('51'), ValidationError);
});
