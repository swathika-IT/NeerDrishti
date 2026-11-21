import type { Express, Request, Response } from 'express';
import { getDb } from '../db/sqlite';
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
  app.get('/api/admin/users', requireAuth, requireRole('ADMIN'), (_req, res) => {
    res.json({ users: listUsers(200, 0) });
  });

  app.post('/api/admin/users/:id/status', requireAuth, requireRole('ADMIN'), (req, res) => {
    if (!checkRateLimit(`admin-user-status:${clientIp(req)}`, 60, 3600).allowed) {
      return res.status(429).json({ error: 'Too many requests.' });
    }
    const targetId = Number(req.params.id);
    const { status } = req.body || {};
    const result = setUserStatus((req as AuthenticatedRequest).auth!.user.id, targetId, status);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  // ---------- Admin: official approvals ----------
  app.get('/api/admin/role-requests', requireAuth, requireRole('ADMIN'), (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
    res.json({ role_requests: listRoleRequests(status) });
  });

  app.post('/api/admin/role-requests/:id/approve', requireAuth, requireRole('ADMIN'), (req, res) => {
    const id = Number(req.params.id);
    const { jurisdictions } = req.body || {};
    if (!Array.isArray(jurisdictions)) {
      return res.status(400).json({ error: 'jurisdictions must be an array of Telangana district IDs.' });
    }
    const result = approveRoleRequest(id, (req as AuthenticatedRequest).auth!.user.id, jurisdictions);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  app.post('/api/admin/role-requests/:id/reject', requireAuth, requireRole('ADMIN'), (req, res) => {
    const id = Number(req.params.id);
    const { note } = req.body || {};
    const result = rejectRoleRequest(id, (req as AuthenticatedRequest).auth!.user.id, String(note || ''));
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  app.post('/api/admin/officials/:userId/jurisdictions', requireAuth, requireRole('ADMIN'), (req, res) => {
    const userId = Number(req.params.userId);
    const { jurisdictions } = req.body || {};
    if (!Array.isArray(jurisdictions) || jurisdictions.length === 0) {
      return res.status(400).json({ error: 'jurisdictions must be a non-empty array of district IDs.' });
    }
    const db = getDb();
    const adminId = (req as AuthenticatedRequest).auth!.user.id;
    const now = new Date().toISOString();
    const valid = jurisdictions
      .map((d: any) => String(d).toLowerCase().trim())
      .filter((d: string) => db.prepare('SELECT 1 FROM districts WHERE district_id = ?').get(d));
    if (valid.length === 0) return res.status(400).json({ error: 'No valid district IDs supplied.' });
    db.prepare('DELETE FROM official_jurisdictions WHERE official_user_id = ?').run(userId);
    for (const d of valid) {
      db.prepare('INSERT INTO official_jurisdictions (official_user_id, district_id, granted_by, granted_at) VALUES (?, ?, ?, ?)')
        .run(userId, d, adminId, now);
    }
    writeAuditLog({ actorUserId: adminId, actorRole: 'ADMIN', action: 'JURISDICTIONS_UPDATED', entityType: 'user', entityId: userId, details: { jurisdictions: valid } });
    res.json({ success: true, jurisdictions: valid });
  });

  // ---------- Admin: audit logs & overview ----------
  app.get('/api/admin/audit-logs', requireAuth, requireRole('ADMIN'), (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const db = getDb();
    const logs = db.prepare(
      `SELECT id, actor_user_id, actor_role, action, entity_type, entity_id, details, ip, created_at
       FROM audit_logs ORDER BY id DESC LIMIT ?`
    ).all(limit);
    res.json({ count: logs.length, audit_logs: logs });
  });

  app.get('/api/admin/overview', requireAuth, requireRole('ADMIN'), (_req, res) => {
    const db = getDb();
    const count = (sql: string) => Number((db.prepare(sql).get() as any).c);
    res.json({
      users_total: count('SELECT count(*) c FROM users WHERE deleted_at IS NULL'),
      citizens: count("SELECT count(*) c FROM users WHERE role = 'CITIZEN' AND deleted_at IS NULL"),
      officials: count("SELECT count(*) c FROM users WHERE role = 'OFFICIAL' AND deleted_at IS NULL"),
      admins: count("SELECT count(*) c FROM users WHERE role = 'ADMIN' AND deleted_at IS NULL"),
      pending_role_requests: count("SELECT count(*) c FROM role_requests WHERE status = 'PENDING'"),
      active_sessions: count('SELECT count(*) c FROM sessions WHERE revoked_at IS NULL'),
      audit_events: count('SELECT count(*) c FROM audit_logs'),
    });
  });

  // ---------- Official workspace (approved officials + admins) ----------
  app.get('/api/official/me', requireAuth, requireApprovedOfficial, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    res.json({
      user: authReq.auth!.user,
      jurisdictions: authReq.auth!.user.role === 'ADMIN' ? null : authReq.auth!.jurisdictions,
      official_profile: getOfficialProfile(authReq.auth!.user.id),
    });
  });

  app.get('/api/official/reports', requireAuth, requireApprovedOfficial, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const db = getDb();
    const requested = typeof req.query.district === 'string' ? req.query.district.toLowerCase().trim() : null;
    const isAdmin = authReq.auth!.user.role === 'ADMIN';
    const jurisdictions = authReq.auth!.jurisdictions;

    if (requested && !isAdmin && !jurisdictions.includes(requested)) {
      return res.status(403).json({ error: 'You can only view reports within your assigned jurisdictions.' });
    }
    const status = typeof req.query.status === 'string' ? req.query.status : null;

    let rows: any[];
    if (isAdmin) {
      rows = requested
        ? db.prepare('SELECT * FROM citizen_reports WHERE district_id = ? ORDER BY created_at DESC LIMIT 200').all(requested)
        : db.prepare('SELECT * FROM citizen_reports ORDER BY created_at DESC LIMIT 200').all();
    } else if (jurisdictions.length === 0) {
      rows = [];
    } else {
      const placeholders = jurisdictions.map(() => '?').join(',');
      rows = db.prepare(`SELECT * FROM citizen_reports WHERE district_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 200`).all(...jurisdictions);
    }
    if (status) rows = rows.filter(r => r.status === status);
    res.json({ count: rows.length, reports: rows });
  });

  // Convenience alias for citizens: their own reports (uses reporter_user_id when present)
  app.get('/api/citizen/reports', requireAuth, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const db = getDb();
    const rows = db.prepare('SELECT * FROM citizen_reports WHERE reporter_user_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(authReq.auth!.user.id);
    res.json({ count: rows.length, reports: rows });
  });
}
