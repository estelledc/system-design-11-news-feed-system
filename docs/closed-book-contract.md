# Closed-book contract: News Feed System

## Evidence boundary

- Frozen on 2026-08-19 (Asia/Shanghai) from the title “News Feed System” only.
- Chapter 11 of `liquidslr/system-design-notes` and external solution articles have not been read for this contract.
- The numbers, product rules, architecture, and acceptance tests below are repository assumptions, not claims about Facebook,
  X, Instagram, TikTok, or any other product.
- After this file is committed, source comparison may correct or extend the design. It must not rewrite this baseline to look as
  if the later evidence was known in advance.

## One executable question

> After a post is durably accepted, what can a home-feed service truthfully show across fanout retries, hot authors,
> follow/unfollow races, deletion, concurrent pagination, and worker death?

The v0.1 answer will be a chronological following feed, not an engagement-ranking system. PostgreSQL is the authority. Regular
authors use fanout-on-write into materialized inbox rows; hot authors are merged on read. A transactional fanout job closes the
post-commit/enqueue loss window. Read-time authorization and tombstone checks remain authoritative even when an inbox row exists.

## Scenario arithmetic, not a forecast

Assume, only to shape the experiment:

- 5 million daily active users out of 100 million registered users;
- 2 posts per active user per day: 10 million posts/day, about 116/second average and 1,160/second at a declared 10x peak;
- 20 home-feed reads per active user per day: 100 million reads/day, about 1,157/second average and 11,574/second at 10x peak;
- 200 eligible followers per regular-author post on average: 2 billion candidate inbox writes/day, about 23,148/second average;
- a repository hot-author threshold of 10,000 active followers, above which per-follower synchronous expansion is not attempted;
- 256 bytes of index/state metadata per materialized entry: 512 GB/day before indexes, WAL, replicas, post bodies, and retention.

These assumptions already show that naive fanout can dominate post writes. The implementation will test correctness on bounded
fixtures and record raw timing. It will not claim to sustain these scenario rates.

## Users and frozen product behavior

- An authenticated user can follow, unfollow, publish a bounded text post, delete their own post, and read their home feed.
- Publish accepts an author-scoped idempotency key. Success means the post and its fanout decision/job are committed; it does not
  mean every follower inbox has been materialized.
- A follow begins at its committed generation and does not backfill older posts in v0.1. Unfollow hides that author's posts from
  subsequent reads immediately. Refollow creates a new generation and must not revive stale inbox rows from the old relation.
- Regular-author posts are copied to follower inboxes asynchronously. Hot-author posts remain in the author's post stream and
  are pulled during reads. The mode and audience cutoff are frozen with the accepted post so a retry cannot switch strategy.
- A deleted post is hidden at read time from both materialized and pull paths. Physical cleanup is asynchronous and cannot be
  the only privacy boundary.
- Feed order is deterministic reverse chronological order by `(published_at_ms, post_id)`. It is not a causal, globally total,
  engagement, relevance, or fairness order.
- The first page freezes a visibility high-watermark. Later pages reuse it, so concurrent posts or late fanout cannot silently
  reshape that pagination session. A fresh first page may show newer work.

## Non-goals

- Recommendation/ranking ML, ads, trends, search, hashtags, comments, likes, reposts, notifications, media upload/transcoding,
  moderation, spam detection, creator analytics, or monetization.
- Private accounts, groups, blocks, mutes, close-friends lists, legal erasure completion, or parental controls.
- Cross-region active-active writes, database failover, cache invalidation at fleet scale, production capacity, deployment,
  SLA, or external acceptance.
- Exactly-once user-visible delivery. The implementation may prove idempotent database convergence for its own inbox rows only.

## State and consistency contract

### Source-of-truth records

- `users`: local authenticated identity and bounded status.
- `follow_relations`: follower, author, monotonically increasing generation, followed time, and optional ended time.
- `author_stats`: transactionally maintained active-follower count used only to freeze regular/hot fanout mode.
- `posts`: immutable author, body digest/content, publish key/digest, publish time, visibility sequence, frozen mode/cutoff, and
  deletion tombstone.
- `fanout_jobs`: one leased, retryable job per regular-author post with exact fencing token, progress, attempt budget, and receipt.
- `feed_entries`: viewer, post, follow generation, insertion visibility sequence, and unique `(viewer, post, generation)` key.

### Required invariants

1. **Stable publish:** `(author_id, idempotency_key)` names one immutable request digest and post forever; changed content under
   the same key conflicts.
2. **No enqueue gap:** post acceptance and the frozen fanout mode/job commit in one PostgreSQL transaction.
3. **One current follow generation:** at most one active relation exists for a follower/author pair. Refollow never reuses the
   old generation.
