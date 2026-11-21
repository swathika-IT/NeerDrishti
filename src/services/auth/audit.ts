import { getDb } from '../../db/sqlite';
import { isoNow } from './tokens';

export interface AuditEvent {
  actorUserId?: number | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  details?: Record<string, any>;
  ip?: string | null;
}

export function writeAuditLog(event: AuditEvent): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, details, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.actorUserId ?? null,
      event.actorRole ?? null,
      event.action,
      event.entityType,
      event.entityId != null ? String(event.entityId) : null,
      event.details ? JSON.stringify(event.details) : null,
      event.ip ?? null,
      isoNow()
    );
  } catch (err) {
    console.error('[audit] Failed to write audit log (non-blocking):', err);
  }
}
