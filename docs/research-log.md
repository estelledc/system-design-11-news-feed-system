# Research log and source corrections

## Snapshot and clean-room boundary

- Closed-book baseline: commit `904489140524da4f33ed55a87524266450c7c4c9`, written before reading the chapter.
- Secondary prompt source: `liquidslr/system-design-notes`, fixed commit
  `9d8388721e7231442763ad37398b8d82224aa68f`, chapter 11 tree
  `1b61a986a2642e13791492c54a22aa0eeaf6d68f`, `Readme.md` blob
  `84e2ae8b88d36f98da609d6397d2d75e2d58d050`.
- Public-source fetch and review date: 2026-08-19 (Asia/Shanghai).
- The fixed upstream tree has no license file. This repository copies no upstream prose, image, diagram, or code. The chapter is
  used only to identify the problem and compare mechanisms.

## Closed-book comparison

| Topic | Closed-book contract | Fixed chapter | Decision after comparison |
|---|---|---|---|
| Core feed | directional following, reverse chronological | posts from “friends,” reverse chronological | keep directional following as an explicit repository product rule |
| Fanout | regular-author push plus hot-author pull | explains write, read, and hybrid; recommends pull for high-connection users | confirmed, but freeze mode per accepted post so retry cannot switch strategy |
| Durable acceptance | post plus fanout job in one PostgreSQL transaction | store post, then fanout through a queue | retain the transactional job; a queue name alone does not close a dual-write loss window |
| Feed state | durable candidate rows plus authoritative read-time checks | post IDs in a bounded in-memory feed cache | omit Redis from v0.1; first prove relation, deletion, retry, and crash semantics in one authority |
| Relationship changes | generations define follow, unfollow, and refollow semantics | cached settings filter muted/selective recipients before fanout | retain generations and read-time checks; pre-fanout filtering cannot enforce later changes |
| Pagination | deterministic key plus stable session requirement | not specified | materialize a bounded feed session; do not pretend repeated default-isolation queries share a snapshot |
| Deletion/privacy | tombstone is checked on every read path | not specified | retain as a data-integrity and privacy boundary |
| Failure evidence | idempotency, lease, fencing, `SIGKILL`, attempt receipts | queues are described as decoupling/buffering components | retain executable recovery semantics; component presence is not a delivery guarantee |
| Scale input | explicit 5M-DAU repository scenario | 10M DAU and up to 5,000 friends | keep both labeled as synthetic inputs; neither is a current product fact or capacity result |
| Content | bounded text only | text, image, and video | keep media out of v0.1; binary storage/transcoding would be a separate system boundary |

## Corrections that shape the implementation

1. The chapter models `auth_token` as an API parameter. RFC 6750 recommends the `Authorization: Bearer` header and warns that
   tokens in page URLs are likely to be logged. This repository accepts credentials only from the header and never logs them.
2. PostgreSQL Read Committed gives each statement a new snapshot. Two feed-page requests therefore do not become one stable
   pagination session just because they use the same database. Repeatable Read is stable only inside one transaction and can
   require retry; holding such a transaction across HTTP requests would be an operationally unsafe substitute for a cursor.
3. A global PostgreSQL sequence is not a safe “all commits below this number are visible” watermark. `nextval` values are not
   reclaimed on rollback and are visible outside transaction rollback, so allocation order is not proof of commit order. The
   closed-book high-watermark idea is replaced by a bounded persisted feed session.
4. `SKIP LOCKED` deliberately gives an inconsistent view. PostgreSQL documents it as useful for multiple consumers of a
   queue-like table, not for authoritative feed reads. It is used only to claim fanout jobs.
5. The chapter says consistent hashing distributes requests evenly. Consistent hashing primarily limits remapping under
   membership changes; even distribution still depends on hash quality, weights, and enough virtual points. v0.1 does not add
   a sharding layer merely because it appears in the checklist.
6. Five named cache layers do not define invalidation authority. A materialized inbox row remains only a candidate: current
   relation generation, post tombstone, and user state are rechecked before output.
7. Notifications, likes, replies, counters, ranking, and media are adjacent systems. They are excluded so the runnable slice can
   actually prove hybrid fanout and visibility semantics instead of drawing an unverified platform diagram.

## Source-informed design decisions

- PostgreSQL is the v0.1 authority for posts, relationship history, fanout jobs, materialized candidates, attempt receipts, and
  bounded feed sessions. This removes a database/broker dual write from the evidence slice, not from all production designs.
- Follow transitions and posts for one author share a locked author-state row and monotonically increasing audience version.
  Historical relation intervals make the audience at a post cutoff queryable after later unfollow/refollow changes.
- A fanout chunk inserts unique `(viewer, post)` candidates and advances its cursor in one transaction. Process death after the
  chunk leaves both data and progress committed; lease expiry resumes the next chunk, and the stale token is fenced.
- The first feed read stores at most a bounded recent candidate set in a short-lived session. Signed cursors name the session and
  next position. Later pages cannot gain newly materialized candidates, while deletion or unfollow can still remove stale ones.
- Cursor HMAC uses Node's standard crypto implementation and equal-length `timingSafeEqual` comparison. The surrounding parser,
  size limits, viewer binding, key handling, and error path still require their own tests; one constant-time primitive does not
  make the whole endpoint timing-safe.

## Primary sources

- [PostgreSQL 17: Transaction Isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- [PostgreSQL 17: Sequence Manipulation Functions](https://www.postgresql.org/docs/17/functions-sequence.html)
- [PostgreSQL 17: SELECT and `SKIP LOCKED`](https://www.postgresql.org/docs/17/sql-select.html)
- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)
- [Node.js Crypto API](https://nodejs.org/api/crypto.html)

The public bodies above were fetched into temporary evidence bundles and passed the repository fetch verifier. Search snippets
were candidate discovery only. PostgreSQL, Node, and security guidance can change; implementation claims stay bound to the
tested versions and dated evidence rather than being presented as timeless behavior.
