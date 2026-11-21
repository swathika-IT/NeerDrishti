/**
 * READ-ONLY audit: finds suspected duplicate notification_history rows (same district/channel/level/message
 * created within 10 seconds). Does NOT modify or delete anything. Review the output before deciding on cleanup.
 *   npm run db:audit-notifications
 */
import 'dotenv/config';
import { getDb } from '../src/db/sqlite';

const db = getDb();
const rows = db.prepare(`SELECT id, district_id, channel, alert_level, message, status, timestamp FROM notification_history ORDER BY district_id, channel, alert_level, message, timestamp`).all() as any[];
const groups: any[][] = [];
let cur: any[] = [];
for (const r of rows) {
  const prev = cur[cur.length - 1];
  const same = prev && prev.district_id === r.district_id && prev.channel === r.channel && prev.alert_level === r.alert_level && prev.message === r.message
    && Math.abs(Date.parse(r.timestamp) - Date.parse(prev.timestamp)) <= 10_000;
  if (same) cur.push(r); else { if (cur.length > 1) groups.push(cur); cur = [r]; }
}
if (cur.length > 1) groups.push(cur);
console.log(JSON.stringify({
  type: 'notification_duplicate_audit', total_rows: rows.length, suspected_duplicate_groups: groups.length,
  suspected_duplicate_rows: groups.reduce((a, g) => a + g.length - 1, 0),
  groups: groups.slice(0, 50).map(g => ({ district_id: g[0].district_id, channel: g[0].channel, level: g[0].alert_level, count: g.length, ids: g.map(x => x.id), timestamps: g.map(x => x.timestamp) })),
  note: 'Read-only. No rows were changed.',
}, null, 2));
