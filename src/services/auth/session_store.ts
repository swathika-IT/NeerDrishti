import { getDb } from '../../db/sqlite';
import { createToken, hashToken, isoNow } from './tokens';

export type UserRole = 'CITIZEN' | 'OFFICIAL' | 'ADMIN';
export type UserStatus = 'PENDING_EMAIL' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export interface AuthUser {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  phone: string | null;
  phone_verified: number;
  email_verified_at: string | null;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface SessionRecord {
  user_id: number;
  expires_at: string;
  revoked_at: string | null;
}

const SESSION_TTL_HOURS = 12 * 7;

export function createSession(userId: number, ip: string | null, userAgent: string | null): {
  token: string;
  expiresAt: string;
} {
  const db = getDb();
  const { token, tokenHash } = createToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(tokenHash, userId, isoNow(), expiresAt, ip, userAgent);
  return { token, expiresAt };
}

export function getSessionUser(token: string): AuthUser | null {
  if (!token) return null;
  const db = getDb();
  const tokenHash = hashToken(token);
  const row = db.prepare(
    `SELECT s.expires_at AS session_expires_at, s.revoked_at AS session_revoked_at,
            u.id, u.email, u.full_name, u.role, u.status, u.phone, u.phone_verified,
            u.email_verified_at, u.created_at, u.last_login_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).get(tokenHash) as any;
  if (!row) return null;
  if (row.session_revoked_at) return null;
  if (new Date(row.session_expires_at).getTime() <= Date.now()) return null;
  if (row.status === 'SUSPENDED' || row.status === 'DEACTIVATED') return null;
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    status: row.status,
    phone: row.phone,
    phone_verified: row.phone_verified,
    email_verified_at: row.email_verified_at,
    email_verified: Boolean(row.email_verified_at),
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

export function revokeSession(token: string): void {
  if (!token) return;
  const db = getDb();
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(isoNow(), hashToken(token));
}

export function revokeAllUserSessions(userId: number, exceptTokenHash?: string): void {
  const db = getDb();
  if (exceptTokenHash) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .run(isoNow(), userId, exceptTokenHash);
  } else {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(isoNow(), userId);
  }
}

export function hashTokenFor(user: { id: number }, token: string): string {
  return hashToken(token);
}

export function purgeExpiredSessions(): number {
  const db = getDb();
  const res = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(isoNow());
  return Number(res.changes || 0);
}
