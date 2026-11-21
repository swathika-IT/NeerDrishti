import { getDb } from '../../db/sqlite';
import { hashPassword, verifyPassword, validatePasswordPolicy } from './password';
import { createToken, hashToken, isoNow, isoInMinutes, isExpired } from './tokens';
import { writeAuditLog } from './audit';
import type { UserRole, UserStatus } from './session_store';
import { buildMailActionUrl, sendTransactionalEmail } from '../email/mail_service';
import { buildPasswordResetEmail, buildVerificationEmail } from '../email/templates';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email);
  return e.length <= 254 && EMAIL_RE.test(e);
}

export interface PublicUser {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  email_verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    status: row.status,
    email_verified: Boolean(row.email_verified_at),
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

export function getUserById(id: number): PublicUser | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, email, full_name, role, status, email_verified_at, created_at, last_login_at
     FROM users WHERE id = ? AND deleted_at IS NULL`
  ).get(id) as unknown as UserRow | undefined;
  return row ? toPublicUser(row) : null;
}

export function getUserByEmail(email: string): UserRow | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, email, password_hash, full_name, role, status, email_verified_at, created_at, last_login_at
     FROM users WHERE email = ? AND deleted_at IS NULL`
  ).get(normalizeEmail(email)) as unknown as UserRow | undefined;
  return row || null;
}

export function countAdmins(): number {
  const db = getDb();
  return Number((db.prepare("SELECT count(*) AS c FROM users WHERE role = 'ADMIN' AND deleted_at IS NULL").get() as any).c);
}

export type EmailDeliveryStatus = 'DRY_RUN' | 'SENT' | 'FAILED' | 'UNKNOWN';

export interface IssuedVerificationToken {
  token: string;
  delivery: EmailDeliveryStatus;
}

export interface RegisterResult {
  success: boolean;
  error?: string;
  user?: PublicUser;
  emailVerification?: 'NOT_SENT_DRY_RUN' | 'SENT' | 'FAILED';
  devVerificationToken?: string;
}

function canExposeDevTokens(): boolean {
  return process.env.AUTH_DEV_EXPOSE_TOKENS === 'true' && process.env.NODE_ENV !== 'production';
}

