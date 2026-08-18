# ADR 0001: PostgreSQL hybrid fanout and bounded feed sessions

## Status

Accepted for the v0.1 evidence slice.

## Context

The repository must demonstrate one durable post-acceptance path, regular-author fanout, hot-author pull, worker recovery,
follow-generation semantics, deletion hiding, and stable pagination. Adding a broker and multiple caches before those rules are
executable would introduce more authorities and invalidation paths without proving the core behavior.

The closed-book contract proposed a visibility high-watermark in the cursor. PostgreSQL sequences cannot supply a commit
watermark: values survive rollback and allocation order is not proof that every lower transaction committed. A database snapshot
can be stable inside Repeatable Read, but preserving it across user think time would require a long transaction or external
snapshot lifecycle.

## Decision

Use PostgreSQL 17.6 as the single v0.1 authority.

1. Publishing locks the author's state, advances its audience version, freezes follower count and fanout mode, and atomically
   commits the immutable post plus one regular-author fanout job. Hot-author posts need no per-follower job.
2. Follow, unfollow, refollow, and publish transitions for one author serialize on that state row. Relationship generations and
   `[started_version, ended_version)` intervals preserve the audience at each post cutoff.
3. Workers claim fanout jobs with `FOR UPDATE SKIP LOCKED`, persist a UUID lease token, and process bounded follower chunks. Each
   chunk transaction inserts unique viewer/post candidates and advances the exact-token cursor together.
4. Feed candidates are a union of materialized regular-author rows and current hot-author posts. Current active relation
   generation, post tombstone, and user state remain authoritative at both session creation and page delivery.
5. The first page materializes at most 500 recent candidates into a five-minute feed session. An HMAC-authenticated cursor binds
   version, session ID, and position; the database additionally binds the session to the authenticated viewer.
6. Later pages read only session positions, so new posts and late fanout do not enter the old session. They still recheck deletion
   and current relation generation, so privacy/authorization changes can remove items and produce a short page.
7. Redis, a broker, recommendation ranking, and media storage are not included. Public CI runs real PostgreSQL and actual child
   process termination instead of substituting an in-memory store for those claims.

## Alternatives rejected for this slice

- **Sequence cutoff plus keyset cursor:** a sequence is unique, not commit-ordered; late commits below the observed value can
  enter later pages.
- **Long Repeatable Read transaction across pages:** preserves a snapshot by retaining database resources across user think time
  and still needs lifecycle/retry handling.
- **Offset pagination over live candidates:** concurrent inserts and late fanout can shift offsets and cause duplicates or skips.
- **Pure fanout on write:** hot-author amplification dominates publish work and recovery backlog.
- **Pure fanout on read:** avoids inbox writes but makes every read aggregate all followed authors and hides the write/read trade.
- **Database plus broker/cache immediately:** requires an outbox/CDC and invalidation contract that is larger than the current
  correctness question.

## Consequences

- Stable pagination is explicit and testable, but session writes amplify reads, cap history at 500 candidates, expire after five
  minutes, and need cleanup. This is a bounded reference technique, not a recommendation for every production feed.
- Per-author serialization makes follow counts and cutoff intervals precise but creates a hot row for authors with very high
  relationship churn. A scalable replacement must preserve the same version semantics or deliberately redefine them.
- Fanout progress and inbox insertion share one transaction, eliminating the artificial “rows committed but cursor lost” window
  available in a separate broker architecture. The remaining crash receipt is lease expiry after a committed chunk and before
  job completion.
- Read-time relation/deletion checks favor correctness over a cache-only hot path. A later cache must carry versions or be treated
  only as a candidate source.
- The system can prove database convergence and returned-feed receipts. It still cannot prove screen display, reading,
  engagement, global ordering, multi-region behavior, failover, or production capacity.
