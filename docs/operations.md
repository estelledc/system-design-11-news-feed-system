# Operations runbook

## Development startup

```sh
docker compose up -d postgres
npm ci --ignore-scripts
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/news_feed
node src/main.js migrate
```

The Compose password and exposed port are local fixtures. Do not reuse them on a shared or public host.

## Commands

| Command | Effect |
|---|---|
| `node src/main.js migrate` | applies idempotent schema DDL |
| `node src/main.js serve` | starts the authenticated API |
| `node src/main.js work-once` | claims at most one job and processes a bounded number of chunks |
| `node src/main.js stats` | emits aggregate post, job, entry, session, and attempt counts |
| `npm run check` | static checks, pure tests, and dependency audit |
| `npm run check:ci` | full gate including real PostgreSQL, crash smoke, and benchmark |

## Runtime configuration

| Variable | Default | Boundary |
|---|---:|---|
| `AUTH_TOKENS_JSON` | required by API | nonempty fixture records; tokens are 16–256 characters |
| `CURSOR_HMAC_SECRET` | required by API | 32–256 bytes; rotation is not implemented |
| `HOT_FOLLOWER_THRESHOLD` | 10000 | integer at least 1; frozen into each accepted post |
| `SESSION_TTL_MS` | 300000 | 1–86400000 milliseconds |
| `SESSION_CANDIDATE_LIMIT` | 500 | 1–500 |
| `LEASE_MS` | 30000 | positive integer; must exceed a normal chunk transaction |
| `CRASH_COOLDOWN_MS` | 10000 | delay before an expired lease becomes claimable |
| `FANOUT_CHUNK_SIZE` | 100 | 1–500 followers |
| `MAX_CHUNKS_PER_RUN` | 100 | 1–100; yielding consumes an attempt |

Run multiple `work-once` processes through an external scheduler if desired. `SKIP LOCKED` prevents the same current job claim,
while the UUID lease token fences later mutations. There is no built-in daemon, autoscaler, or scheduler.

## Aggregate inspection

`stats` intentionally emits counts rather than identities. Investigate these states:

- growing `pending`/`retry`: workers absent, transactions slow, or capacity insufficient;
- `leased` older than the configured lease: the next claim pass will classify it and enforce attempt budget;
- `dead`: manual diagnosis is required before any operator-authored retry policy;
- `lease_expired_unknown`: a worker did not finish its database receipt; replay resumes after the durable cursor;
- rapidly growing sessions: clean expired session state and investigate abusive first-page requests.

The application does not run retention automatically. A bounded maintenance task may delete expired sessions; foreign-key
cascade removes their session entries:

```sql
DELETE FROM feed_sessions
WHERE expires_at_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
```

Post, relationship, attempt, and candidate retention needs a product/legal policy and is therefore not guessed here. A
tombstoned post being hidden is not proof that its stored content has been erased.

## Recovery boundaries

- Restarting the API is safe after PostgreSQL recovers; clients retry publish with the same author-scoped idempotency key.
- Restarting workers is safe for database convergence. The next claim pass recovers expired leases and resumes after the
  committed follower cursor.
- Do not manually clear lease tokens or rewrite attempt rows. That destroys the fencing and receipt evidence.
- Restore, replication promotion, power-loss durability, and cross-region recovery are untested. Run dedicated backup/restore
  and failover drills before making those claims.
