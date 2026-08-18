# API contract

The server uses JSON over HTTP/1.1. Except for health, every route requires `Authorization: Bearer <token>`. Credentials in the
query string or request body are not accepted. The local token-to-user map comes from `AUTH_TOKENS_JSON`; it is a fixture, not a
production identity provider.

## Configuration

`DATABASE_URL` and `CURSOR_HMAC_SECRET` are required. The cursor secret must contain 32–256 UTF-8 bytes. A local fixture map:

```json
[
  { "token": "local-author-token-at-least-16", "userId": "author-a" },
  { "token": "local-viewer-token-at-least-16", "userId": "viewer-a" }
]
```

Do not commit or log a real value. Startup ensures fixture users exist; it does not implement signup or token lifecycle.

## Routes

### `POST /v1/posts`

Headers: bearer authorization, `Content-Type: application/json`, and `Idempotency-Key` containing 16–128 safe characters.

```json
{ "content": "bounded UTF-8 text" }
```

The only accepted body field is `content`; it must be nonblank and at most 4 KiB. Status `201` means a new post and its frozen
fanout decision committed. Status `200` means an exact replay. The response includes the post ID, author, publish time,
`fanoutMode`, follower-count snapshot, and deletion flag. It does not assert that any feed entry exists yet.

### `DELETE /v1/posts/{postId}`

The authenticated caller must own the UUID post. The operation is idempotent after the first tombstone. It returns whether this
request changed state and the tombstone time. A missing or foreign post is reported as not found.

### `PUT /v1/follows/{authorId}`

Starts or replays a current relationship. A state-changing refollow receives a new generation. Self-follow is rejected.

### `DELETE /v1/follows/{authorId}`

Ends the current generation or returns an unchanged inactive result. The server does not synchronously delete stale inbox rows;
page delivery filters them through the active generation.

### `GET /v1/feed?limit=20&cursor=...`

`limit` is 1–50. The first request creates a short-lived, at-most-500-candidate session. `nextCursor` is either a signed opaque
cursor or `null`. A continuation is valid only for its authenticated viewer and unexpired stored session. Unknown, duplicate, or
malformed query fields fail closed.

A page may be shorter than its requested limit after a deletion or unfollow. The implementation does not reach beyond the
persisted session window to fill such a gap, because doing so would silently alter the session.

### `GET /healthz`

Unauthenticated dependency probe. Status `200` proves only that the process completed a PostgreSQL query at that moment.

## Errors and logging

Responses expose bounded codes: `invalid_request`, `unauthorized`, `not_found`, `idempotency_conflict`,
`dependency_unavailable`, or `internal_error`. Stack traces and database details are not returned. Structured logs contain route
outcome categories and counts, never token, raw user ID, idempotency key, cursor, or post body.
