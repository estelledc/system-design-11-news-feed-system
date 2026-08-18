import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import {
  CursorCodec,
  FeedService,
  PostgresFeedStore,
} from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for the PostgreSQL benchmark');

function boundedEnvironmentInteger(name, fallback, { min, max }) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} is out of bounds`);
  return value;
}

const acceptancePosts = boundedEnvironmentInteger('BENCH_ACCEPTANCE_POSTS', 100, { min: 10, max: 1_000 });
const fanoutFollowers = boundedEnvironmentInteger('BENCH_FANOUT_FOLLOWERS', 200, { min: 10, max: 2_000 });
const feedPostsPerMode = boundedEnvironmentInteger('BENCH_FEED_POSTS_PER_MODE', 20, { min: 5, max: 25 });
const feedSessions = boundedEnvironmentInteger('BENCH_FEED_SESSIONS', 20, { min: 5, max: 100 });
const pool = new Pool({ connectionString: databaseUrl, max: 24 });
const store = new PostgresFeedStore(pool);
let logicalNow = 1_000_000;

const cursorSecret = 'benchmark-cursor-secret-that-is-at-least-32-bytes';
const service = (hotFollowerThreshold) => new FeedService({
  store,
  cursorCodec: new CursorCodec({ secret: cursorSecret, clock: () => logicalNow }),
  clock: () => {
    logicalNow += 1;
    return logicalNow;
  },
  hotFollowerThreshold,
});

async function truncate() {
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
}

async function drainOneJob({ chunkSize = 50 } = {}) {
  const worker = {
    nowMs: logicalNow += 1,
    leaseToken: randomUUID(),
  };
  const job = await store.claimFanoutJob({
    nowMs: worker.nowMs,
    leaseMs: 60_000,
    crashCooldownMs: 0,
    leaseToken: worker.leaseToken,
    workerId: 'benchmark-worker',
  });
  assert.ok(job, 'expected one fanout job');
  let result;
  do {
    worker.nowMs += 1;
    result = await store.processFanoutChunk({
      postId: job.postId,
      leaseToken: worker.leaseToken,
      nowMs: worker.nowMs,
      leaseMs: 60_000,
      chunkSize,
    });
  } while (!result.completed);
  logicalNow = worker.nowMs;
  return result;
}

function rate(count, durationMs) {
  return Math.round((count * 1_000_000) / durationMs) / 1_000;
}

async function benchmarkAcceptance() {
  await truncate();
  await store.ensureUsers(['acceptance-author'], logicalNow);
  const feed = service(10_000);
  const started = performance.now();
  for (let index = 0; index < acceptancePosts; index += 1) {
    const result = await feed.publish({
      authorId: 'acceptance-author',
      idempotencyKey: `acceptance-key-${String(index).padStart(6, '0')}`,
      request: { content: `post ${index}` },
    });
    assert.equal(result.created, true);
    assert.equal(result.post.fanoutMode, 'push');
  }
  const durationMs = performance.now() - started;
  const counts = await pool.query(`SELECT
    (SELECT count(*)::integer FROM posts) AS posts,
    (SELECT count(*)::integer FROM fanout_jobs) AS jobs`);
  assert.deepEqual(counts.rows[0], { posts: acceptancePosts, jobs: acceptancePosts });
  return { operations: acceptancePosts, durationMs, operationsPerSecond: rate(acceptancePosts, durationMs) };
}

async function benchmarkFanout() {
  await truncate();
  const followerIds = Array.from(
    { length: fanoutFollowers },
    (_, index) => `fanout-follower-${String(index).padStart(5, '0')}`,
  );
  await store.ensureUsers(['fanout-author', ...followerIds], logicalNow);
  const feed = service(fanoutFollowers + 1);
  for (const followerId of followerIds) {
    await feed.setFollow({ followerId, authorId: 'fanout-author', active: true });
  }
  const post = await feed.publish({
    authorId: 'fanout-author',
    idempotencyKey: 'fanout-benchmark-key-0001',
    request: { content: 'bounded fanout benchmark' },
  });
  assert.equal(post.post.fanoutMode, 'push');
  const started = performance.now();
  await drainOneJob();
  const durationMs = performance.now() - started;
  const entries = await pool.query('SELECT count(*)::integer AS count FROM feed_entries');
  assert.equal(entries.rows[0].count, fanoutFollowers);
  return {
    followers: fanoutFollowers,
    chunkSize: 50,
    durationMs,
    followersPerSecond: rate(fanoutFollowers, durationMs),
  };
}

async function benchmarkFeedSessions() {
  await truncate();
  const hotFollowers = ['feed-viewer', 'hot-follower-01', 'hot-follower-02', 'hot-follower-03', 'hot-follower-04'];
  await store.ensureUsers(['regular-author', 'hot-author', ...hotFollowers], logicalNow);
  const feed = service(5);
  await feed.setFollow({ followerId: 'feed-viewer', authorId: 'regular-author', active: true });
  for (const followerId of hotFollowers) {
    await feed.setFollow({ followerId, authorId: 'hot-author', active: true });
  }
  for (let index = 0; index < feedPostsPerMode; index += 1) {
    const regular = await feed.publish({
      authorId: 'regular-author',
      idempotencyKey: `regular-feed-key-${String(index).padStart(5, '0')}`,
      request: { content: `regular ${index}` },
    });
    const hot = await feed.publish({
      authorId: 'hot-author',
      idempotencyKey: `hot-feed-key-${String(index).padStart(9, '0')}`,
      request: { content: `hot ${index}` },
    });
    assert.equal(regular.post.fanoutMode, 'push');
    assert.equal(hot.post.fanoutMode, 'pull');
    await drainOneJob({ chunkSize: 10 });
  }
  const expectedCandidates = feedPostsPerMode * 2;
  const started = performance.now();
  for (let index = 0; index < feedSessions; index += 1) {
    const page = await feed.getFeed({ viewerId: 'feed-viewer', limit: 50 });
    assert.equal(page.items.length, expectedCandidates);
    assert.equal(new Set(page.items.map((item) => item.id)).size, expectedCandidates);
  }
  const durationMs = performance.now() - started;
  return {
    sessions: feedSessions,
    candidatesPerSession: expectedCandidates,
    durationMs,
    sessionsPerSecond: rate(feedSessions, durationMs),
  };
}

try {
  await store.migrate();
  const version = await pool.query('SHOW server_version');
  const acceptance = await benchmarkAcceptance();
  const fanout = await benchmarkFanout();
  const feed = await benchmarkFeedSessions();
  process.stdout.write(`${JSON.stringify({
    kind: 'news_feed_bounded_benchmark',
    node: process.version,
    postgres: version.rows[0].server_version,
    acceptance,
    fanout,
    feed,
    screenDisplayClaims: 0,
    capacityClaim: false,
    exclusions: [
      'internet clients',
      'media storage',
      'ranking',
      'replication',
      'failover',
      'multiple worker processes',
      'multi-region traffic',
    ],
  })}\n`);
} finally {
  await pool.end();
}
