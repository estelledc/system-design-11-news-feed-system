import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import {
  CursorCodec,
  FeedService,
  LeaseLostError,
  PostgresFeedStore,
  RequestConflictError,
} from '../../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for PostgreSQL integration tests');

let pool;
let store;
let service;
let nowMs;

before(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 32 });
  store = new PostgresFeedStore(pool);
  await store.migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE
    feed_session_entries,
    feed_sessions,
    feed_entries,
    fanout_attempts,
    fanout_jobs,
    posts,
    follow_relations,
    author_states,
    users`);
  nowMs = 1_000;
  await store.ensureUsers([
    'author-a', 'author-b', 'viewer-a', 'viewer-b',
    'follower-01', 'follower-02', 'follower-03', 'follower-04', 'follower-05',
  ], nowMs);
  service = new FeedService({
    store,
    cursorCodec: new CursorCodec({
      secret: 'integration-cursor-secret-that-is-at-least-32-bytes',
      clock: () => nowMs,
    }),
    clock: () => nowMs,
    hotFollowerThreshold: 10,
  });
});

after(async () => {
  await pool.end();
});

test('relationship interval constraint rejects a half-ended generation', async () => {
  await assert.rejects(pool.query(
    `INSERT INTO follow_relations (
       follower_id, author_id, generation, started_version, ended_version, followed_at_ms
     ) VALUES ($1, $2, 1, 1, 2, $3)`,
    ['viewer-a', 'author-a', nowMs],
  ), (error) => error.code === '23514');
});

async function publish(key, content = key, authorId = 'author-a') {
  return service.publish({ authorId, idempotencyKey: key, request: { content } });
}

async function finishOnlyJob({ chunkSize = 100 } = {}) {
  const leaseToken = randomUUID();
  const job = await store.claimFanoutJob({
    nowMs,
    leaseMs: 10_000,
    crashCooldownMs: 0,
    leaseToken,
    workerId: 'worker-finish',
  });
  assert.ok(job);
  let result;
  do {
    result = await store.processFanoutChunk({
      postId: job.postId,
      leaseToken,
      nowMs,
      leaseMs: 10_000,
      chunkSize,
    });
  } while (!result.completed);
  return result;
}

test('concurrent follow replay converges and refollow creates a new generation', async () => {
  const results = await Promise.all(Array.from({ length: 16 }, () => service.setFollow({
    followerId: 'viewer-a', authorId: 'author-a', active: true,
  })));
  assert.equal(results.filter((result) => result.changed).length, 1);
  assert.ok(results.every((result) => result.active && result.generation === 1));
  const state = await pool.query(
    'SELECT active_follower_count, audience_version FROM author_states WHERE author_id = $1',
    ['author-a'],
  );
  assert.deepEqual(state.rows[0], { active_follower_count: 1, audience_version: '1' });

  nowMs = 1_001;
  const unfollow = await service.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: false });
  nowMs = 1_002;
  const refollow = await service.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: true });
  assert.equal(unfollow.generation, 1);
  assert.equal(refollow.generation, 2);
  const relations = await pool.query(
    `SELECT generation, started_version, ended_version
     FROM follow_relations ORDER BY generation`,
  );
  assert.deepEqual(relations.rows, [
    { generation: '1', started_version: '1', ended_version: '2' },
    { generation: '2', started_version: '3', ended_version: null },
  ]);
});

test('concurrent publish replay is immutable and fanout mode is frozen atomically', async () => {
  await service.setFollow({ followerId: 'follower-01', authorId: 'author-a', active: true });
  await service.setFollow({ followerId: 'follower-02', authorId: 'author-a', active: true });
  const results = await Promise.all(Array.from({ length: 16 }, () => (
    publish('concurrent-publish-key-001', 'same content')
  )));
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.post.id)).size, 1);
  assert.ok(results.every((result) => result.post.fanoutMode === 'push'));
  await assert.rejects(publish('concurrent-publish-key-001', 'changed content'), RequestConflictError);
  const counts = await pool.query(`SELECT
    (SELECT count(*)::integer FROM posts) AS posts,
    (SELECT count(*)::integer FROM fanout_jobs) AS jobs`);
  assert.deepEqual(counts.rows[0], { posts: 1, jobs: 1 });

  await service.setFollow({ followerId: 'follower-03', authorId: 'author-a', active: true });
  const hotService = new FeedService({
    store,
    cursorCodec: new CursorCodec({ secret: 'hot-mode-secret-that-is-at-least-32-bytes', clock: () => nowMs }),
    clock: () => nowMs,
    hotFollowerThreshold: 3,
  });
  const pull = await hotService.publish({
    authorId: 'author-a',
    idempotencyKey: 'pull-publish-key-00001',
    request: { content: 'pull post' },
  });
  assert.equal(pull.post.fanoutMode, 'pull');
  const jobCount = await pool.query('SELECT count(*)::integer AS count FROM fanout_jobs');
  assert.equal(jobCount.rows[0].count, 1);
});

test('SKIP LOCKED leases distinct fanout jobs to concurrent workers', async () => {
  await publish('queue-publish-key-0001', 'one', 'author-a');
  await publish('queue-publish-key-0002', 'two', 'author-b');
  const jobs = await Promise.all([0, 1].map((index) => store.claimFanoutJob({
    nowMs,
    leaseMs: 10_000,
    crashCooldownMs: 0,
    leaseToken: randomUUID(),
    workerId: `worker-${index}`,
  })));
  assert.equal(new Set(jobs.map((job) => job.postId)).size, 2);
  assert.ok(jobs.every((job) => job.attempt === 1));
  assert.equal(await store.claimFanoutJob({
    nowMs,
    leaseMs: 10_000,
    crashCooldownMs: 0,
    leaseToken: randomUUID(),
    workerId: 'worker-extra',
  }), null);
});

test('committed chunk survives lease expiry and the successor fences the stale token', async () => {
  for (let index = 1; index <= 5; index += 1) {
    await service.setFollow({
      followerId: `follower-0${index}`, authorId: 'author-a', active: true,
    });
  }
  const created = await publish('crash-fanout-key-0001', 'crash window');
  const firstToken = randomUUID();
  const first = await store.claimFanoutJob({
    nowMs,
    leaseMs: 100,
    crashCooldownMs: 0,
    leaseToken: firstToken,
    workerId: 'worker-first',
  });
  nowMs = 1_001;
  const firstChunk = await store.processFanoutChunk({
    postId: first.postId,
    leaseToken: firstToken,
    nowMs,
    leaseMs: 100,
    chunkSize: 2,
  });
  assert.deepEqual({ scanned: firstChunk.scanned, inserted: firstChunk.inserted, completed: firstChunk.completed }, {
    scanned: 2, inserted: 2, completed: false,
  });

  nowMs = 1_101;
  const secondToken = randomUUID();
  const second = await store.claimFanoutJob({
    nowMs,
    leaseMs: 100,
    crashCooldownMs: 0,
    leaseToken: secondToken,
    workerId: 'worker-second',
  });
  assert.equal(second.postId, created.post.id);
  assert.equal(second.attempt, 2);
  await assert.rejects(store.processFanoutChunk({
    postId: first.postId,
    leaseToken: firstToken,
    nowMs,
    leaseMs: 100,
    chunkSize: 2,
  }), LeaseLostError);

  let recovered;
  do {
    nowMs += 1;
    recovered = await store.processFanoutChunk({
      postId: second.postId,
      leaseToken: secondToken,
      nowMs,
      leaseMs: 100,
      chunkSize: 2,
    });
  } while (!recovered.completed);
  const entries = await pool.query('SELECT count(*)::integer AS count FROM feed_entries');
  assert.equal(entries.rows[0].count, 5);
  const attempts = await pool.query(
    `SELECT attempt_no, outcome, chunks_committed, followers_scanned
     FROM fanout_attempts ORDER BY attempt_no`,
  );
  assert.deepEqual(attempts.rows, [
    { attempt_no: 1, outcome: 'lease_expired_unknown', chunks_committed: 1, followers_scanned: 2 },
    { attempt_no: 2, outcome: 'completed', chunks_committed: 2, followers_scanned: 3 },
  ]);
});

test('unfollow and refollow never revive a stale materialized generation', async () => {
  await service.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: true });
  const old = await publish('old-generation-key-001', 'old generation');
  nowMs = 1_001;
  await service.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: false });
  await finishOnlyJob();
  let page = await service.getFeed({ viewerId: 'viewer-a' });
  assert.deepEqual(page.items, []);

  nowMs = 1_002;
  await service.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: true });
  page = await service.getFeed({ viewerId: 'viewer-a' });
  assert.deepEqual(page.items, []);
  const stale = await pool.query('SELECT follow_generation FROM feed_entries WHERE post_id = $1', [old.post.id]);
  assert.equal(stale.rows[0].follow_generation, '1');

  nowMs = 1_003;
  const current = await publish('new-generation-key-001', 'new generation');
  await finishOnlyJob();
  page = await service.getFeed({ viewerId: 'viewer-a' });
  assert.deepEqual(page.items.map((item) => item.id), [current.post.id]);
  nowMs = 1_004;
  await service.deletePost({ authorId: 'author-a', postId: current.post.id });
  page = await service.getFeed({ viewerId: 'viewer-a' });
  assert.deepEqual(page.items, []);
});

test('hot-author pull is immediate for the current generation but does not backfill a later follow', async () => {
  const hotService = new FeedService({
    store,
    cursorCodec: new CursorCodec({ secret: 'pull-session-secret-that-is-at-least-32-bytes', clock: () => nowMs }),
    clock: () => nowMs,
    hotFollowerThreshold: 1,
  });
  await hotService.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: true });
  const post = await hotService.publish({
    authorId: 'author-a', idempotencyKey: 'hot-publish-key-00001', request: { content: 'hot' },
  });
  assert.equal(post.post.fanoutMode, 'pull');
  assert.deepEqual((await hotService.getFeed({ viewerId: 'viewer-a' })).items.map((item) => item.id), [post.post.id]);

  nowMs = 1_001;
  await hotService.setFollow({ followerId: 'viewer-b', authorId: 'author-a', active: true });
  assert.deepEqual((await hotService.getFeed({ viewerId: 'viewer-b' })).items, []);
  const jobs = await pool.query('SELECT count(*)::integer AS count FROM fanout_jobs');
  assert.equal(jobs.rows[0].count, 0);
});

test('a persisted feed session excludes concurrent posts while a fresh session sees them', async () => {
  const hotService = new FeedService({
    store,
    cursorCodec: new CursorCodec({ secret: 'stable-session-secret-that-is-at-least-32-bytes', clock: () => nowMs }),
    clock: () => nowMs,
    hotFollowerThreshold: 1,
  });
  await hotService.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: true });
  const first = await hotService.publish({
    authorId: 'author-a', idempotencyKey: 'session-publish-key-001', request: { content: 'first' },
  });
  nowMs = 1_001;
  const second = await hotService.publish({
    authorId: 'author-a', idempotencyKey: 'session-publish-key-002', request: { content: 'second' },
  });
  const pageOne = await hotService.getFeed({ viewerId: 'viewer-a', limit: 1 });
  assert.deepEqual(pageOne.items.map((item) => item.id), [second.post.id]);
  assert.ok(pageOne.nextCursor);

  nowMs = 1_002;
  const concurrent = await hotService.publish({
    authorId: 'author-a', idempotencyKey: 'session-publish-key-003', request: { content: 'concurrent' },
  });
  const oldPageTwo = await hotService.getFeed({ viewerId: 'viewer-a', cursor: pageOne.nextCursor, limit: 1 });
  assert.deepEqual(oldPageTwo.items.map((item) => item.id), [first.post.id]);
  const fresh = await hotService.getFeed({ viewerId: 'viewer-a', limit: 1 });
  assert.deepEqual(fresh.items.map((item) => item.id), [concurrent.post.id]);
});

test('deletion after page one removes the item from the old session', async () => {
  const hotService = new FeedService({
    store,
    cursorCodec: new CursorCodec({ secret: 'privacy-session-secret-that-is-at-least-32-bytes', clock: () => nowMs }),
    clock: () => nowMs,
    hotFollowerThreshold: 1,
  });
  await hotService.setFollow({ followerId: 'viewer-a', authorId: 'author-a', active: true });
  const older = await hotService.publish({
    authorId: 'author-a', idempotencyKey: 'privacy-publish-key-01', request: { content: 'older' },
  });
  nowMs = 1_001;
  await hotService.publish({
    authorId: 'author-a', idempotencyKey: 'privacy-publish-key-02', request: { content: 'newer' },
  });
  const pageOne = await hotService.getFeed({ viewerId: 'viewer-a', limit: 1 });
  nowMs = 1_002;
  await hotService.deletePost({ authorId: 'author-a', postId: older.post.id });
  const pageTwo = await hotService.getFeed({ viewerId: 'viewer-a', cursor: pageOne.nextCursor, limit: 1 });
  assert.deepEqual(pageTwo.items, []);
  assert.equal(pageTwo.nextCursor, null);
});
