import {
  insertUser, findUserById, findUserByEmailNorm, updateUserEmailVerified, updateUserLastLogin, updateUserPassword,
  countAdmins as countAdminsMongo, insertEmailVerification, findEmailVerificationByTokenHash,
  markEmailVerificationUsed, insertPasswordReset, findPasswordResetByTokenHash, markPasswordResetUsed,
  getUserPendingRoleRequest, listRoleRequests, getOfficialProfile, isApprovedOfficial, getOfficialJurisdictions,
  writeAuditLog, listUsers, revokeAllUserSessions, setUserStatus as setUserStatusMongo,
} from '../../db/mongo';
import { hashPassword, verifyPassword, validatePasswordPolicy } from './password';
import { createToken, hashToken, isoNow, isoInMinutes, isExpired } from './tokens';
import type { UserRole, UserStatus } from './session_store';
import { buildMailActionUrl, sendTransactionalEmail } from '../email/mail_service';
import { buildPasswordResetEmail, buildVerificationEmail } from '../email/templates';

export { createRoleRequest, approveRoleRequest, rejectRoleRequest, listRoleRequests, listUsers, getOfficialProfile, isApprovedOfficial, getOfficialJurisdictions } from '../../db/mongo';

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

function toPublicUser(row: any): PublicUser | null {
  if (!row) return null;
  return {
    id: Number(row._id),
    email: row.email,
    full_name: row.full_name,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    email_verified: Boolean(row.email_verified_at),
    created_at: row.created_at,
    last_login_at: row.last_login_at ?? null,
  };
}

export async function getUserById(id: number): Promise<PublicUser | null> {
  return toPublicUser(await findUserById(id));
}

export async function getUserByEmail(email: string): Promise<any> {
  return await findUserByEmailNorm(normalizeEmail(email));
}

export async function countAdmins(): Promise<number> {
  return countAdminsMongo();
}

export function canExposeDevTokens(): boolean {
  return process.env.AUTH_DEV_EXPOSE_TOKENS === 'true' && process.env.NODE_ENV !== 'production';
}

export async function registerCitizen(email: string, password: string, fullName: string): Promise<{ success: boolean; error?: string; user?: PublicUser; emailVerification?: string; devVerificationToken?: string }> {
  const normEmail = normalizeEmail(email);
  if (!isValidEmail(normEmail)) return { success: false, error: 'A valid email address is required.' };
  if (!fullName || String(fullName).trim().length < 2) return { success: false, error: 'Please provide your full name.' };
  if (String(fullName).length > 120) return { success: false, error: 'Full name is too long.' };
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };

  const existing = await findUserByEmailNorm(normEmail);
  if (existing) return { success: false, error: 'An account with this email already exists.' };

  const passwordHash = await hashPassword(password);
  const now = isoNow();
  const userId = await insertUser({
    email: normEmail,
    password_hash: passwordHash,
    full_name: String(fullName).trim(),
    role: 'CITIZEN',
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
  const verification = await issueEmailVerification(userId);
  const emailVerification = verification.delivery === 'SENT' ? 'SENT' : verification.delivery === 'FAILED' ? 'FAILED' : 'NOT_SENT_DRY_RUN';
  const user = await getUserById(userId);
  await writeAuditLog({ actorUserId: userId, actorRole: 'CITIZEN', action: 'USER_REGISTERED', entityType: 'user', entityId: userId });
  const result: { success: boolean; user?: PublicUser; emailVerification?: string; devVerificationToken?: string } = {
    success: true,
    user: user ?? undefined,
    emailVerification,
  };
  if (canExposeDevTokens()) result.devVerificationToken = verification.token;
  return result;
}

export async function issueEmailVerification(userId: number): Promise<{ token: string; delivery: 'DRY_RUN' | 'SENT' | 'FAILED' | 'UNKNOWN' }> {
  const user = await findUserById(userId);
  if (!user) throw new Error('Account not found for verification token.');
  const { token, tokenHash } = createToken();
  await insertEmailVerification(userId, tokenHash, isoInMinutes(60 * 24), isoNow());

  const verificationUrl = buildMailActionUrl('verify_email', token);
  const message = buildVerificationEmail({ recipientName: user.full_name, verificationUrl, expiresInHours: 24 });
  const delivery = await sendTransactionalEmail({ ...message, to: String(user.email) });
  if (delivery.status === 'SENT') console.info(JSON.stringify({ type: 'auth_email', event: 'verification_accepted', channel: 'smtp' }));
  else if (delivery.status === 'FAILED') console.error(JSON.stringify({ type: 'auth_email', event: 'verification_failed', channel: 'smtp' }));
  else console.info(JSON.stringify({ type: 'auth_email', event: 'verification_dry_run', channel: 'smtp' }));
  return { token, delivery: delivery.status };
}

export async function verifyEmail(token: string): Promise<{ success: boolean; error?: string }> {
  if (!token || typeof token !== 'string') return { success: false, error: 'Verification token is required.' };
  const row = await findEmailVerificationByTokenHash(hashToken(token));
  if (!row) return { success: false, error: 'Invalid or expired verification link.' };
  if (row.used_at) return { success: false, error: 'This verification link has already been used.' };
  if (isExpired(row.expires_at)) return { success: false, error: 'Invalid or expired verification link.' };

  await markEmailVerificationUsed(Number(row._id));
  await updateUserEmailVerified(row.user_id);
  await writeAuditLog({ actorUserId: row.user_id, actorRole: 'CITIZEN', action: 'EMAIL_VERIFIED', entityType: 'user', entityId: row.user_id });
  return { success: true };
}

export async function verifyLogin(email: string, password: string): Promise<{ success: boolean; error?: string; user?: PublicUser }> {
  const row = await getUserByEmail(email);
  if (!row) {
    await verifyPassword(String(password || ''), '$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ');
    return { success: false, error: 'Invalid email or password.' };
  }
  if (row.status === 'SUSPENDED' || row.status === 'DEACTIVATED') {
    return { success: false, error: 'This account is not active. Contact an administrator.' };
  }
  const ok = await verifyPassword(String(password || ''), row.password_hash);
  if (!ok) return { success: false, error: 'Invalid email or password.' };

  await updateUserLastLogin(Number(row._id));
  return { success: true, user: toPublicUser(row) };
}

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
  currentSessionTokenHash?: string
): Promise<{ success: boolean; error?: string }> {
  const row = await findUserById(userId);
  if (!row) return { success: false, error: 'Account not found.' };
  const ok = await verifyPassword(currentPassword || '', row.password_hash);
  if (!ok) return { success: false, error: 'Current password is incorrect.' };
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };

  const newHash = await hashPassword(newPassword);
  await updateUserPassword(userId, newHash);

  if (currentSessionTokenHash) {
    await revokeAllUserSessions(userId, currentSessionTokenHash);
  } else {
    await revokeAllUserSessions(userId);
  }
  await writeAuditLog({ actorUserId: userId, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: userId });
  return { success: true };
}