export async function registerCitizen(email: string, password: string, fullName: string): Promise<RegisterResult> {
  const db = getDb();
  const normEmail = normalizeEmail(email);
  if (!isValidEmail(normEmail)) return { success: false, error: 'A valid email address is required.' };
  if (!fullName || String(fullName).trim().length < 2) return { success: false, error: 'Please provide your full name.' };
  if (String(fullName).length > 120) return { success: false, error: 'Full name is too long.' };
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
  if (existing) {
    // Do not reveal account existence beyond the unavoidable duplicate signal for registration.
    return { success: false, error: 'An account with this email already exists.' };
  }

  const passwordHash = await hashPassword(password);
  const now = isoNow();
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'CITIZEN', 'ACTIVE', ?, ?)`
  ).run(normEmail, passwordHash, String(fullName).trim(), now, now);

  const userId = Number(info.lastInsertRowid);
  const verification = await issueEmailVerification(userId);
  const emailVerification: RegisterResult['emailVerification'] =
    verification.delivery === 'SENT'
      ? 'SENT'
      : verification.delivery === 'FAILED'
        ? 'FAILED'
        : 'NOT_SENT_DRY_RUN';
  const user = getUserById(userId)!;
  writeAuditLog({ actorUserId: userId, actorRole: 'CITIZEN', action: 'USER_REGISTERED', entityType: 'user', entityId: userId });

  const result: RegisterResult = {
    success: true,
    user,
    emailVerification,
  };
  if (canExposeDevTokens()) result.devVerificationToken = verification.token;
  return result;
}

export async function issueEmailVerification(userId: number): Promise<IssuedVerificationToken> {
  const db = getDb();
  const user = db.prepare('SELECT email, full_name FROM users WHERE id = ? AND deleted_at IS NULL').get(userId) as any;
  if (!user) {
    throw new Error('Account not found for verification token.');
  }
  const { token, tokenHash } = createToken();
  db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
  db.prepare(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(userId, tokenHash, isoInMinutes(60 * 24), isoNow());

  const verificationUrl = buildMailActionUrl('verify_email', token);
  const message = buildVerificationEmail({
    recipientName: user.full_name,
    verificationUrl,
    expiresInHours: 24,
  });
  const delivery = await sendTransactionalEmail({ ...message, to: String(user.email) });
  if (delivery.status === 'SENT') {
    console.info(JSON.stringify({ type: 'auth_email', event: 'verification_accepted', channel: 'smtp' }));
  } else if (delivery.status === 'FAILED') {
    console.error(JSON.stringify({ type: 'auth_email', event: 'verification_failed', channel: 'smtp' }));
  } else {
    console.info(JSON.stringify({ type: 'auth_email', event: 'verification_dry_run', channel: 'smtp' }));
  }
  return { token, delivery: delivery.status };
}

export function verifyEmail(token: string): { success: boolean; error?: string } {
  if (!token || typeof token !== 'string') return { success: false, error: 'Verification token is required.' };
  const db = getDb();
  const row = db.prepare(
    'SELECT id, user_id, expires_at, used_at FROM email_verifications WHERE token_hash = ?'
  ).get(hashToken(token)) as any;
  if (!row) return { success: false, error: 'Invalid or expired verification link.' };
  if (row.used_at) return { success: false, error: 'This verification link has already been used.' };
  if (isExpired(row.expires_at)) return { success: false, error: 'Invalid or expired verification link.' };

  db.prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?').run(isoNow(), row.id);
  db.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?').run(isoNow(), isoNow(), row.user_id);
  writeAuditLog({ actorUserId: row.user_id, actorRole: 'CITIZEN', action: 'EMAIL_VERIFIED', entityType: 'user', entityId: row.user_id });
  return { success: true };
}

export interface LoginResult {
  success: boolean;
  error?: string;
  user?: PublicUser;
}

export async function verifyLogin(email: string, password: string): Promise<LoginResult> {
  const row = getUserByEmail(email);
  if (!row) {
    // Perform a dummy compare to reduce timing-based account enumeration.
    await verifyPassword(String(password || ''), '$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ');
    return { success: false, error: 'Invalid email or password.' };
  }
  if (row.status === 'SUSPENDED' || row.status === 'DEACTIVATED') {
    return { success: false, error: 'This account is not active. Contact an administrator.' };
  }
  const ok = await verifyPassword(String(password || ''), row.password_hash);
  if (!ok) return { success: false, error: 'Invalid email or password.' };

  const db = getDb();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(isoNow(), row.id);
  return { success: true, user: toPublicUser(row) };
}

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
  currentSessionTokenHash?: string
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const row = db.prepare('SELECT id, password_hash FROM users WHERE id = ? AND deleted_at IS NULL').get(userId) as any;
  if (!row) return { success: false, error: 'Account not found.' };
  const ok = await verifyPassword(currentPassword || '', row.password_hash);
  if (!ok) return { success: false, error: 'Current password is incorrect.' };
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };

  const newHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, isoNow(), userId);

  if (currentSessionTokenHash) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .run(isoNow(), userId, currentSessionTokenHash);
  } else {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(isoNow(), userId);
  }
  writeAuditLog({ actorUserId: userId, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: userId });
  return { success: true };
}

export interface PasswordResetRequestResult {
  delivery: EmailDeliveryStatus;
  devResetToken?: string;
}

export async function requestPasswordReset(email: string): Promise<PasswordResetRequestResult> {
  const row = getUserByEmail(email);
  // Always behave identically whether or not the account exists.
  if (!row) return { delivery: 'UNKNOWN' };
  const db = getDb();
  const { token, tokenHash } = createToken();
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
  db.prepare(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(row.id, tokenHash, isoInMinutes(30), isoNow());
  writeAuditLog({ actorUserId: row.id, action: 'PASSWORD_RESET_REQUESTED', entityType: 'user', entityId: row.id });

  const resetUrl = buildMailActionUrl('reset_password', token);
  const message = buildPasswordResetEmail({
    recipientName: row.full_name,
    resetUrl,
    expiresInMinutes: 30,
  });
  const delivery = await sendTransactionalEmail({ ...message, to: String(row.email) });
  if (delivery.status === 'SENT') {
    console.info(JSON.stringify({ type: 'auth_email', event: 'password_reset_accepted', channel: 'smtp' }));
  } else if (delivery.status === 'FAILED') {
    console.error(JSON.stringify({ type: 'auth_email', event: 'password_reset_failed', channel: 'smtp' }));
  } else {
    console.info(JSON.stringify({ type: 'auth_email', event: 'password_reset_dry_run', channel: 'smtp' }));
  }

  return canExposeDevTokens()
    ? { delivery: delivery.status, devResetToken: token }
    : { delivery: delivery.status };
}

export async function resetPassword(token: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  if (!token || typeof token !== 'string') return { success: false, error: 'Reset token is required.' };
  const db = getDb();
  const row = db.prepare(
    'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?'
  ).get(hashToken(token)) as any;
  if (!row || row.used_at || isExpired(row.expires_at)) {
    return { success: false, error: 'Invalid or expired reset link.' };
  }
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };

  const newHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, isoNow(), row.user_id);
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(isoNow(), row.id);
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(isoNow(), row.user_id);
  writeAuditLog({ actorUserId: row.user_id, action: 'PASSWORD_RESET_COMPLETED', entityType: 'user', entityId: row.user_id });
  return { success: true };
}

// ---------------------------------------------------------------
// Role / official management (used by admin routes)
// ---------------------------------------------------------------

export interface RoleRequestRow {
  id: number;
  user_id: number;
  requested_role: string;
  reason: string | null;
  department: string | null;
  status: string;
  created_at: string;
  email?: string;
  full_name?: string;
}

export function createRoleRequest(userId: number, reason: string, department: string): { success: boolean; error?: string } {
  const db = getDb();
  const pending = db.prepare(
    "SELECT id FROM role_requests WHERE user_id = ? AND status = 'PENDING'"
  ).get(userId);
  if (pending) return { success: false, error: 'You already have a pending official access request.' };
  db.prepare(
    `INSERT INTO role_requests (user_id, requested_role, reason, department, status, created_at)
     VALUES (?, 'OFFICIAL', ?, ?, 'PENDING', ?)`
  ).run(userId, reason || null, department || null, isoNow());
  writeAuditLog({ actorUserId: userId, action: 'ROLE_REQUEST_SUBMITTED', entityType: 'role_request', entityId: userId });
  return { success: true };
}

export function listRoleRequests(status?: string): RoleRequestRow[] {
  const db = getDb();
  const base = `SELECT rr.*, u.email AS email, u.full_name AS full_name
                FROM role_requests rr JOIN users u ON u.id = rr.user_id`;
  return (status
    ? db.prepare(`${base} WHERE rr.status = ? ORDER BY rr.created_at DESC`).all(status)
    : db.prepare(`${base} ORDER BY rr.created_at DESC`).all(status)) as unknown as RoleRequestRow[];
}

export function approveRoleRequest(requestId: number, adminUserId: number, jurisdictions: string[]): { success: boolean; error?: string } {
  const db = getDb();
  const req = db.prepare('SELECT * FROM role_requests WHERE id = ?').get(requestId) as any;
  if (!req) return { success: false, error: 'Role request not found.' };
  if (req.status !== 'PENDING') return { success: false, error: 'This request has already been reviewed.' };

  const validDistricts = jurisdictions
    .map(j => String(j).toLowerCase().trim())
    .filter(j => db.prepare('SELECT 1 FROM districts WHERE district_id = ?').get(j));
  if (validDistricts.length === 0) {
    return { success: false, error: 'At least one valid Telangana district jurisdiction is required.' };
  }

  const now = isoNow();
  db.prepare("UPDATE role_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .run(adminUserId, now, requestId);
  db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run('OFFICIAL', now, req.user_id);

  const existingProfile = db.prepare('SELECT user_id FROM official_profiles WHERE user_id = ?').get(req.user_id);
  if (existingProfile) {
    db.prepare("UPDATE official_profiles SET department = ?, approval_status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ? WHERE user_id = ?")
      .run(req.department || 'State Department', adminUserId, now, now, req.user_id);
  } else {
    db.prepare(
      `INSERT INTO official_profiles (user_id, department, approval_status, approved_by, approved_at, created_at, updated_at)
       VALUES (?, ?, 'APPROVED', ?, ?, ?, ?)`
    ).run(req.user_id, req.department || 'State Department', adminUserId, now, now, now);
  }

  for (const districtId of validDistricts) {
    db.prepare(
      `INSERT INTO official_jurisdictions (official_user_id, district_id, granted_by, granted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(official_user_id, district_id) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`
    ).run(req.user_id, districtId, adminUserId, now);
  }

  writeAuditLog({
    actorUserId: adminUserId,
    actorRole: 'ADMIN',
    action: 'ROLE_REQUEST_APPROVED',
    entityType: 'user',
    entityId: req.user_id,
    details: { requestId, jurisdictions: validDistricts },
  });
  return { success: true };
}

export function rejectRoleRequest(requestId: number, adminUserId: number, note: string): { success: boolean; error?: string } {
  const db = getDb();
  const req = db.prepare('SELECT * FROM role_requests WHERE id = ?').get(requestId) as any;
  if (!req) return { success: false, error: 'Role request not found.' };
  if (req.status !== 'PENDING') return { success: false, error: 'This request has already been reviewed.' };
  db.prepare("UPDATE role_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?")
    .run(adminUserId, isoNow(), note || null, requestId);
  writeAuditLog({ actorUserId: adminUserId, actorRole: 'ADMIN', action: 'ROLE_REQUEST_REJECTED', entityType: 'user', entityId: req.user_id, details: { requestId, note } });
  return { success: true };
}

export function getOfficialJurisdictions(userId: number): string[] {
  const db = getDb();
  return (db.prepare('SELECT district_id FROM official_jurisdictions WHERE official_user_id = ?').all(userId) as any[])
    .map(r => r.district_id);
}

export function getOfficialProfile(userId: number): any | null {
  const db = getDb();
  return db.prepare('SELECT * FROM official_profiles WHERE user_id = ?').get(userId) || null;
}

export function isApprovedOfficial(userId: number): boolean {
  const profile = getOfficialProfile(userId);
  return Boolean(profile && profile.approval_status === 'APPROVED');
}

export function listUsers(limit: number = 100, offset: number = 0): PublicUser[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, email, full_name, role, status, email_verified_at, created_at, last_login_at
     FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(limit, offset) as unknown as UserRow[];
  return rows.map(toPublicUser);
}

export function setUserStatus(adminUserId: number, targetUserId: number, status: UserStatus): { success: boolean; error?: string } {
  const allowed: UserStatus[] = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'];
  if (!allowed.includes(status)) return { success: false, error: 'Invalid status.' };
  const db = getDb();
  const target = db.prepare('SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL').get(targetUserId) as any;
  if (!target) return { success: false, error: 'User not found.' };
  if (target.id === adminUserId && status !== 'ACTIVE') {
    return { success: false, error: 'Administrators cannot suspend or deactivate their own account.' };
  }
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, isoNow(), targetUserId);
  if (status !== 'ACTIVE') {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(isoNow(), targetUserId);
  }
  writeAuditLog({ actorUserId: adminUserId, actorRole: 'ADMIN', action: 'USER_STATUS_CHANGED', entityType: 'user', entityId: targetUserId, details: { status } });
  return { success: true };
}

export async function createFirstAdmin(email: string, password: string): Promise<{ success: boolean; error?: string; user?: PublicUser }> {
  if (countAdmins() > 0) {
    return { success: false, error: 'An administrator already exists. Setup is disabled.' };
  }
  const normEmail = normalizeEmail(email);
  if (!isValidEmail(normEmail)) return { success: false, error: 'A valid email address is required.' };
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };
  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail)) {
    return { success: false, error: 'An account with this email already exists.' };
  }
  const passwordHash = await hashPassword(password);
  const now = isoNow();
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, created_at, updated_at)
     VALUES (?, ?, 'Administrator', 'ADMIN', 'ACTIVE', ?, ?, ?)`
  ).run(normEmail, passwordHash, now, now, now);
  const userId = Number(info.lastInsertRowid);
  writeAuditLog({ actorUserId: userId, actorRole: 'ADMIN', action: 'FIRST_ADMIN_CREATED', entityType: 'user', entityId: userId });
  return { success: true, user: getUserById(userId)! };
}
