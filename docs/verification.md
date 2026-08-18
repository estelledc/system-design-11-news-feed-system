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

## Public evidence

No public implementation run is claimed in this initial record. Exact commits, run links, test counts, runtime versions, crash
receipt fields, and raw benchmark observations are added only after the remote run completes. A green syntax/unit result does
not substitute for the real PostgreSQL gate.

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