export async function requestPasswordReset(email: string): Promise<{ delivery: 'DRY_RUN' | 'SENT' | 'FAILED' | 'UNKNOWN'; devResetToken?: string }> {
  const row = await getUserByEmail(email);
  if (!row) return { delivery: 'UNKNOWN' };
  const { token, tokenHash } = createToken();
  await insertPasswordReset(Number(row._id), tokenHash, isoInMinutes(30), isoNow());
  await writeAuditLog({ actorUserId: Number(row._id), action: 'PASSWORD_RESET_REQUESTED', entityType: 'user', entityId: Number(row._id) });

  const resetUrl = buildMailActionUrl('reset_password', token);
  const message = buildPasswordResetEmail({ recipientName: row.full_name, resetUrl, expiresInMinutes: 30 });
  const delivery = await sendTransactionalEmail({ ...message, to: String(row.email) });
  if (delivery.status === 'SENT') console.info(JSON.stringify({ type: 'auth_email', event: 'password_reset_accepted', channel: 'smtp' }));
  else if (delivery.status === 'FAILED') console.error(JSON.stringify({ type: 'auth_email', event: 'password_reset_failed', channel: 'smtp' }));
  else console.info(JSON.stringify({ type: 'auth_email', event: 'password_reset_dry_run', channel: 'smtp' }));
  return canExposeDevTokens() ? { delivery: delivery.status, devResetToken: token } : { delivery: delivery.status };
}

export async function resetPassword(token: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  if (!token || typeof token !== 'string') return { success: false, error: 'Reset token is required.' };
  const row = await findPasswordResetByTokenHash(hashToken(token));
  if (!row || row.used_at || isExpired(row.expires_at)) return { success: false, error: 'Invalid or expired reset link.' };
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };

  const newHash = await hashPassword(newPassword);
  await updateUserPassword(Number(row.user_id), newHash);
  await markPasswordResetUsed(Number(row._id));
  await revokeAllUserSessions(Number(row.user_id));
  await writeAuditLog({ actorUserId: Number(row.user_id), action: 'PASSWORD_RESET_COMPLETED', entityType: 'user', entityId: Number(row.user_id) });
  return { success: true };
}

export async function setUserStatus(adminUserId: number, targetUserId: number, status: UserStatus): Promise<{ success: boolean; error?: string }> {
  const allowed: string[] = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'];
  if (!allowed.includes(status)) return { success: false, error: 'Invalid status.' };
  const target = await findUserById(targetUserId);
  if (!target) return { success: false, error: 'User not found.' };
  if (Number(target._id) === adminUserId && status !== 'ACTIVE') {
    return { success: false, error: 'Administrators cannot suspend or deactivate their own account.' };
  }
  await setUserStatusMongo(targetUserId, status);
  if (status !== 'ACTIVE') {
    await revokeAllUserSessions(targetUserId);
  }
  await writeAuditLog({ actorUserId: adminUserId, actorRole: 'ADMIN', action: 'USER_STATUS_CHANGED', entityType: 'user', entityId: targetUserId, details: { status } });
  return { success: true };
}

export async function createFirstAdmin(email: string, password: string): Promise<{ success: boolean; error?: string; user?: PublicUser }> {
  if (await countAdminsMongo()) {
    return { success: false, error: 'An administrator already exists. Setup is disabled.' };
  }
  const normEmail = normalizeEmail(email);
  if (!isValidEmail(normEmail)) return { success: false, error: 'A valid email address is required.' };
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) return { success: false, error: policy.errors.join(' ') };
  const existing = await findUserByEmailNorm(normEmail);
  if (existing) return { success: false, error: 'An account with this email already exists.' };

  const passwordHash = await hashPassword(password);
  const now = isoNow();
  const userId = await insertUser({
    email: normEmail,
    password_hash: passwordHash,
    full_name: 'Administrator',
    role: 'ADMIN',
    status: 'ACTIVE',
    email_verified_at: now,
    created_at: now,
    updated_at: now,
  });
  await writeAuditLog({ actorUserId: userId, actorRole: 'ADMIN', action: 'FIRST_ADMIN_CREATED', entityType: 'user', entityId: userId });
  return { success: true, user: (await getUserById(userId))! };
}
