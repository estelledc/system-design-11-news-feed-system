import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as scheduleTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { LeaseLostError, PostgresFeedStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for the PostgreSQL runtime smoke');

const authorToken = 'runtime-author-token-00001';
const followerTokens = Array.from({ length: 5 }, (_, index) => `runtime-follower-token-000${index + 1}`);
const authorId = 'runtime-author';
const followerIds = Array.from({ length: 5 }, (_, index) => `runtime-follower-0${index + 1}`);
const cursorSecret = 'runtime-cursor-secret-that-is-at-least-32-bytes';
const postContent = 'Runtime fanout crash evidence';
const publishKey = 'runtime-publish-key-0001';
const identities = [authorToken, ...followerTokens, authorId, ...followerIds, cursorSecret, postContent, publishKey];

function captureChild(args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const deadline = new Promise((resolve, reject) => {
    timeout = scheduleTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function waitForExit(processRecord, timeoutMs = 10_000) {
  return withTimeout(once(processRecord.child, 'exit'), timeoutMs, 'child process exit timed out');
}

async function startApi() {
  const authRecords = [
    { token: authorToken, userId: authorId },
    ...followerTokens.map((token, index) => ({ token, userId: followerIds[index] })),
  ];
  const processRecord = captureChild(['src/main.js', 'serve'], {
    AUTH_TOKENS_JSON: JSON.stringify(authRecords),
    CURSOR_HMAC_SECRET: cursorSecret,
    DATABASE_URL: databaseUrl,
    HOT_FOLLOWER_THRESHOLD: '10',
    PORT: '0',
  });
  let observed = '';
  const listening = new Promise((resolve, reject) => {
    const inspect = (chunk) => {
      observed += chunk;
      for (const line of observed.split('\n')) {
        if (!line.includes('api_listening')) continue;
        processRecord.child.stdout.off('data', inspect);
        resolve(JSON.parse(line).port);
        return;
      }
    };
    processRecord.child.stdout.on('data', inspect);
    processRecord.child.once('exit', (code, signal) => {
      reject(new Error(`API exited before listening: code=${code} signal=${signal}`));
    });
  });
  const port = await withTimeout(listening, 10_000, 'API start timed out');
  return { ...processRecord, port };
}

async function stopApi(processRecord) {
  const exit = waitForExit(processRecord);
  processRecord.child.kill('SIGTERM');
  const [code, signal] = await exit;
  assert.equal(code, 0);
  assert.equal(signal, null);
}

async function runWorker({ crash, name }) {
  const processRecord = captureChild(['src/main.js', 'work-once'], {
    CRASH_AFTER_FIRST_CHUNK: crash ? '1' : '0',
    CRASH_COOLDOWN_MS: '0',
    DATABASE_URL: databaseUrl,
    FANOUT_CHUNK_SIZE: '2',
    LEASE_MS: '250',
    MAX_CHUNKS_PER_RUN: '10',
    WORKER_ID: name,
  });
  const [code, signal] = await waitForExit(processRecord);
  return { ...processRecord, code, signal };
}

async function authorizedFetch(origin, token, path, options = {}) {
  return fetch(`${origin}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}

const pool = new Pool({ connectionString: databaseUrl, max: 16 });
const store = new PostgresFeedStore(pool);
await store.migrate();
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
const version = await pool.query('SHOW server_version');
const childLogs = [];

const api = await startApi();
for (let index = 0; index < followerIds.length; index += 1) {
  const followed = await authorizedFetch(api.port ? `http://127.0.0.1:${api.port}` : '', followerTokens[index], `/v1/follows/${authorId}`, {
    method: 'PUT',
  });
  assert.equal(followed.status, 200);
}
const origin = `http://127.0.0.1:${api.port}`;
const published = await authorizedFetch(origin, authorToken, '/v1/posts', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': publishKey },
  body: JSON.stringify({ content: postContent }),
});
assert.equal(published.status, 201);
const post = (await published.json()).post;
assert.equal(post.fanoutMode, 'push');

const crashed = await runWorker({ crash: true, name: 'worker-runtime-crash' });
assert.equal(crashed.code, null);
assert.equal(crashed.signal, 'SIGKILL');
childLogs.push(crashed.stdout(), crashed.stderr());
const firstAttempt = await pool.query(
  'SELECT lease_token FROM fanout_attempts WHERE post_id = $1 AND attempt_no = 1',
  [post.id],
);
assert.ok(firstAttempt.rows[0]?.lease_token);
const lease = await pool.query('SELECT leased_until_ms FROM fanout_jobs WHERE post_id = $1', [post.id]);
const remaining = Number(lease.rows[0].leased_until_ms) - Date.now();
if (remaining >= 0) await delay(remaining + 25);

const recovered = await runWorker({ crash: false, name: 'worker-runtime-recovery' });
assert.equal(recovered.code, 0);
assert.equal(recovered.signal, null);
assert.match(recovered.stdout(), /"kind":"completed"/);
childLogs.push(recovered.stdout(), recovered.stderr());
await assert.rejects(store.processFanoutChunk({
  postId: post.id,
  leaseToken: firstAttempt.rows[0].lease_token,
  nowMs: Date.now(),
  leaseMs: 250,
  chunkSize: 2,
}), LeaseLostError);

for (let index = 0; index < followerIds.length; index += 1) {
  const feed = await authorizedFetch(origin, followerTokens[index], '/v1/feed?limit=10');
  assert.equal(feed.status, 200);
  const body = await feed.json();
  assert.deepEqual(body.items.map((item) => item.id), [post.id]);
}

const unfollowed = await authorizedFetch(origin, followerTokens[0], `/v1/follows/${authorId}`, { method: 'DELETE' });
assert.equal(unfollowed.status, 200);
const hiddenAfterUnfollow = await authorizedFetch(origin, followerTokens[0], '/v1/feed?limit=10');
assert.deepEqual((await hiddenAfterUnfollow.json()).items, []);
const deleted = await authorizedFetch(origin, authorToken, `/v1/posts/${post.id}`, { method: 'DELETE' });
assert.equal(deleted.status, 200);
const hiddenAfterDelete = await authorizedFetch(origin, followerTokens[1], '/v1/feed?limit=10');
assert.deepEqual((await hiddenAfterDelete.json()).items, []);

await stopApi(api);
childLogs.push(api.stdout(), api.stderr());
const stats = await store.stats();
assert.equal(stats.posts, 1);
assert.equal(stats.jobs.completed, 1);
assert.equal(stats.feedEntries, 5);
assert.equal(stats.attempts.lease_expired_unknown, 1);
assert.equal(stats.attempts.completed, 1);
const attempts = await pool.query(
  `SELECT attempt_no, outcome, chunks_committed, followers_scanned, rows_inserted
   FROM fanout_attempts ORDER BY attempt_no`,
);
assert.deepEqual(attempts.rows, [
  { attempt_no: 1, outcome: 'lease_expired_unknown', chunks_committed: 1, followers_scanned: 2, rows_inserted: 2 },
  { attempt_no: 2, outcome: 'completed', chunks_committed: 2, followers_scanned: 3, rows_inserted: 3 },
]);

const logs = childLogs.join('');
for (const identity of identities) assert.ok(!logs.includes(identity), 'child logs contained a seeded identity');
await pool.end();

process.stdout.write(`${JSON.stringify({
  kind: 'news_feed_fanout_crash_receipt',
  node: process.version,
  postgres: version.rows[0].server_version,
  apiPublishPersisted: true,
  forcedTermination: 'SIGKILL',
  firstAttemptCommittedChunks: 1,
  recoveredAttemptNumber: 2,
  eligibleFollowers: 5,
  uniqueMaterializedEntries: stats.feedEntries,
  staleTokenRejected: true,
  unfollowHiddenOnFreshSession: true,
  deleteHiddenOnFreshSession: true,
  screenDisplayClaims: 0,
  rawIdentityLogged: false,
  claimBoundary: 'one PostgreSQL 17.6 service, one API process, sequential fanout workers, child SIGKILL, and authenticated loopback HTTP; not browser rendering, engagement, power loss, failover, multi-region behavior, or production capacity',
})}\n`);
