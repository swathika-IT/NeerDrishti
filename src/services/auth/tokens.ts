import crypto from 'crypto';

/** Returns a cryptographically random, URL-safe token and its sha256 hex digest. */
export function createToken(bytes: number = 32): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(bytes).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function isoInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function isExpired(isoTimestamp: string | null | undefined): boolean {
  if (!isoTimestamp) return true;
  const t = new Date(isoTimestamp).getTime();
  return Number.isNaN(t) || t <= Date.now();
}
