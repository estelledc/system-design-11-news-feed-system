import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.js';
import {
  normalizeIdempotencyKey,
  normalizePageLimit,
  normalizePostRequest,
  normalizeUserId,
  normalizeUuid,
  safeInteger,
} from './contracts.js';
import { ValidationError } from './errors.js';

export class FeedService {
  constructor({
    store,
    cursorCodec,
    clock = Date.now,
    uuid = randomUUID,
    hotFollowerThreshold = 10_000,
    maxFanoutAttempts = 5,
    sessionTtlMs = 300_000,
    sessionCandidateLimit = 500,
  }) {
    this.store = store;
    this.cursorCodec = cursorCodec;
    this.clock = clock;
    this.uuid = uuid;
    this.hotFollowerThreshold = safeInteger(hotFollowerThreshold, 'hot follower threshold', { min: 1 });
    this.maxFanoutAttempts = safeInteger(maxFanoutAttempts, 'max fanout attempts', { min: 1, max: 20 });
    this.sessionTtlMs = safeInteger(sessionTtlMs, 'session TTL', { min: 1, max: 86_400_000 });
    this.sessionCandidateLimit = safeInteger(sessionCandidateLimit, 'session candidate limit', { min: 1, max: 500 });
  }

  async publish({ authorId, idempotencyKey, request }) {
    const normalizedAuthor = normalizeUserId(authorId);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const normalized = normalizePostRequest(request);
    const result = await this.store.acceptPost({
      id: this.uuid(),
      authorId: normalizedAuthor,
      idempotencyKey: normalizedKey,
      requestDigest: sha256(canonicalJson(normalized)),
      content: normalized.content,
      publishedAtMs: this.clock(),
      hotFollowerThreshold: this.hotFollowerThreshold,
      maxAttempts: this.maxFanoutAttempts,
    });
    return {
      created: result.created,
      post: {
        id: result.post.id,
        authorId: result.post.authorId,
        publishedAtMs: result.post.publishedAtMs,
        fanoutMode: result.post.fanoutMode,
        followerCountSnapshot: result.post.followerCountSnapshot,
        deleted: result.post.deletedAtMs !== null,
      },
    };
  }

  async setFollow({ followerId, authorId, active }) {
    const normalizedFollower = normalizeUserId(followerId);
    const normalizedAuthor = normalizeUserId(authorId);
    if (normalizedFollower === normalizedAuthor) throw new ValidationError('users cannot follow themselves');
    if (typeof active !== 'boolean') throw new ValidationError('active must be boolean');
    return this.store.setFollow({
      followerId: normalizedFollower,
      authorId: normalizedAuthor,
      active,
      nowMs: this.clock(),
    });
  }

  async deletePost({ authorId, postId }) {
    return this.store.deletePost({
      authorId: normalizeUserId(authorId),
      postId: normalizeUuid(postId, 'postId'),
      nowMs: this.clock(),
    });
  }

  async getFeed({ viewerId, cursor, limit }) {
    const normalizedViewer = normalizeUserId(viewerId);
    const normalizedLimit = normalizePageLimit(limit);
    const nowMs = this.clock();
    let session;
    let position;
    if (cursor === undefined || cursor === null || cursor === '') {
      const sessionId = this.uuid();
      const expiresAtMs = nowMs + this.sessionTtlMs;
      session = await this.store.createFeedSession({
        viewerId: normalizedViewer,
        sessionId,
        nowMs,
        expiresAtMs,
        candidateLimit: this.sessionCandidateLimit,
      });
      position = 0;
    } else {
      const decoded = this.cursorCodec.decode(cursor);
      session = { sessionId: decoded.sessionId, expiresAtMs: decoded.expiresAtMs };
      position = decoded.position;
    }
    const page = await this.store.readFeedSession({
      viewerId: normalizedViewer,
      sessionId: session.sessionId,
      position,
      limit: normalizedLimit,
      nowMs,
    });
    return {
      items: page.items,
      candidateCount: page.candidateCount,
      nextCursor: page.nextPosition === null ? null : this.cursorCodec.encode({
        sessionId: page.sessionId,
        position: page.nextPosition,
        expiresAtMs: page.expiresAtMs,
      }),
    };
  }
}
