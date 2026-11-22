import type { AuthUser, UserStatus } from './session_store';

/**
 * Maps a MongoDB user document to the public AuthUser contract.
 * Never includes password_hash or other credential material.
 * Suspended/deactivated accounts are rejected so existing sessions stop working.
 */
export function toAuthUser(row: any): AuthUser | null {
  if (!row) return null;
  const status = row.status as UserStatus;
  if (status === 'SUSPENDED' || status === 'DEACTIVATED') return null;

  const idValue = row._id ?? row.id;
  const numericId = Number(idValue);
  if (!Number.isFinite(numericId)) return null;

  return {
    id: numericId,
    email: String(row.email ?? ''),
    full_name: String(row.full_name ?? ''),
    role: row.role as AuthUser['role'],
    status,
    phone: row.phone ?? null,
    phone_verified: row.phone_verified ? 1 : 0,
    email_verified_at: row.email_verified_at ?? null,
    email_verified: Boolean(row.email_verified_at),
    created_at: row.created_at,
    last_login_at: row.last_login_at ?? null,
  };
}
