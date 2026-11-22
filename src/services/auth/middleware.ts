import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getSessionUser, type AuthUser, type UserRole } from './session_store';
import { getOfficialJurisdictions, isApprovedOfficial } from '../../db/mongo';
import { hashToken } from './tokens';

export const SESSION_COOKIE = 'nd_session';

export interface AuthenticatedRequest extends Request {
  auth?: {
    user: AuthUser;
    sessionToken: string;
    sessionTokenHash: string;
    jurisdictions: string[];
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function getSessionTokenFromRequest(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || null;
}

function shouldUseSecureCookie(): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res: Response, token: string, expiresAt: string): void {
  const maxAgeMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (shouldUseSecureCookie()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (shouldUseSecureCookie()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function isSecureCookieMode(): boolean {
  return shouldUseSecureCookie();
}

function sameOriginOk(req: Request): boolean {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;
  try {
    const host = new URL(String(origin)).host;
    return host === req.headers.host;
  } catch {
    return false;
  }
}

export const attachAuth: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const token = getSessionTokenFromRequest(req);
  if (token) {
    const user = await getSessionUser(token);
    if (user) {
      (req as AuthenticatedRequest).auth = {
        user,
        sessionToken: token,
        sessionTokenHash: hashToken(token),
        jurisdictions: user.role === 'OFFICIAL' ? await getOfficialJurisdictions(user.id) : [],
      };
    }
  }
  next();
};

export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.auth) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOriginOk(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected.' });
  }
  next();
};

export const requireRole = (...roles: UserRole[]): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(authReq.auth.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };

/**
 * Requires an OFFICIAL whose application has been admin-approved.
 * Exported as a factory so the approval lookup can be substituted in tests.
 */
export function createRequireApprovedOfficial(
  checkApproved: (userId: number) => Promise<boolean> = isApprovedOfficial
): RequestHandler {
  return async (req, res, next) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.auth) return res.status(401).json({ error: 'Authentication required.' });
    const { user } = authReq.auth;
    if (user.role === 'ADMIN') return next();
    if (user.role !== 'OFFICIAL') {
      return res.status(403).json({ error: 'Official access is pending administrator approval.' });
    }
    try {
      const approved = await checkApproved(user.id);
      if (!approved) {
        return res.status(403).json({ error: 'Official access is pending administrator approval.' });
      }
      next();
    } catch (err) {
      // Deny access when approval status cannot be verified.
      console.error(JSON.stringify({
        type: 'official_approval_check_failed',
        error: String((err as any)?.message || 'unknown approval check error'),
      }));
      return res.status(403).json({ error: 'Official access is pending administrator approval.' });
    }
  };
}

export const requireApprovedOfficial: RequestHandler = createRequireApprovedOfficial();

export function hasJurisdiction(authReq: AuthenticatedRequest, districtId: string): boolean {
  if (!authReq.auth) return false;
  if (authReq.auth.user.role === 'ADMIN') return true;
  const target = String(districtId || '').toLowerCase().trim();
  return authReq.auth.jurisdictions.includes(target);
}