4. **Audience cutoff:** materialized delivery is eligible only for the follow generation active at the post's frozen cutoff.
   Pull candidates require `post.published_at >= current_relation.followed_at`.
5. **Read-time authority:** an inbox row is only a candidate. Current follow generation, user/post status, and deletion are
   rechecked before output.
6. **Fanout convergence:** duplicate or restarted fanout attempts can insert at most one feed entry per eligible generation.
7. **Fenced recovery:** only the current job lease token can advance progress or finish; an expired worker cannot overwrite a
   successor.
8. **Stable pagination:** the cursor is authenticated, bounded, and binds the initial visibility high-watermark plus the last
   `(published_at_ms, post_id)` key. Candidates created above that watermark are excluded from later pages.
9. **Hybrid merge uniqueness:** one post can appear at most once after merging materialized and hot-author candidates, even if
   classification metadata or recovery produces overlapping candidates.
10. **Receipt honesty:** feed inclusion proves only that the server returned an authorized candidate in this read. It does not
    prove screen display, reading, engagement, notification, or business outcome.
11. **Identity minimization:** application logs contain counts, states, bounded reason codes, and opaque correlation hashes, not
    tokens, raw user IDs, idempotency keys, cursor contents, or post text.

## Failure windows to make executable

| Window | Expected durable evidence | Recovery rule |
|---|---|---|
| before publish transaction commit | no accepted post | retry the same idempotency key |
| after post/job commit, before fanout | post and pending job exist | any worker can lease the job |
| after a fanout chunk commits, before progress/finish | some unique inbox rows exist; job may look stale | lease expiry and replay converge through unique keys |
| expired worker resumes after successor | stale token exists | every progress/finish write is rejected |
| follow commits after post cutoff | new generation exists | no regular-path backfill; pull path filters by followed time |
| unfollow after materialization | stale inbox row remains | read-time relation check hides it immediately |
| delete after materialization | tombstoned post and stale inbox row coexist | both feed paths filter the tombstone |
| new post or late inbox insertion between pages | visibility sequence exceeds cursor watermark | later pages exclude it; a fresh session may include it |

## Planned minimal slice

- Node.js 22/24/26, built-in HTTP, and a locked PostgreSQL client dependency.
- PostgreSQL 17.6 as source of truth, work queue, visibility sequence, and integration-test service.
- Separate API and fanout-worker processes. Test clocks, IDs, job chunk size, and failure hooks are injectable.
- No Redis in v0.1 unless measured evidence shows the correctness slice needs a cache. A cache diagram alone is not a result.
- No real third-party service or credential. Process crashes use child `SIGKILL`; database integration uses the actual service.

## Acceptance evidence

1. Deterministic tests for bounded input, canonical publish identity, cursor authentication/tamper rejection, hybrid merge,
   deduplication, order, and page boundaries.
2. Real PostgreSQL tests for concurrent publish replay/conflict, atomic post/job creation, unique active follows, generations,
   regular/hot mode freezing, concurrent `SKIP LOCKED` claims, chunk replay, exact fencing, and attempt receipts.
3. A child-process smoke that publishes, commits one fanout chunk, kills the worker before completion, waits for lease expiry,
   recovers with a second worker, and proves one visible entry per eligible follower with an explicit stale-token rejection.
4. Read tests proving immediate unfollow and deletion hiding on both materialized and pull paths, plus refollow not reviving stale
   rows.
5. A pagination counterexample: insert a newer post and complete late fanout after page 1, then prove the old cursor is stable
   while a new cursor can observe the changes.
6. A bounded benchmark for post/job acceptance, chunk fanout, and hybrid read merge. Shared-runner wall time is reported with
   environment and exclusions; no production throughput promise follows.
7. Public CI on all three Node versions with PostgreSQL 17.6, 0 skipped tests, pinned Actions, minimum permissions, lockfile,
   dependency audit, MIT license, clean default branch, exact commit, and run receipts.

## Questions reserved for source comparison

- What traffic and storage assumptions does the fixed chapter actually make, and which are stale or unsourced?
- Does it choose push, pull, or hybrid fanout, and does it freeze semantics for follow/unfollow and celebrity classification?
- Does it distinguish durable post acceptance from fanout completion and user-visible delivery?
- How does it keep pagination stable under concurrent post creation and late fanout?
- Are deletion, privacy changes, retries, worker death, fencing, and stale cached/inbox rows specified or omitted?
- Which current primary sources are needed for PostgreSQL queue semantics, cursor security, HTTP contracts, and any chosen cache?

## Stop line

The repository is complete only when the minimal slice and all acceptance receipts above are public and green. If a chosen
feature cannot be tied to one frozen requirement, observed failure, direct caller state, or security/data-integrity boundary, it
will not be added. The chapter comparison may change the source-informed design, but it cannot erase this baseline or turn an
unverified product convention into fact.
