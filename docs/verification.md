# Verification record

## Gates

`npm run check` executes repository/static checks, 15 deterministic unit/HTTP tests, and
`npm audit --audit-level=high`.

With `DATABASE_URL` bound to PostgreSQL 17.6, `npm run check:ci` additionally executes:

1. 9 real database tests for interval constraints, concurrent publish/follow convergence, frozen push/pull mode, concurrent
   `SKIP LOCKED` claims, lease recovery, exact-token fencing, and read-time visibility;
2. pagination counterexamples showing that an old session excludes a concurrent post while a fresh session includes it, and
   that deletion removes an old-session candidate;
3. an authenticated API plus child-worker smoke that commits one non-final fanout chunk, kills the worker with `SIGKILL`, waits
   for lease expiry, recovers through attempt 2, and explicitly rejects the old token;
4. a bounded PostgreSQL observation for acceptance, chunk fanout, and hybrid session creation. Final state is asserted, but a
   shared-runner timing number is never a pass/fail capacity target.

No test is allowed to skip. CI runs the locked gate on Node 22, 24, and 26 with PostgreSQL 17.6.

## Public evidence on 2026-08-19

- SQL type-correction commit `418c64492ebadab4e3ae8f3a2c35e971590fae3a` passed public
  [CI run 32164944947](https://github.com/estelledc/system-design-11-news-feed-system/actions/runs/32164944947) on
  Node 22.23.2, 24.19.0, and 26.7.0, each against PostgreSQL 17.6.
- Every matrix job passed 15 deterministic unit/HTTP tests and 9 real PostgreSQL tests with 0 skipped. The locked install and
  explicit high-or-greater dependency audit each reported 0 known vulnerabilities.
- Every runtime smoke durably accepted the API post, committed one non-final chunk, killed the worker with `SIGKILL`, recovered
  through attempt 2, converged to exactly 5 materialized entries for 5 eligible followers, and rejected the stale token. Fresh
  reads hid the post after unfollow and deletion; seeded raw identities were absent from child logs; screen-display claims were
  explicitly 0.
- The bounded observations used 100 sequential post/job acceptances, one 200-follower fanout in chunks of 50, and 20 session
  creations merging 40 candidates each. Acceptance rates were 324, 368, and 355 transactions/second; fanout rates were 1,757,
  2,028, and 1,927 followers/second; session rates were 43, 48, and 44 sessions/second across the three shared runners. These are
  raw observations, not thresholds or capacity claims.

The first public [CI run 32164851359](https://github.com/estelledc/system-design-11-news-feed-system/actions/runs/32164851359)
is intentionally retained as a red receipt. All three runtimes passed 15 pure tests and 7 of 9 PostgreSQL tests, then PostgreSQL
rejected one repeated query parameter because assignment inferred `varchar` while a `CASE` comparison inferred `text`
(`SQLSTATE 42P08`). Commit `418c644` explicitly casts that parameter without changing fanout behavior. The next run passed 9 of
9 and continued through the crash smoke and benchmark.

## Evidence boundary

Passing every gate does not prove:

- screen display, human reading, engagement, relevance, fairness, notification, or exactly-once user-visible delivery;
- real identity-provider behavior, private-account approval, blocks, mutes, moderation, abuse prevention, or legal erasure;
- media upload/transcoding, search, ranking, ads, analytics, or downstream event consumption;
- PostgreSQL power-loss durability, backup/restore, failover, replication, vacuum/retention at load, partitioning, multi-region
  behavior, production capacity, deployment, SLA, or external acceptance.

The process-kill smoke proves one application crash boundary against one PostgreSQL service. It does not simulate host power
loss or storage failure. The benchmark excludes internet clients, media, ranking, replication, failover, multiple workers, and
multi-region network latency.

## Reproduce

```sh
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://... npm run check:ci
```
