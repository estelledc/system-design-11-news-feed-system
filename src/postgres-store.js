import {
  DependencyError,
  LeaseLostError,
  NotFoundError,
  RequestConflictError,
  ValidationError,
} from './errors.js';
import { SCHEMA_SQL } from './schema.js';

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    authorId: row.author_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    content: row.content,
    publishedAtMs: Number(row.published_at_ms),
    audienceCutoffVersion: Number(row.audience_cutoff_version),
    fanoutMode: row.fanout_mode,
    followerCountSnapshot: row.follower_count_snapshot,
    deletedAtMs: numberOrNull(row.deleted_at_ms),
  };
}

function dependencyFailure(error) {
  if (
    error instanceof DependencyError
    || error instanceof LeaseLostError
    || error instanceof NotFoundError
    || error instanceof RequestConflictError
    || error instanceof ValidationError
  ) return error;
  return new DependencyError('PostgreSQL operation failed', error);
}

export class PostgresFeedStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    try {
      await this.pool.query(SCHEMA_SQL);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async ping() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async ensureUsers(userIds, nowMs) {
    const ids = [...new Set(userIds)];
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, created_at_ms)
         SELECT user_id, $2 FROM unnest($1::text[]) AS input(user_id)
         ON CONFLICT (id) DO NOTHING`,
        [ids, nowMs],
      );
      await client.query(
        `INSERT INTO author_states (author_id, updated_at_ms)
         SELECT user_id, $2 FROM unnest($1::text[]) AS input(user_id)
         ON CONFLICT (author_id) DO NOTHING`,
        [ids, nowMs],
      );
      await client.query('COMMIT');
      return ids.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async setFollow({ followerId, authorId, active, nowMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const users = await client.query(
        `SELECT id FROM users
         WHERE id = ANY($1::text[]) AND status = 'active'`,
        [[followerId, authorId]],
      );
      if (users.rowCount !== 2) throw new NotFoundError();
      const state = await client.query(
        'SELECT active_follower_count, audience_version FROM author_states WHERE author_id = $1 FOR UPDATE',
        [authorId],
      );
      if (!state.rows[0]) throw new NotFoundError();
      const current = await client.query(
        `SELECT generation, started_version, followed_at_ms
         FROM follow_relations
         WHERE follower_id = $1 AND author_id = $2 AND ended_version IS NULL`,
        [followerId, authorId],
      );

      if (active && current.rows[0]) {
        await client.query('COMMIT');
        return {
          active: true,
          changed: false,
          generation: Number(current.rows[0].generation),
          audienceVersion: Number(state.rows[0].audience_version),
        };
      }
      if (!active && !current.rows[0]) {
        await client.query('COMMIT');
        return {
          active: false,
          changed: false,
          generation: null,
          audienceVersion: Number(state.rows[0].audience_version),
        };
      }

      const nextVersion = Number(state.rows[0].audience_version) + 1;
      if (active) {
        const generation = await client.query(
          `SELECT COALESCE(max(generation), 0)::bigint + 1 AS generation
           FROM follow_relations WHERE follower_id = $1 AND author_id = $2`,
          [followerId, authorId],
        );
        const nextGeneration = Number(generation.rows[0].generation);
        const stateUpdate = await client.query(
          `UPDATE author_states
           SET active_follower_count = active_follower_count + 1,
               audience_version = $2,
               updated_at_ms = $3
          WHERE author_id = $1`,
          [authorId, nextVersion, nowMs],
        );
        if (stateUpdate.rowCount !== 1) throw new DependencyError('Author state was not writable');
        await client.query(
          `INSERT INTO follow_relations (
             follower_id, author_id, generation, started_version, followed_at_ms
           ) VALUES ($1, $2, $3, $4, $5)`,
          [followerId, authorId, nextGeneration, nextVersion, nowMs],
        );
        await client.query('COMMIT');
        return {
          active: true,
          changed: true,
          generation: nextGeneration,
          audienceVersion: nextVersion,
        };
      }

      const stateUpdate = await client.query(
        `UPDATE author_states
         SET active_follower_count = active_follower_count - 1,
             audience_version = $2,
             updated_at_ms = $3
        WHERE author_id = $1 AND active_follower_count > 0`,
        [authorId, nextVersion, nowMs],
      );
      if (stateUpdate.rowCount !== 1) throw new DependencyError('Follower count invariant was violated');
      const relationUpdate = await client.query(
        `UPDATE follow_relations
         SET ended_version = $4, ended_at_ms = $5
         WHERE follower_id = $1 AND author_id = $2 AND generation = $3 AND ended_version IS NULL`,
        [followerId, authorId, current.rows[0].generation, nextVersion, nowMs],
      );
      if (relationUpdate.rowCount !== 1) throw new DependencyError('Current follow generation was not writable');
      await client.query('COMMIT');
      return {
        active: false,
        changed: true,
        generation: Number(current.rows[0].generation),
        audienceVersion: nextVersion,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async acceptPost(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const state = await client.query(
        `SELECT state.active_follower_count, state.audience_version
         FROM author_states AS state
         JOIN users AS author ON author.id = state.author_id AND author.status = 'active'
         WHERE state.author_id = $1
         FOR UPDATE OF state`,
        [input.authorId],
      );
      if (!state.rows[0]) throw new NotFoundError();
      const existing = await client.query(
        'SELECT * FROM posts WHERE author_id = $1 AND idempotency_key = $2',
        [input.authorId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== input.requestDigest) throw new RequestConflictError();
        await client.query('COMMIT');
        return { created: false, post: mapPost(existing.rows[0]) };
      }

      const followerCount = state.rows[0].active_follower_count;
      const audienceVersion = Number(state.rows[0].audience_version) + 1;
      const fanoutMode = followerCount >= input.hotFollowerThreshold ? 'pull' : 'push';
      await client.query(
        `UPDATE author_states
         SET audience_version = $2, updated_at_ms = $3
         WHERE author_id = $1`,
        [input.authorId, audienceVersion, input.publishedAtMs],
      );
      const inserted = await client.query(
        `INSERT INTO posts (
           id, author_id, idempotency_key, request_digest, content, published_at_ms,
           audience_cutoff_version, fanout_mode, follower_count_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          input.id,
          input.authorId,
          input.idempotencyKey,
          input.requestDigest,
          input.content,
          input.publishedAtMs,
          audienceVersion,
          fanoutMode,
          followerCount,
        ],
      );
      if (fanoutMode === 'push') {
        await client.query(
          `INSERT INTO fanout_jobs (
             post_id, max_attempts, available_at_ms, created_at_ms, updated_at_ms
           ) VALUES ($1, $2, $3, $3, $3)`,
          [input.id, input.maxAttempts, input.publishedAtMs],
        );
      }
      await client.query('COMMIT');
      return { created: true, post: mapPost(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async deletePost({ authorId, postId, nowMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const post = await client.query(
        'SELECT author_id, deleted_at_ms FROM posts WHERE id = $1 FOR UPDATE',
        [postId],
      );
      if (!post.rows[0] || post.rows[0].author_id !== authorId) throw new NotFoundError();
      if (post.rows[0].deleted_at_ms !== null) {
        await client.query('COMMIT');
        return { deleted: false, deletedAtMs: Number(post.rows[0].deleted_at_ms) };
      }
      await client.query('UPDATE posts SET deleted_at_ms = $2 WHERE id = $1', [postId, nowMs]);
      await client.query('COMMIT');
      return { deleted: true, deletedAtMs: nowMs };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async claimFanoutJob({ nowMs, leaseMs, crashCooldownMs, leaseToken, workerId }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH expired AS (
           UPDATE fanout_jobs
           SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'retry' END,
               available_at_ms = GREATEST(available_at_ms, $1::bigint + $2::bigint),
               lease_token = NULL,
               lease_owner = NULL,
               leased_until_ms = NULL,
               terminal_reason = CASE WHEN attempts >= max_attempts THEN 'attempt_budget_exhausted' ELSE NULL END,
               updated_at_ms = $1
           WHERE status = 'leased' AND leased_until_ms <= $1
           RETURNING post_id, attempts
         )
         UPDATE fanout_attempts AS attempt
         SET outcome = 'lease_expired_unknown', finished_at_ms = $1
         FROM expired
         WHERE attempt.post_id = expired.post_id
           AND attempt.attempt_no = expired.attempts
           AND attempt.outcome = 'started'`,
        [nowMs, crashCooldownMs],
      );
      await client.query(
        `UPDATE fanout_jobs
         SET status = 'dead', terminal_reason = 'attempt_budget_exhausted', updated_at_ms = $1
         WHERE status IN ('pending', 'retry') AND attempts >= max_attempts`,
        [nowMs],
      );
      const candidate = await client.query(
        `SELECT post_id FROM fanout_jobs
         WHERE status IN ('pending', 'retry')
           AND available_at_ms <= $1
           AND attempts < max_attempts
         ORDER BY available_at_ms, post_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [nowMs],
      );
      if (!candidate.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const leased = await client.query(
        `UPDATE fanout_jobs
         SET status = 'leased',
             attempts = attempts + 1,
             lease_token = $2,
             lease_owner = $3,
             leased_until_ms = $1::bigint + $4::bigint,
             terminal_reason = NULL,
             updated_at_ms = $1
         WHERE post_id = $5
         RETURNING *`,
        [nowMs, leaseToken, workerId, leaseMs, candidate.rows[0].post_id],
      );
      await client.query(
        `INSERT INTO fanout_attempts (post_id, attempt_no, lease_token, started_at_ms, outcome)
         VALUES ($1, $2, $3, $4, 'started')`,
        [leased.rows[0].post_id, leased.rows[0].attempts, leaseToken, nowMs],
      );
      await client.query('COMMIT');
      return {
        postId: leased.rows[0].post_id,
        attempt: leased.rows[0].attempts,
        leaseToken,
        lastFollowerId: leased.rows[0].last_follower_id,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async processFanoutChunk({ postId, leaseToken, nowMs, leaseMs, chunkSize }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT job.attempts, job.last_follower_id, post.author_id, post.audience_cutoff_version
         FROM fanout_jobs AS job
         JOIN posts AS post ON post.id = job.post_id
         WHERE job.post_id = $1
           AND job.status = 'leased'
           AND job.lease_token = $2
           AND job.leased_until_ms > $3
         FOR UPDATE OF job`,
        [postId, leaseToken, nowMs],
      );
      if (!current.rows[0]) throw new LeaseLostError();
      const job = current.rows[0];
      const audience = await client.query(
        `SELECT follower_id, generation
         FROM follow_relations
         WHERE author_id = $1
           AND started_version <= $2
           AND (ended_version IS NULL OR ended_version > $2)
           AND ($3::text IS NULL OR follower_id > $3)
         ORDER BY follower_id
         LIMIT $4`,
        [job.author_id, job.audience_cutoff_version, job.last_follower_id, chunkSize + 1],
      );
      const chunk = audience.rows.slice(0, chunkSize);
      const hasMore = audience.rows.length > chunkSize;
      let inserted = 0;
      for (const relation of chunk) {
        const result = await client.query(
          `INSERT INTO feed_entries (
             viewer_id, post_id, author_id, follow_generation, materialized_at_ms
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (viewer_id, post_id) DO NOTHING`,
          [relation.follower_id, postId, job.author_id, relation.generation, nowMs],
        );
        inserted += result.rowCount;
      }
      const completed = !hasMore;
      const nextCursor = chunk.length > 0 ? chunk.at(-1).follower_id : job.last_follower_id;
      const updated = await client.query(
        `UPDATE fanout_jobs
         SET status = $4,
             last_follower_id = $5,
             lease_token = CASE WHEN $4 = 'completed' THEN NULL ELSE lease_token END,
             lease_owner = CASE WHEN $4 = 'completed' THEN NULL ELSE lease_owner END,
             leased_until_ms = CASE WHEN $4 = 'completed' THEN NULL ELSE $3::bigint + $6::bigint END,
             updated_at_ms = $3
         WHERE post_id = $1 AND status = 'leased' AND lease_token = $2
         RETURNING attempts`,
        [postId, leaseToken, nowMs, completed ? 'completed' : 'leased', nextCursor, leaseMs],
      );
      if (updated.rowCount !== 1) throw new LeaseLostError();
      const attempt = await client.query(
        `UPDATE fanout_attempts
         SET chunks_committed = chunks_committed + $4,
             followers_scanned = followers_scanned + $5,
             rows_inserted = rows_inserted + $6,
             outcome = CASE WHEN $7 THEN 'completed' ELSE outcome END,
             finished_at_ms = CASE WHEN $7 THEN $3 ELSE finished_at_ms END
         WHERE post_id = $1 AND attempt_no = $2 AND lease_token = $8 AND outcome = 'started'`,
        [
          postId,
          updated.rows[0].attempts,
          nowMs,
          chunk.length > 0 ? 1 : 0,
          chunk.length,
          inserted,
          completed,
          leaseToken,
        ],
      );
      if (attempt.rowCount !== 1) throw new DependencyError('Current fanout attempt was not writable');
      await client.query('COMMIT');
      return {
        kind: completed ? 'completed' : 'chunk',
        scanned: chunk.length,
        inserted,
        completed,
        lastFollowerId: nextCursor,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async yieldFanoutJob({ postId, leaseToken, nowMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const job = await client.query(
        `UPDATE fanout_jobs
         SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'retry' END,
             available_at_ms = $3,
             lease_token = NULL,
             lease_owner = NULL,
             leased_until_ms = NULL,
             terminal_reason = CASE WHEN attempts >= max_attempts THEN 'attempt_budget_exhausted' ELSE NULL END,
             updated_at_ms = $3
         WHERE post_id = $1 AND status = 'leased' AND lease_token = $2 AND leased_until_ms > $3
         RETURNING attempts, status`,
        [postId, leaseToken, nowMs],
      );
      if (job.rowCount !== 1) throw new LeaseLostError();
      const terminal = job.rows[0].status === 'dead';
      const attempt = await client.query(
        `UPDATE fanout_attempts
         SET outcome = $4, finished_at_ms = $3
         WHERE post_id = $1 AND attempt_no = $2 AND lease_token = $5 AND outcome = 'started'`,
        [postId, job.rows[0].attempts, nowMs, terminal ? 'attempts_exhausted' : 'yielded', leaseToken],
      );
      if (attempt.rowCount !== 1) throw new DependencyError('Current fanout attempt was not releasable');
      await client.query('COMMIT');
      return { kind: terminal ? 'dead' : 'yielded' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async createFeedSession({ viewerId, sessionId, nowMs, expiresAtMs, candidateLimit }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const viewer = await client.query(
        "SELECT id FROM users WHERE id = $1 AND status = 'active'",
        [viewerId],
      );
      if (!viewer.rows[0]) throw new NotFoundError();
      const candidates = await client.query(
        `WITH candidates AS (
           SELECT post.id, post.author_id, post.published_at_ms, entry.follow_generation
           FROM feed_entries AS entry
           JOIN posts AS post ON post.id = entry.post_id
           JOIN users AS author ON author.id = post.author_id AND author.status = 'active'
           JOIN follow_relations AS relation
             ON relation.follower_id = entry.viewer_id
            AND relation.author_id = entry.author_id
            AND relation.generation = entry.follow_generation
            AND relation.ended_version IS NULL
           WHERE entry.viewer_id = $1
             AND post.fanout_mode = 'push'
             AND post.deleted_at_ms IS NULL
           UNION
           SELECT post.id, post.author_id, post.published_at_ms, relation.generation
           FROM follow_relations AS relation
           JOIN posts AS post
             ON post.author_id = relation.author_id
            AND post.fanout_mode = 'pull'
            AND post.audience_cutoff_version >= relation.started_version
            AND post.deleted_at_ms IS NULL
           JOIN users AS author ON author.id = post.author_id AND author.status = 'active'
           WHERE relation.follower_id = $1 AND relation.ended_version IS NULL
         )
         SELECT id, author_id, published_at_ms, follow_generation
         FROM candidates
         ORDER BY published_at_ms DESC, id DESC
         LIMIT $2`,
        [viewerId, candidateLimit],
      );
      await client.query(
        `INSERT INTO feed_sessions (id, viewer_id, created_at_ms, expires_at_ms, candidate_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, viewerId, nowMs, expiresAtMs, candidates.rowCount],
      );
      for (let position = 0; position < candidates.rows.length; position += 1) {
        const candidate = candidates.rows[position];
        await client.query(
          `INSERT INTO feed_session_entries (
             session_id, position, viewer_id, post_id, author_id, follow_generation, published_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            sessionId,
            position,
            viewerId,
            candidate.id,
            candidate.author_id,
            candidate.follow_generation,
            candidate.published_at_ms,
          ],
        );
      }
      await client.query('COMMIT');
      return { sessionId, expiresAtMs, candidateCount: candidates.rowCount };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async readFeedSession({ viewerId, sessionId, position, limit, nowMs }) {
    try {
      const session = await this.pool.query(
        `SELECT expires_at_ms, candidate_count FROM feed_sessions
         WHERE id = $1 AND viewer_id = $2 AND expires_at_ms > $3`,
        [sessionId, viewerId, nowMs],
      );
      if (!session.rows[0]) throw new ValidationError('cursor session is unavailable');
      const visible = await this.pool.query(
        `SELECT entry.position, post.id, post.author_id, post.content, post.published_at_ms
         FROM feed_session_entries AS entry
         JOIN posts AS post ON post.id = entry.post_id AND post.deleted_at_ms IS NULL
         JOIN users AS author ON author.id = post.author_id AND author.status = 'active'
         JOIN follow_relations AS relation
           ON relation.follower_id = entry.viewer_id
          AND relation.author_id = entry.author_id
          AND relation.generation = entry.follow_generation
          AND relation.ended_version IS NULL
         WHERE entry.session_id = $1 AND entry.viewer_id = $2 AND entry.position >= $3
         ORDER BY entry.position
         LIMIT $4`,
        [sessionId, viewerId, position, limit + 1],
      );
      const hasMore = visible.rows.length > limit;
      const page = visible.rows.slice(0, limit);
      return {
        sessionId,
        expiresAtMs: Number(session.rows[0].expires_at_ms),
        candidateCount: session.rows[0].candidate_count,
        items: page.map((row) => ({
          id: row.id,
          authorId: row.author_id,
          content: row.content,
          publishedAtMs: Number(row.published_at_ms),
        })),
        nextPosition: hasMore ? page.at(-1).position + 1 : null,
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async stats() {
    try {
      const [posts, jobs, entries, sessions, attempts] = await Promise.all([
        this.pool.query('SELECT count(*)::integer AS count FROM posts'),
        this.pool.query('SELECT status, count(*)::integer AS count FROM fanout_jobs GROUP BY status'),
        this.pool.query('SELECT count(*)::integer AS count FROM feed_entries'),
        this.pool.query('SELECT count(*)::integer AS count FROM feed_sessions'),
        this.pool.query('SELECT outcome, count(*)::integer AS count FROM fanout_attempts GROUP BY outcome'),
      ]);
      return {
        posts: posts.rows[0].count,
        jobs: Object.fromEntries(jobs.rows.map((row) => [row.status, row.count])),
        feedEntries: entries.rows[0].count,
        sessions: sessions.rows[0].count,
        attempts: Object.fromEntries(attempts.rows.map((row) => [row.outcome, row.count])),
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async close() {
    await this.pool.end();
  }

  async #connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw dependencyFailure(error);
    }
  }
}
