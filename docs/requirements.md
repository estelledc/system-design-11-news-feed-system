# Requirements and evidence contract

## Executable scope

The slice implements a reverse-chronological feed for directional follows. Users can follow, unfollow, publish bounded text,
delete their own posts, and read a paginated feed. Ranking, media, reactions, comments, reposts, notifications, private-account
approval, blocks, mutes, and recommendations are outside the slice.

## Product rules

- Publish idempotency is scoped by `(author_id, idempotency_key)`. An exact replay returns the original post; changed content
  conflicts.
- Acceptance means the post and frozen push/pull decision are committed. It does not mean materialization or delivery finished.
- A follow has no historical backfill. Unfollow hides the author on subsequent page reads. Refollow starts a new generation and
  cannot expose stale materialized rows from an earlier generation.
- Push/pull mode is frozen per post from the active-follower count inside the same author-serialized transaction.
- Deletion is a tombstone checked at session creation and page delivery. Physical retention cleanup is not the visibility gate.
- Ordering is `(published_at_ms DESC, post_id DESC)`. It is deterministic for this service, not causal or global commit order.
- A feed session contains at most 500 candidates and expires after five minutes by default. New candidates do not enter an old
  session; authorization or deletion changes may remove old candidates and produce a short page.

## Synthetic sizing input

The design exercise assumes 5 million daily active users, 10 million posts/day, 100 million feed reads/day, 200 average eligible
followers for regular posts, and a 10,000-follower hot threshold. The arithmetic is a planning counterexample for pure fanout,
not observed traffic. The executable fixtures and benchmark are deliberately much smaller.

## Required invariants

1. Post acceptance and a regular-author fanout job commit atomically.
2. Follow transitions and publishing for one author serialize on one authoritative state row.
3. Historical relation intervals identify the exact generation eligible at a post's audience cutoff.
4. A fanout chunk inserts unique candidates and advances its follower cursor in one transaction.
5. Every worker mutation is fenced by the current unexpired UUID lease token.
6. Materialized rows are candidates only; current relation generation, author state, and post tombstone are rechecked on output.
7. Persisted session membership prevents concurrent posts or late fanout from entering later pages.
8. Signed cursors are bounded, versioned, expire, and name a session that is separately bound to the authenticated viewer.
9. Logs omit bearer tokens, raw user IDs, idempotency keys, cursor bodies, and post content.

## Acceptance evidence

| Claim | Required evidence |
|---|---|
| input and cursor contracts | deterministic unit tests on every supported Node runtime |
| concurrent idempotency and follows | real PostgreSQL tests, not an in-memory substitute |
| queue concurrency and fencing | concurrent `SKIP LOCKED`, lease expiry, and stale-token tests |
| privacy-sensitive visibility | unfollow, refollow, and deletion checks on old materialized/session rows |
| stable pages | concurrent-post counterexample comparing old and fresh sessions |
| process recovery | child worker killed with `SIGKILL` after a committed non-final chunk |
| bounded timing | raw environment-labelled observations with correctness assertions and no capacity gate |
| public reproducibility | locked dependencies, pinned Actions, PostgreSQL 17.6, Node 22/24/26, and 0 skipped tests |
