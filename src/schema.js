export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id varchar(64) PRIMARY KEY,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS author_states (
  author_id varchar(64) PRIMARY KEY REFERENCES users(id),
  active_follower_count integer NOT NULL DEFAULT 0 CHECK (active_follower_count >= 0),
  audience_version bigint NOT NULL DEFAULT 0 CHECK (audience_version >= 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS follow_relations (
  follower_id varchar(64) NOT NULL REFERENCES users(id),
  author_id varchar(64) NOT NULL REFERENCES users(id),
  generation bigint NOT NULL CHECK (generation > 0),
  started_version bigint NOT NULL CHECK (started_version > 0),
  ended_version bigint,
  followed_at_ms bigint NOT NULL CHECK (followed_at_ms >= 0),
  ended_at_ms bigint,
  PRIMARY KEY (follower_id, author_id, generation),
  CONSTRAINT follow_relations_not_self CHECK (follower_id <> author_id),
  CONSTRAINT follow_relations_interval CHECK (
    (ended_version IS NULL AND ended_at_ms IS NULL)
    OR (
      ended_version IS NOT NULL
      AND ended_at_ms IS NOT NULL
      AND ended_version > started_version
      AND ended_at_ms >= followed_at_ms
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS follow_relations_one_active_idx
  ON follow_relations (follower_id, author_id)
  WHERE ended_version IS NULL;

CREATE INDEX IF NOT EXISTS follow_relations_audience_idx
  ON follow_relations (author_id, follower_id, started_version, ended_version);

CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY,
  author_id varchar(64) NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4096),
  published_at_ms bigint NOT NULL CHECK (published_at_ms >= 0),
  audience_cutoff_version bigint NOT NULL CHECK (audience_cutoff_version > 0),
  fanout_mode varchar(16) NOT NULL CHECK (fanout_mode IN ('push', 'pull')),
  follower_count_snapshot integer NOT NULL CHECK (follower_count_snapshot >= 0),
  deleted_at_ms bigint,
  CONSTRAINT posts_author_key_uniq UNIQUE (author_id, idempotency_key),
  CONSTRAINT posts_delete_time CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= published_at_ms)
);

CREATE INDEX IF NOT EXISTS posts_author_feed_idx
  ON posts (author_id, published_at_ms DESC, id DESC)
  WHERE deleted_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS fanout_jobs (
  post_id uuid PRIMARY KEY REFERENCES posts(id),
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'leased', 'completed', 'dead')),
  last_follower_id varchar(64),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  available_at_ms bigint NOT NULL CHECK (available_at_ms >= 0),
  lease_token uuid,
  lease_owner varchar(64),
  leased_until_ms bigint,
  terminal_reason varchar(64),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= 0),
  CONSTRAINT fanout_jobs_lease_shape CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND leased_until_ms IS NOT NULL)
    OR (status <> 'leased' AND lease_token IS NULL AND lease_owner IS NULL AND leased_until_ms IS NULL)
  ),
  CONSTRAINT fanout_jobs_terminal_shape CHECK (
    (status = 'dead' AND terminal_reason IS NOT NULL)
    OR (status <> 'dead' AND terminal_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS fanout_jobs_due_idx
  ON fanout_jobs (available_at_ms, post_id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS fanout_jobs_lease_idx
  ON fanout_jobs (leased_until_ms)
  WHERE status = 'leased';

CREATE TABLE IF NOT EXISTS fanout_attempts (
  post_id uuid NOT NULL REFERENCES posts(id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  lease_token uuid NOT NULL,
  started_at_ms bigint NOT NULL CHECK (started_at_ms >= 0),
  finished_at_ms bigint,
  outcome varchar(32) NOT NULL CHECK (outcome IN (
    'started', 'lease_expired_unknown', 'completed', 'yielded', 'attempts_exhausted'
  )),
  chunks_committed integer NOT NULL DEFAULT 0 CHECK (chunks_committed >= 0),
  followers_scanned integer NOT NULL DEFAULT 0 CHECK (followers_scanned >= 0),
  rows_inserted integer NOT NULL DEFAULT 0 CHECK (rows_inserted >= 0),
  PRIMARY KEY (post_id, attempt_no),
  CONSTRAINT fanout_attempts_finish_shape CHECK (
    (outcome = 'started' AND finished_at_ms IS NULL)
    OR (outcome <> 'started' AND finished_at_ms IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS feed_entries (
  viewer_id varchar(64) NOT NULL REFERENCES users(id),
  post_id uuid NOT NULL REFERENCES posts(id),
  author_id varchar(64) NOT NULL REFERENCES users(id),
  follow_generation bigint NOT NULL CHECK (follow_generation > 0),
  materialized_at_ms bigint NOT NULL CHECK (materialized_at_ms >= 0),
  PRIMARY KEY (viewer_id, post_id),
  FOREIGN KEY (viewer_id, author_id, follow_generation)
    REFERENCES follow_relations(follower_id, author_id, generation)
);

CREATE INDEX IF NOT EXISTS feed_entries_viewer_idx
  ON feed_entries (viewer_id, materialized_at_ms DESC, post_id);

CREATE TABLE IF NOT EXISTS feed_sessions (
  id uuid PRIMARY KEY,
  viewer_id varchar(64) NOT NULL REFERENCES users(id),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms),
  candidate_count integer NOT NULL CHECK (candidate_count BETWEEN 0 AND 500),
  CONSTRAINT feed_sessions_identity_uniq UNIQUE (id, viewer_id)
);

CREATE INDEX IF NOT EXISTS feed_sessions_expiry_idx ON feed_sessions (expires_at_ms);

CREATE TABLE IF NOT EXISTS feed_session_entries (
  session_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 499),
  viewer_id varchar(64) NOT NULL REFERENCES users(id),
  post_id uuid NOT NULL REFERENCES posts(id),
  author_id varchar(64) NOT NULL REFERENCES users(id),
  follow_generation bigint NOT NULL CHECK (follow_generation > 0),
  published_at_ms bigint NOT NULL CHECK (published_at_ms >= 0),
  PRIMARY KEY (session_id, position),
  CONSTRAINT feed_session_entries_post_uniq UNIQUE (session_id, post_id),
  FOREIGN KEY (session_id, viewer_id)
    REFERENCES feed_sessions(id, viewer_id) ON DELETE CASCADE,
  FOREIGN KEY (viewer_id, author_id, follow_generation)
    REFERENCES follow_relations(follower_id, author_id, generation)
);
`;
