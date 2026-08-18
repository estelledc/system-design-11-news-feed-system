# Evidence-first news feed

This repository turns a broad “news feed system” prompt into one executable question:

> After a post is durably accepted, what can a chronological following feed truthfully return across asynchronous fanout,
> hot authors, follow changes, deletion, pagination, and worker death?

The runnable answer uses PostgreSQL as one v0.1 authority. Regular-author posts fan out into materialized candidate rows. Posts
from authors at or above a frozen follower threshold are merged on read. Relationship generations and post tombstones remain
authoritative when a page is returned; an old inbox row is never treated as permission by itself.

## Business behavior

1. A user follows an author. Each refollow creates a new generation instead of reviving an old relationship.
2. Publishing commits an immutable post and, for a regular author, one fanout job in the same transaction. The response proves
   durable acceptance, not completed fanout or screen display.
3. A worker leases one job, copies a bounded follower chunk, and advances the exact-token cursor in one transaction. A stale
   worker cannot write after lease recovery.
4. A hot-author post skips per-follower materialization. Feed creation merges current pull candidates with materialized push
   candidates and removes duplicates.
5. The first page persists at most 500 ordered candidates in a five-minute session. Later pages cannot gain concurrent posts or
   late fanout, but an unfollow or deletion can still remove an old candidate immediately.

```text
publish API -> post + optional fanout job (one transaction)
                              |
                        leased worker
                              |
                    follower chunks + cursor
                              |
                     materialized candidates ----+
                                                   |
hot-author posts -------------------------------- merge -> bounded session -> signed cursor
                                                   |
                             current follow generation + tombstone recheck
```

The state model and crash windows are detailed in [architecture](docs/architecture.md).

## Scenario arithmetic

The repository's synthetic scenario assumes 10 million posts and 100 million feed reads per day. Those averages are about 116
posts/second and 1,157 reads/second; a declared 10x peak is about 1,160 and 11,574/second. At 200 materialized candidates per
regular post, fanout would produce 2 billion candidate writes/day. These numbers explain the hybrid design. They are not current
product facts, load-test results, or capacity claims.

## Run locally

Requirements: Node 22 or later and PostgreSQL 17.6. The Compose credential is development-only.

```sh
docker compose up -d postgres
npm ci --ignore-scripts
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/news_feed
npm run check:ci
```

The API and fanout worker are intentionally separate processes:

```sh
node src/main.js migrate
node src/main.js serve
node src/main.js work-once
node src/main.js stats
```

`serve` also requires `AUTH_TOKENS_JSON` and `CURSOR_HMAC_SECRET`. See the [API contract](docs/api.md) and
[operations runbook](docs/operations.md) before using the commands.

## Verification

`npm run check` performs static repository checks, 15 deterministic unit/HTTP tests, and dependency audit. With `DATABASE_URL`,
`npm run check:ci` adds 9 real PostgreSQL constraint, concurrency, and visibility tests, a child-process `SIGKILL` recovery smoke, and a
bounded benchmark with correctness assertions but no throughput threshold. Current public receipts are recorded only after they
exist in [verification](docs/verification.md).

## Clean-room boundary

The exercise was prompted by chapter 11 of `liquidslr/system-design-notes` at fixed commit
`9d8388721e7231442763ad37398b8d82224aa68f`. That source tree has no license file. No upstream prose, code, image, or diagram is
copied here. The immutable [closed-book contract](docs/closed-book-contract.md) was committed before the chapter was read; the
[research log](docs/research-log.md) records what the comparison confirmed and corrected.

## What this repository does not prove

- recommendation quality, relevance, fairness, engagement, media handling, moderation, ads, or notifications;
- screen display, reading, clicks, business outcomes, or exactly-once user-visible delivery;
- private-account, block, mute, legal-erasure, or full identity-provider behavior;
- PostgreSQL power-loss durability, backup/restore, failover, replication, partitioning, multi-region operation, production
  capacity, deployment, SLA, or external acceptance.

## License

MIT. See [LICENSE](LICENSE).
