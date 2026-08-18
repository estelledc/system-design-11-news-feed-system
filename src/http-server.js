import { createServer } from 'node:http';
import { AppError, AuthenticationError, ValidationError } from './errors.js';

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

async function readJson(request, maximumBytes) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new ValidationError('content-type must be application/json');
  }
  const declaredHeader = request.headers['content-length'];
  const declared = declaredHeader === undefined ? null : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new ValidationError('request body is too large');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new ValidationError('request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

function authenticate(request, authTokens) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new AuthenticationError();
  const userId = authTokens.get(authorization.slice('Bearer '.length));
  if (!userId) throw new AuthenticationError();
  return userId;
}

function feedQuery(url) {
  const allowed = new Set(['cursor', 'limit']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ValidationError('feed query parameters are invalid');
    }
  }
  return {
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  };
}

function pathIdentifier(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationError('path identifier is invalid');
  }
}

export function createHttpServer({ service, authTokens, health = async () => true, logger = () => {}, maximumBodyBytes = 8_192 }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        await health();
        json(response, 200, { ok: true });
        return;
      }
      const userId = authenticate(request, authTokens);
      if (request.method === 'POST' && url.pathname === '/v1/posts') {
        const result = await service.publish({
          authorId: userId,
          idempotencyKey: request.headers['idempotency-key'],
          request: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'post_intake', created: result.created, fanoutMode: result.post.fanoutMode });
        json(response, result.created ? 201 : 200, result);
        return;
      }
      const postMatch = url.pathname.match(/^\/v1\/posts\/([^/]+)$/);
      if (request.method === 'DELETE' && postMatch) {
        const result = await service.deletePost({ authorId: userId, postId: postMatch[1] });
        logger({ kind: 'post_deleted', changed: result.deleted });
        json(response, 200, result);
        return;
      }
      const followMatch = url.pathname.match(/^\/v1\/follows\/([^/]+)$/);
      if ((request.method === 'PUT' || request.method === 'DELETE') && followMatch) {
        const result = await service.setFollow({
          followerId: userId,
          authorId: pathIdentifier(followMatch[1]),
          active: request.method === 'PUT',
        });
        logger({ kind: 'follow_changed', active: result.active, changed: result.changed });
        json(response, 200, result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/feed') {
        const result = await service.getFeed({ viewerId: userId, ...feedQuery(url) });
        logger({ kind: 'feed_page', itemCount: result.items.length, hasNext: result.nextCursor !== null });
        json(response, 200, result);
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      const safe = error instanceof AppError ? error : new AppError('Internal error');
      logger({ kind: 'request_failed', code: safe.code, status: safe.status });
      json(response, safe.status, { error: safe.code });
    }
  });
}
