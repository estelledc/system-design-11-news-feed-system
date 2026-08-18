# Threat model

## Assets and trust boundaries

Assets include bearer credentials, cursor signing material, relationship history, post content, deletion state, and feed
membership. The HTTP client, API process, worker process, operator environment, and PostgreSQL connection are separate trust
boundaries even though the local fixture runs them on one machine.

## Threats, controls, and residual risk

| Threat | Implemented control | Residual boundary |
|---|---|---|
| credential leakage through URLs/logs | bearer header only; structured logs omit identity and content fields | static token map has no issue, expiry, rotation, revocation, scopes, or constant-time lookup contract |
| publish replay or key reuse | bounded author-scoped idempotency key plus canonical request digest | database retention defines how long replay remains protected |
| forged/tampered pagination | HMAC-SHA-256, equal-length `timingSafeEqual`, exact fields, expiry, and viewer-bound session | one shared secret; rotation/key IDs and distributed secret storage are absent |
| cross-user post deletion | authenticated author must own the UUID post; foreign/missing returns not found | compromised token still acts as that fixture user |
| stale follow authorization | current relationship generation rechecked at session creation and page output | blocks, mutes, private accounts, and policy services are not modeled |
| deleted content exposure | tombstone checked on push, pull, and persisted-session reads | plaintext remains stored; legal erasure, replicas, backups, and search indexes are not implemented |
| stale worker corruption | unexpired exact UUID token required for chunk and yield writes | a process with database credentials can bypass application boundaries |
| duplicate/shifted feed items | unique candidate key, union deduplication, deterministic order, persisted membership | session cap omits older history and removal can produce short pages |
| request/resource exhaustion | 8 KiB body cap, 4 KiB content cap, page/session caps, bounded identifiers and worker chunks | no distributed rate limit, per-user quota, WAF, connection admission, or storage budget |
| dependency or CI compromise | lockfile, high-severity audit, minimal workflow permission, commit-pinned Actions | audit is not proof of absence; base images and transitive ecosystem still require maintenance |

## Privacy statement

This slice must use synthetic users and content only. A feed response proves that the server returned an authorized candidate at
that instant. It does not prove screen display, human viewing, or any business result. An unfollow or tombstone changes read
visibility, but neither is proof of physical deletion from primary storage, WAL, replicas, backups, logs outside this process,
or downstream systems.
