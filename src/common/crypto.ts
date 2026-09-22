import { createHash, randomBytes } from 'node:crypto';

/**
 * API key format is unchanged from the FastAPI backend so existing keys keep
 * working: 'sk-' + 43 url-safe chars, looked up by the first 11 chars,
 * stored as a SHA-256 hex digest.
 */
export const API_KEY_PREFIX_LENGTH = 11;

export function generateApiKey(): { fullKey: string; prefix: string; hashed: string } {
  const raw = randomBytes(32).toString('base64url');
  const fullKey = `sk-${raw}`;
  return { fullKey, prefix: keyPrefixOf(fullKey), hashed: hashApiKey(fullKey) };
}

export function hashApiKey(fullKey: string): string {
  return createHash('sha256').update(fullKey).digest('hex');
}

export function keyPrefixOf(fullKey: string): string {
  return fullKey.slice(0, API_KEY_PREFIX_LENGTH);
}
