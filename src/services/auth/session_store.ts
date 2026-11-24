import { createSession, getSessionUser, revokeSession, revokeAllUserSessions, purgeExpiredSessions, hashToken } from '../../db/mongo';

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

export { createSession, getSessionUser, revokeSession, revokeAllUserSessions, purgeExpiredSessions, hashToken };

export function hashTokenFor(user: { id: number }, token: string): string {
  return hashToken(token);
}
