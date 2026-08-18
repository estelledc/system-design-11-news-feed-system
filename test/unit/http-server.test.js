import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import { createHttpServer } from '../../src/index.js';

const servers = [];

async function fixture(service, options = {}) {
  const logs = [];
  const server = createHttpServer({
    service,
    authTokens: new Map([['test-auth-token-0001', 'viewer-a']]),
    logger: (record) => logs.push(record),
    ...options,
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, logs };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

test('HTTP boundary authenticates publish and maps create versus replay status', async () => {
  const calls = [];
  const service = {
    async publish(input) {
      calls.push(input);
      return {
        created: calls.length === 1,
        post: { id: 'post-1', fanoutMode: 'push' },
      };
    },
  };
  const { origin, logs } = await fixture(service);
  const request = () => fetch(`${origin}/v1/posts`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-auth-token-0001',
      'content-type': 'application/json',
      'idempotency-key': 'publish-key-000001',
    },
    body: JSON.stringify({ content: 'hello' }),
  });
  assert.equal((await request()).status, 201);
  assert.equal((await request()).status, 200);
  assert.equal(calls[0].authorId, 'viewer-a');
  assert.equal(logs[0].kind, 'post_intake');
  assert.ok(!JSON.stringify(logs).includes('test-auth-token-0001'));
  assert.ok(!JSON.stringify(logs).includes('hello'));
});

test('HTTP boundary routes follow, delete, and feed without accepting duplicate query fields', async () => {
  const calls = [];
  const service = {
    async setFollow(input) { calls.push(input); return { active: input.active, changed: true }; },
    async deletePost(input) { calls.push(input); return { deleted: true }; },
    async getFeed(input) { calls.push(input); return { items: [], candidateCount: 0, nextCursor: null }; },
  };
  const { origin } = await fixture(service);
  const headers = { authorization: 'Bearer test-auth-token-0001' };
  assert.equal((await fetch(`${origin}/v1/follows/author-a`, { method: 'PUT', headers })).status, 200);
  assert.equal((await fetch(`${origin}/v1/follows/author-a`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(`${origin}/v1/posts/11111111-1111-4111-8111-111111111111`, {
    method: 'DELETE', headers,
  })).status, 200);
  assert.equal((await fetch(`${origin}/v1/feed?limit=10`, { headers })).status, 200);
  const invalid = await fetch(`${origin}/v1/feed?limit=10&limit=20`, { headers });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'invalid_request' });
  assert.equal(calls[0].active, true);
  assert.equal(calls[1].active, false);
});

test('HTTP boundary rejects unauthenticated and malformed requests with safe errors', async () => {
  const { origin, logs } = await fixture({
    async publish() { throw new Error('unexpected'); },
  }, { maximumBodyBytes: 32 });
  assert.equal((await fetch(`${origin}/v1/feed`)).status, 401);
  const malformed = await fetch(`${origin}/v1/posts`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-auth-token-0001',
      'content-type': 'application/json',
      'idempotency-key': 'publish-key-000001',
    },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_request' });
  assert.ok(logs.every((record) => !JSON.stringify(record).includes('publish-key-000001')));
});

test('health endpoint is unauthenticated and executes the dependency probe', async () => {
  let probes = 0;
  const { origin } = await fixture({}, { health: async () => { probes += 1; } });
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(probes, 1);
  assert.match(response.headers.get('cache-control'), /no-store/);
});
