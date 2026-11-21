import type { Express, Request, Response } from 'express';
import {
  registerCitizen,
  verifyLogin,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  changePassword,
  createRoleRequest,
  createFirstAdmin,
  issueEmailVerification,
} from '../services/auth/auth_service';
import {
  createSession,
  revokeSession,
  getSessionUser,
} from '../services/auth/session_store';
import {
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
  requireAuth,
  isSecureCookieMode,
  type AuthenticatedRequest,
} from '../services/auth/middleware';
import { checkRateLimit } from '../services/auth/rate_limit';
import { writeAuditLog } from '../services/auth/audit';
import { verifySetupToken, invalidateSetupToken, isSetupAvailable } from '../services/auth/setup';

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimit(req: Request, res: Response, bucket: string, max: number, windowSeconds: number): boolean {
  const result = checkRateLimit(`${bucket}:${clientIp(req)}`, max, windowSeconds);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    return false;
  }
  return true;
}

export function registerAuthRoutes(app: Express): void {
  // ---- First-admin bootstrap (one-time, token-gated) ----
  app.get('/api/auth/setup-status', (_req, res) => {
    res.json({ setup_available: isSetupAvailable(), secure_cookies: isSecureCookieMode() });
  });

  app.post('/api/auth/setup-admin', async (req, res) => {
    if (!rateLimit(req, res, 'setup-admin', 10, 3600)) return;
    const { token, email, password } = req.body || {};
    const check = verifySetupToken(String(token || ''));
    if (!check.valid) {
      return res.status(403).json({ error: check.error || 'Setup is not available.' });
    }
    const result = await createFirstAdmin(String(email || ''), String(password || ''));
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    invalidateSetupToken();
    writeAuditLog({ actorUserId: result.user?.id, actorRole: 'ADMIN', action: 'FIRST_ADMIN_SETUP_COMPLETED', entityType: 'user', entityId: result.user?.id, ip: clientIp(req) });
    res.status(201).json({ success: true, user: result.user });
  });

  // ---- Registration ----
  app.post('/api/auth/register', async (req, res) => {
    if (!rateLimit(req, res, 'register', 5, 3600)) return;
    const { email, password, full_name } = req.body || {};
    try {
      const result = await registerCitizen(String(email || ''), String(password || ''), String(full_name || ''));
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      writeAuditLog({ actorUserId: result.user?.id, action: 'REGISTER_API', entityType: 'user', entityId: result.user?.id, ip: clientIp(req) });
      res.status(201).json({
        success: true,
        user: result.user,
        email_verification: result.emailVerification || 'NOT_SENT_DRY_RUN',
        message: result.emailVerification === 'SENT'
          ? 'Account created. Verification email was accepted by the configured mail provider.'
          : 'Account created. No verification email is delivered while mail delivery is disabled.',
        ...(result.devVerificationToken ? { dev_verification_token: result.devVerificationToken } : {}),
      });
    } catch (err) {
      console.error('Error in /api/auth/register:', err);
      res.status(500).json({ error: 'Registration failed.' });
    }
  });

  // ---- Login / logout / session ----
  app.post('/api/auth/login', async (req, res) => {
    if (!rateLimit(req, res, 'login', 10, 900)) return;
    const { email, password } = req.body || {};
    try {
      const result = await verifyLogin(String(email || ''), String(password || ''));
      if (!result.success || !result.user) {
        writeAuditLog({ action: 'LOGIN_FAILED', entityType: 'user', entityId: result.user?.id ?? null, details: { email: String(email || '').toLowerCase() }, ip: clientIp(req) });
        return res.status(401).json({ error: result.error || 'Invalid email or password.' });
      }
      const session = createSession(result.user.id, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300));
      setSessionCookie(res, session.token, session.expiresAt);
      writeAuditLog({ actorUserId: result.user.id, actorRole: result.user.role, action: 'LOGIN_SUCCESS', entityType: 'user', entityId: result.user.id, ip: clientIp(req) });
      res.json({ success: true, user: result.user, session_expires_at: session.expiresAt });
    } catch (err) {
      console.error('Error in /api/auth/login:', err);
      res.status(500).json({ error: 'Login failed.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = getSessionTokenFromRequest(req);
    if (token) {
      const user = getSessionUser(token);
      revokeSession(token);
      writeAuditLog({ actorUserId: user?.id ?? null, action: 'LOGOUT', entityType: 'session', entityId: null, ip: clientIp(req) });
    }
    clearSessionCookie(res);
    res.json({ success: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const token = getSessionTokenFromRequest(req);
    const user = token ? getSessionUser(token) : null;
    res.json({ user: user || null });
  });

  // ---- Email verification ----
  app.post('/api/auth/verify-email', (req, res) => {
    if (!rateLimit(req, res, 'verify-email', 20, 3600)) return;
    const { token } = req.body || {};
    const result = verifyEmail(String(token || ''));
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, message: 'Email verified.' });
  });

  app.post('/api/auth/resend-verification', requireAuth, async (req, res) => {
    if (!rateLimit(req, res, 'resend-verification', 5, 3600)) return;
    const authReq = req as AuthenticatedRequest;
    const issued = await issueEmailVerification(authReq.auth!.user.id);
    const devTokensAllowed = process.env.AUTH_DEV_EXPOSE_TOKENS === 'true' && process.env.NODE_ENV !== 'production';
    writeAuditLog({ actorUserId: authReq.auth!.user.id, action: 'VERIFICATION_RESENT', entityType: 'user', entityId: authReq.auth!.user.id, ip: clientIp(req) });
    res.json({
      success: true,
      email_verification: issued.delivery === 'SENT'
        ? 'SENT'
        : issued.delivery === 'FAILED'
          ? 'FAILED'
          : 'NOT_SENT_DRY_RUN',
      message: issued.delivery === 'SENT'
        ? 'Verification email was accepted by the configured mail provider.'
        : 'No verification email is delivered while mail delivery is disabled.',
      ...(devTokensAllowed ? { dev_verification_token: issued.token } : {}),
    });
  });

  // ---- Password management ----
  app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    if (!rateLimit(req, res, 'change-password', 10, 3600)) return;
    const authReq = req as AuthenticatedRequest;
    const { current_password, new_password } = req.body || {};
    const result = await changePassword(
      authReq.auth!.user.id,
      String(current_password || ''),
      String(new_password || ''),
      authReq.auth!.sessionTokenHash
    );
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, message: 'Password changed. Other sessions were signed out.' });
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    if (!rateLimit(req, res, 'forgot-password', 5, 900)) return;
    const { email } = req.body || {};
    const result = await requestPasswordReset(String(email || ''));
    writeAuditLog({ action: 'PASSWORD_RESET_REQUEST_API', entityType: 'user', entityId: null, details: { email: String(email || '').toLowerCase() }, ip: clientIp(req) });
    res.json({
      success: true,
      message: 'If that email is registered, a reset email will be processed according to the server mail mode. No reset email is delivered while MAIL_DRY_RUN=true.',
      ...(result.devResetToken ? { dev_reset_token: result.devResetToken } : {}),
    });
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    if (!rateLimit(req, res, 'reset-password', 10, 3600)) return;
    const { token, new_password } = req.body || {};
    const result = await resetPassword(String(token || ''), String(new_password || ''));
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, message: 'Password reset. Please sign in again.' });
  });

  // ---- Official access request (citizen-initiated) ----
  app.post('/api/auth/role-request', requireAuth, (req, res) => {
    if (!rateLimit(req, res, 'role-request', 5, 86400)) return;
    const authReq = req as AuthenticatedRequest;
    const { reason, department } = req.body || {};
    if (authReq.auth!.user.role !== 'CITIZEN') {
      return res.status(400).json({ error: 'Only citizen accounts can request official access.' });
    }
    const result = createRoleRequest(authReq.auth!.user.id, String(reason || ''), String(department || ''));
    if (!result.success) return res.status(400).json({ error: result.error });
    res.status(201).json({ success: true, message: 'Official access request submitted for administrator review.' });
  });
}
