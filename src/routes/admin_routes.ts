import type { Express, Request, Response } from 'express';
import { getDb as getMongoDb, hasDistrict, getReports } from '../db/mongo';
import { insertOfficialJurisdictions } from '../db/mongo';
import {
  listUsers,
  setUserStatus,
  listRoleRequests,
  approveRoleRequest,
  rejectRoleRequest,
  getOfficialJurisdictions,
  getOfficialProfile,
} from '../services/auth/auth_service';
import {
  requireAuth,
  requireRole,
  requireApprovedOfficial,
  hasJurisdiction,
  type AuthenticatedRequest,
} from '../services/auth/middleware';
import { checkRateLimit } from '../services/auth/rate_limit';
import { writeAuditLog } from '../services/auth/audit';

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export function registerAdminRoutes(app: Express): void {
  // ---------- Admin: user management ----------
  app.get('/api/admin/users', requireAuth, requireRole('ADMIN'), async (_req, res) => {
    res.json({ users: await listUsers(200, 0) });
  });

  app.post('/api/admin/users/:id/status', requireAuth, requireRole('ADMIN'), async (req, res) => {
    if (!checkRateLimit(`admin-user-status:${clientIp(req)}`, 60, 3600).allowed) {
      return res.status(429).json({ error: 'Too many requests.' });
    }
    const targetId = Number(req.params.id);
    const { status } = req.body || {};
    const result = await setUserStatus((req as AuthenticatedRequest).auth!.user.id, targetId, status);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  // ---------- Admin: official approvals ----------
  app.get('/api/admin/role-requests', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
    res.json({ role_requests: await listRoleRequests(status) });
  });

  app.post('/api/admin/role-requests/:id/approve', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const id = Number(req.params.id);
    const { jurisdictions } = req.body || {};
    if (!Array.isArray(jurisdictions)) {
      return res.status(400).json({ error: 'jurisdictions must be an array of Telangana district IDs.' });
    }
    const result = await approveRoleRequest(id, (req as AuthenticatedRequest).auth!.user.id, jurisdictions);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  app.post('/api/admin/role-requests/:id/reject', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const id = Number(req.params.id);
    const { note } = req.body || {};
    const result = await rejectRoleRequest(id, (req as AuthenticatedRequest).auth!.user.id, String(note || ''));
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  app.post('/api/admin/officials/:userId/jurisdictions', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const userId = Number(req.params.userId);
    const { jurisdictions } = req.body || {};
    if (!Array.isArray(jurisdictions) || jurisdictions.length === 0) {
      return res.status(400).json({ error: 'jurisdictions must be a non-empty array of district IDs.' });
    }
    const adminId = (req as AuthenticatedRequest).auth!.user.id;
    const valid: string[] = [];
    for (const d of jurisdictions) {
      const id = String(d).toLowerCase().trim();
      if (await hasDistrict(id)) valid.push(id);
    }
    if (valid.length === 0) return res.status(400).json({ error: 'No valid district IDs supplied.' });
    await insertOfficialJurisdictions(userId, valid, adminId, new Date());
    await writeAuditLog({ actorUserId: adminId, actorRole: 'ADMIN', action: 'JURISDICTIONS_UPDATED', entityType: 'user', entityId: userId, details: { jurisdictions: valid } });
    res.json({ success: true, jurisdictions: valid });
  });

  // ---------- Admin: audit logs & overview ----------
  app.get('/api/admin/audit-logs', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const db = getMongoDb();
    const logs = await db.collection('audit_logs').find({}).sort({ _id: -1 }).limit(limit).toArray();
    res.json({ count: logs.length, audit_logs: logs });
  });

  app.get('/api/admin/overview', requireAuth, requireRole('ADMIN'), async (_req, res) => {
    const db = getMongoDb();
    res.json({
      users_total: await db.collection('users').countDocuments({ deleted_at: null }),
      citizens: await db.collection('users').countDocuments({ role: 'CITIZEN', deleted_at: null }),
      officials: await db.collection('users').countDocuments({ role: 'OFFICIAL', deleted_at: null }),
      admins: await db.collection('users').countDocuments({ role: 'ADMIN', deleted_at: null }),
      pending_role_requests: await db.collection('role_requests').countDocuments({ status: 'PENDING' }),
      active_sessions: await db.collection('sessions').countDocuments({ revoked_at: null }),
      audit_events: await db.collection('audit_logs').countDocuments({}),
    });
  });

  // ---------- Official workspace (approved officials + admins) ----------
  app.get('/api/official/me', requireAuth, requireApprovedOfficial, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    res.json({
      user: authReq.auth!.user,
      jurisdictions: authReq.auth!.user.role === 'ADMIN' ? null : authReq.auth!.jurisdictions,
      official_profile: await getOfficialProfile(authReq.auth!.user.id),
    });
  });

  app.get('/api/official/reports', requireAuth, requireApprovedOfficial, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const requested = typeof req.query.district === 'string' ? req.query.district.toLowerCase().trim() : null;
    const isAdmin = authReq.auth!.user.role === 'ADMIN';
    const jurisdictions = authReq.auth!.jurisdictions;

    if (requested && !isAdmin && !jurisdictions.includes(requested)) {
      return res.status(403).json({ error: 'You can only view reports within your assigned jurisdictions.' });
    }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    if (!isAdmin && jurisdictions.length === 0) {
      return res.json({ count: 0, reports: [] });
    }

    const result = await getReports({
      district: isAdmin && requested ? requested : undefined,
      districts: !isAdmin ? jurisdictions : undefined,
      status,
      limit: 100,
    });
    res.json({ count: result.total, reports: result.reports });
  });

  // Convenience alias for citizens: their own reports (uses reporter_user_id when present)
  app.get('/api/citizen/reports', requireAuth, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const result = await getReports({ reporterUserId: authReq.auth!.user.id, limit: 100 });
    res.json({ count: result.total, reports: result.reports });
  });
}
