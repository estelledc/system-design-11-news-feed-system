import { ValidationError } from './errors.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function boundedIdentifier(value, label, { min = 1, max = 128 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !identifierPattern.test(value)) {
    throw new ValidationError(`${label} must be ${min}-${max} safe identifier characters`);
  }
  return value;
}

export function normalizeUserId(value) {
  return boundedIdentifier(value, 'userId', { max: 64 });
}

export function normalizeIdempotencyKey(value) {
  return boundedIdentifier(value, 'idempotency key', { min: 16, max: 128 });
}

export function normalizePostRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('post request must be an object');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => key !== 'content')) {
    throw new ValidationError('post request contains unsupported fields');
  }
  if (typeof value.content !== 'string' || value.content.trim().length === 0) {
    throw new ValidationError('content must be a nonempty string');
  }
  const bytes = Buffer.byteLength(value.content);
  if (bytes > 4_096) throw new ValidationError('content exceeds the 4 KiB UTF-8 limit');
  return { content: value.content };
}

export function normalizeUuid(value, label) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new ValidationError(`${label} must be a UUID`);
  return value.toLowerCase();
}

export function normalizePageLimit(value, fallback = 20) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new ValidationError('feed limit must be an integer between 1 and 50');
  }
  return parsed;
}

export function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}
