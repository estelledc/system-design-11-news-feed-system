# Architecture and failure semantics

## One authority, two delivery strategies

PostgreSQL 17.6 stores identities, author state, relationship history, posts, fanout work, candidate inbox rows, worker attempt
receipts, and bounded feed sessions. Keeping one authority is a scope decision: it makes the enqueue and recovery semantics
executable before introducing a broker, cache, outbox, or CDC pipeline.

| State | Role | Authority rule |
|---|---|---|
| `author_states` | active count and audience version | locked by follow/unfollow/publish for one author |
| `follow_relations` | historical generations and version intervals | one partial-unique active row per follower/author |
| `posts` | immutable accepted content and frozen mode/cutoff | tombstone is mutable; identity is author + key |
| `fanout_jobs` | work state, cursor, lease, attempt budget | one row per push post; exact current token fences writes |
| `fanout_attempts` | append-addressed attempt receipt | outcome can leave `started` only once |
| `feed_entries` | push-path candidates | unique viewer/post and linked relationship generation |
| `feed_sessions` | bounded pagination membership | viewer-bound, expiring, maximum 500 candidates |

## Publish and relationship serialization

Follow, unfollow, refollow, and publish all lock the author's state row. Each state change advances an audience version. A
relationship owns a half-open interval `[started_version, ended_version)`. Publishing advances the version and freezes it as the
post cutoff, so a later worker can reconstruct exactly which generation was eligible even after relationship changes.

For a regular author, the post and one fanout job commit in the same transaction. For a hot author, no job is created. This
closes a database/broker dual-write gap in the slice, but the author-state lock is deliberately a scalability hotspot. Sharding
or relaxing this serialization would require a new, explicit audience contract.

## Fenced fanout

Workers use `FOR UPDATE SKIP LOCKED` only on the queue-like job table. A claim increments the attempt and records a UUID token and
expiry. Each chunk transaction:

1. locks the job only if the token is current and unexpired;
2. selects the next eligible follower IDs after the durable cursor;
3. inserts viewer/post candidates with conflict convergence;
4. advances the cursor and attempt counters together;
5. either renews the lease or marks the job and attempt complete.

If a process dies after a chunk commit, those candidates and its cursor both survive. Lease recovery labels the abandoned
attempt `lease_expired_unknown`; a successor resumes after the committed cursor. The old token is then rejected. This is
database convergence, not exactly-once screen delivery.

## Hybrid read and stable pagination

The first feed request starts one short Repeatable Read transaction. It unions:

- push candidates whose materialized relationship generation is still current; and
- pull posts from currently followed hot authors whose post cutoff is not older than the current follow generation.

It orders the union by `(published_at_ms DESC, post_id DESC)` and persists at most 500 rows. Repeatable Read stabilizes only this
single transaction; it is not held across HTTP requests. Later pages read stored positions. They cannot acquire a concurrent
post or late fanout row, but they join current relationship, author, and tombstone state again. Therefore privacy changes remove
items even when that yields a short page.

A global sequence is intentionally not used as a commit watermark. Sequence values survive rollback and allocation order does
not prove that every lower transaction committed. The decision record explains the alternatives in
[ADR 0001](adr/0001-postgres-hybrid-fanout-and-feed-sessions.md).

## Failure windows

| Window | Durable observation | Recovery or boundary |
|---|---|---|
| before publish commit | no accepted post | retry the same idempotency key |
| after push post/job commit | accepted post and pending job | any worker may lease it |
| after a non-final chunk commit | candidates and cursor advanced, attempt still started | lease expiry, then successor resumes |
| expired worker resumes | stale UUID token | every progress/release mutation rejects it |
| unfollow after materialization | old candidate remains stored | current-generation join hides it |
| refollow | new generation, old candidate remains | generation mismatch prevents revival |
| delete after session creation | session member and tombstone coexist | page delivery filters tombstone |
| post or fanout after page one | new candidate absent from stored session | old cursor remains stable; new session may see it |

## Deliberate tradeoffs

- The persisted-session design amplifies reads and caps accessible history. It is a correctness reference, not a universal feed
  architecture recommendation.
- Candidate insertion is row-by-row inside a transaction for clarity. Bulk copy, partitioning, and broker-backed fanout require
  measurements and a preserved fencing/idempotency contract.
- PostgreSQL holds post text in plaintext. This repository does not implement encryption, regional residency, moderation, or
  legal erasure.
- No cache is authoritative. A future cache must carry relation/deletion versions or remain a discardable candidate source.
