import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { normalizeUuid, safeInteger } from './contracts.js';
import { ValidationError } from './errors.js';

const encodedPartPattern = /^[A-Za-z0-9_-]+$/;

function secretBuffer(secret) {
  const value = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret ?? ''), 'utf8');
  if (value.byteLength < 32 || value.byteLength > 256) {
    throw new ValidationError('cursor secret must contain 32-256 bytes');
  }
  return value;
}

function decodePart(value) {
  if (!encodedPartPattern.test(value)) throw new ValidationError('cursor encoding is invalid');
  return Buffer.from(value, 'base64url');
}

export class CursorCodec {
  constructor({ secret, clock = Date.now }) {
    this.secret = secretBuffer(secret);
    this.clock = clock;
  }

  encode({ sessionId, position, expiresAtMs }) {
    const payload = canonicalJson({
      expiresAtMs: safeInteger(expiresAtMs, 'cursor expiry', { min: 1 }),
      position: safeInteger(position, 'cursor position', { max: 500 }),
      sessionId: normalizeUuid(sessionId, 'sessionId'),
      version: 1,
    });
    const encoded = Buffer.from(payload).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  decode(value) {
    if (typeof value !== 'string' || value.length < 20 || value.length > 1_024) {
      throw new ValidationError('cursor is invalid');
    }
    const parts = value.split('.');
    if (parts.length !== 2) throw new ValidationError('cursor is invalid');
    const [encoded, signature] = parts;
    const actual = decodePart(signature);
    const expected = createHmac('sha256', this.secret).update(encoded).digest();
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new ValidationError('cursor signature is invalid');
    }
    let payload;
    try {
      payload = JSON.parse(decodePart(encoded).toString('utf8'));
    } catch {
      throw new ValidationError('cursor payload is invalid');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError('cursor payload is invalid');
    }
    const keys = Object.keys(payload).sort();
    if (canonicalJson(keys) !== canonicalJson(['expiresAtMs', 'position', 'sessionId', 'version'])) {
      throw new ValidationError('cursor payload fields are invalid');
    }
    if (payload.version !== 1) throw new ValidationError('cursor version is unsupported');
    const result = {
      sessionId: normalizeUuid(payload.sessionId, 'sessionId'),
      position: safeInteger(payload.position, 'cursor position', { max: 500 }),
      expiresAtMs: safeInteger(payload.expiresAtMs, 'cursor expiry', { min: 1 }),
    };
    if (result.expiresAtMs <= this.clock()) throw new ValidationError('cursor has expired');
    return result;
  }
}
