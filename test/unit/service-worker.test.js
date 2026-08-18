import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CursorCodec,
  FanoutWorker,
  FeedService,
  ValidationError,
} from '../../src/index.js';

function uuidSequence() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(value += 1).padStart(12, '0')}`;
}

class ServiceStore {
  constructor() {
    this.accepted = null;
    this.follow = null;
    this.session = null;
  }

  async acceptPost(input) {
    this.accepted = input;
    return {
      created: true,
      post: {
        ...input,
        audienceCutoffVersion: 4,
        fanoutMode: 'push',
        followerCountSnapshot: 3,
        deletedAtMs: null,
      },
    };
  }

  async setFollow(input) {
    this.follow = input;
    return { active: input.active, changed: true, generation: 1, audienceVersion: 1 };
  }

  async deletePost(input) {
    return { deleted: true, deletedAtMs: input.nowMs };
  }

  async createFeedSession(input) {
    this.session = input;
    return { sessionId: input.sessionId, expiresAtMs: input.expiresAtMs, candidateCount: 2 };
  }

  async readFeedSession(input) {
    return {
      sessionId: input.sessionId,
      expiresAtMs: this.session?.expiresAtMs ?? 20_000,
      candidateCount: 2,
      items: [{ id: 'post-1', authorId: 'author-a', content: 'one', publishedAtMs: 9_000 }],
      nextPosition: input.position === 0 ? 1 : null,
    };
  }
}

function service(store = new ServiceStore()) {
  return new FeedService({
    store,
    cursorCodec: new CursorCodec({ secret: 'service-test-secret-that-is-at-least-32-bytes', clock: () => 10_000 }),
    clock: () => 10_000,
    uuid: uuidSequence(),
    hotFollowerThreshold: 10,
    sessionTtlMs: 10_000,
  });
}

test('publish freezes canonical identity inputs without claiming fanout completion', async () => {
  const store = new ServiceStore();
  const result = await service(store).publish({
    authorId: 'author-a',
    idempotencyKey: 'publish-key-000001',
    request: { content: 'hello' },
  });
  assert.equal(result.created, true);
  assert.equal(result.post.fanoutMode, 'push');
  assert.equal(store.accepted.requestDigest.length, 64);
  assert.equal(store.accepted.maxAttempts, 5);
  assert.equal(store.accepted.publishedAtMs, 10_000);
});

test('follow and delete contracts bind the authenticated actor', async () => {
  const store = new ServiceStore();
  const instance = service(store);
  await assert.rejects(instance.setFollow({ followerId: 'author-a', authorId: 'author-a', active: true }), ValidationError);
  const follow = await instance.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: true });
  assert.equal(follow.generation, 1);
  assert.equal(store.follow.nowMs, 10_000);
  const deleted = await instance.deletePost({
    authorId: 'author-a',
    postId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(deleted.deleted, true);
});

test('first feed page creates a bounded session and the signed cursor resumes it', async () => {
  const store = new ServiceStore();
  const instance = service(store);
  const first = await instance.getFeed({ viewerId: 'viewer-a', limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  assert.equal(store.session.candidateLimit, 500);
  const second = await instance.getFeed({ viewerId: 'viewer-a', cursor: first.nextCursor, limit: 1 });
  assert.equal(second.nextCursor, null);
});

class WorkerStore {
  constructor(results) {
    this.results = [...results];
    this.processed = [];
    this.yielded = [];
  }

  async claimFanoutJob(input) {
    return { postId: 'post-1', attempt: 2, leaseToken: input.leaseToken };
  }

  async processFanoutChunk(input) {
    this.processed.push(input);
    return this.results.shift();
  }

  async yieldFanoutJob(input) {
    this.yielded.push(input);
    return { kind: 'yielded' };
  }
}

test('fanout worker aggregates committed chunks until completion', async () => {
  const store = new WorkerStore([
    { scanned: 2, inserted: 2, completed: false },
    { scanned: 1, inserted: 1, completed: true },
  ]);
  const result = await new FanoutWorker({
    store,
    clock: () => 1_000,
    uuid: () => '22222222-2222-4222-8222-222222222222',
    workerId: 'worker-test',
    chunkSize: 2,
  }).runOne();
  assert.deepEqual(result, { kind: 'completed', attempt: 2, chunks: 2, scanned: 3, inserted: 3 });
  assert.equal(store.processed.length, 2);
});

test('fanout worker yields after the explicit chunk budget and rejects unsafe configuration', async () => {
  const store = new WorkerStore([{ scanned: 1, inserted: 1, completed: false }]);
  const result = await new FanoutWorker({
    store,
    clock: () => 1_000,
    uuid: () => '22222222-2222-4222-8222-222222222222',
    workerId: 'worker-test',
    maxChunksPerRun: 1,
  }).runOne();
  assert.equal(result.kind, 'yielded');
  assert.equal(store.yielded.length, 1);
  assert.throws(() => new FanoutWorker({ store, workerId: 'worker id', leaseMs: 1 }), ValidationError);
  assert.throws(() => new FanoutWorker({ store, workerId: 'worker-test', leaseMs: 0 }), ValidationError);
  assert.throws(() => new FanoutWorker({ store, workerId: 'worker-test', chunkSize: 501 }), ValidationError);
  assert.throws(() => new FeedService({
    store,
    cursorCodec: {},
    sessionTtlMs: 86_400_001,
  }), ValidationError);
});
