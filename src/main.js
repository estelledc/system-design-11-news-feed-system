import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Pool } from 'pg';
import {
  CursorCodec,
  FanoutWorker,
  FeedService,
  PostgresFeedStore,
  ValidationError,
  createHttpServer,
  normalizeUserId,
} from './index.js';

function parseJsonEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationError(`${name} must contain valid JSON`);
  }
}

function parseIntegerEnvironment(name, fallback, { min, max = Number.MAX_SAFE_INTEGER }) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function authTokenMap() {
  const records = parseJsonEnvironment('AUTH_TOKENS_JSON', []);
  if (!Array.isArray(records) || records.length < 1) throw new ValidationError('AUTH_TOKENS_JSON must be a nonempty array');
  const result = new Map();
  for (const record of records) {
    if (!record || typeof record.token !== 'string' || record.token.length < 16 || record.token.length > 256) {
      throw new ValidationError('each auth token must contain 16-256 characters');
    }
    const userId = normalizeUserId(record.userId);
    if (result.has(record.token) && result.get(record.token) !== userId) {
      throw new ValidationError('one auth token cannot map to multiple users');
    }
    result.set(record.token, userId);
  }
  return result;
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new ValidationError('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 24 });
  const store = new PostgresFeedStore(pool);
  const command = process.argv[2] ?? 'serve';
  let keepPoolOpen = false;
  try {
    await store.migrate();
    if (command === 'migrate') {
      process.stdout.write(`${JSON.stringify({ kind: 'migration_complete' })}\n`);
      return;
    }
    if (command === 'stats') {
      process.stdout.write(`${JSON.stringify({ kind: 'feed_stats', ...(await store.stats()) })}\n`);
      return;
    }
    if (command === 'work-once') {
      const worker = new FanoutWorker({
        store,
        workerId: process.env.WORKER_ID ?? `worker-${randomUUID()}`,
        leaseMs: parseIntegerEnvironment('LEASE_MS', 30_000, { min: 1 }),
        crashCooldownMs: parseIntegerEnvironment('CRASH_COOLDOWN_MS', 10_000, { min: 0 }),
        chunkSize: parseIntegerEnvironment('FANOUT_CHUNK_SIZE', 100, { min: 1, max: 500 }),
        maxChunksPerRun: parseIntegerEnvironment('MAX_CHUNKS_PER_RUN', 100, { min: 1, max: 100 }),
        afterChunk: async ({ chunkIndex, result }) => {
          if (process.env.CRASH_AFTER_FIRST_CHUNK === '1' && chunkIndex === 1 && !result.completed) {
            process.kill(process.pid, 'SIGKILL');
          }
        },
      });
      const result = await worker.runOne();
      process.stdout.write(`${JSON.stringify({ kind: 'fanout_worker_receipt', ...result })}\n`);
      return;
    }
    if (command !== 'serve') throw new ValidationError('command must be migrate, serve, stats, or work-once');

    const authTokens = authTokenMap();
    await store.ensureUsers([...authTokens.values()], Date.now());
    const cursorCodec = new CursorCodec({ secret: process.env.CURSOR_HMAC_SECRET });
    const service = new FeedService({
      store,
      cursorCodec,
      hotFollowerThreshold: parseIntegerEnvironment('HOT_FOLLOWER_THRESHOLD', 10_000, { min: 1 }),
      sessionTtlMs: parseIntegerEnvironment('SESSION_TTL_MS', 300_000, { min: 1, max: 86_400_000 }),
      sessionCandidateLimit: parseIntegerEnvironment('SESSION_CANDIDATE_LIMIT', 500, { min: 1, max: 500 }),
    });
    const server = createHttpServer({
      service,
      authTokens,
      health: () => store.ping(),
      logger: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
    });
    const host = process.env.HOST ?? '127.0.0.1';
    const port = parseIntegerEnvironment('PORT', 3000, { min: 0, max: 65_535 });
    server.listen(port, host);
    await once(server, 'listening');
    process.stdout.write(`${JSON.stringify({ kind: 'api_listening', port: server.address().port })}\n`);

    const shutdown = async () => {
      server.close();
      await once(server, 'close');
      await pool.end();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    keepPoolOpen = true;
  } finally {
    if (!keepPoolOpen) await pool.end();
  }
}

run().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    kind: 'fatal',
    name: error?.name ?? 'Error',
    code: error?.code ?? 'internal_error',
  })}\n`);
  process.exitCode = 1;
});
