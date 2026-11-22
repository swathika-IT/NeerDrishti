import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { toAuthUser } from '../services/auth/user_mapper';

let client: MongoClient | null = null;
let dbInstance: Db | null = null;
let clientUri: string | null = null;

export function getDatabaseUri(): string {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is required. Set it for the NeerDrishti MongoDB staging database.');
  }
  return uri;
}

export function getDb(): Db {
  const uri = getDatabaseUri();
  if (!dbInstance || clientUri !== uri) {
    if (client) {
      void client.close().catch(() => {});
    }
    client = new MongoClient(uri, {
      retryWrites: true,
      w: 'majority',
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    });
    clientUri = uri;
    dbInstance = client.db();
  }
  return dbInstance;
}

export async function initializeMongo(): Promise<void> {
  await getDb().command({ ping: 1 });
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
  }
  client = null;
  clientUri = null;
  dbInstance = null;
}

function C(name: string): Collection<any> {
  return getDb().collection(name);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function esc(s: string): string {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function re(s: string): RegExp {
  return new RegExp(`^${esc(s)}$`, 'i');
}

export function createToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function nextIdFor(name: string): Promise<number> {
  // The upsert path can race when the sequence document does not exist yet: both
  // callers attempt to insert the same _id and one receives E11000. Retry the
  // now-existing document so concurrent allocations cannot fail.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const doc = await C('sequences').findOneAndUpdate(
        { name },
        { $inc: { value: 1 } },
        { upsert: true, returnDocument: 'after' as any }
      );
      return Number(doc?.value ?? 0);
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      if (attempt === 4) throw err;
    }
  }
  throw new Error(`Unable to allocate sequence value for ${name}`);
}

async function seedIfEmpty(col: Collection<any>, seed: any[]): Promise<void> {
  const existing = await col.countDocuments({}, { limit: 1 });
  if (existing > 0) return;
  if (seed.length > 0) await col.insertMany(seed);
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Reference-data seeding is opt-in in production and always disabled in the
 * explicit staging/import mode. This prevents the application from creating
 * districts/stations before the SQLite importer has a chance to run, which
 * would otherwise make the importer refuse a non-empty target.
 */
function shouldSeedReferenceData(): boolean {
  if (envFlag('NEERDRISHTI_STAGING_IMPORT_MODE', false)) return false;
  const defaultSeed = (process.env.NODE_ENV || 'development') !== 'production';
  return envFlag('NEERDRISHTI_SEED_REFERENCE_DATA', defaultSeed);
}

export async function initDatabase(): Promise<void> {
  await initializeMongo();
  const db = getDb();

  const schemaMigrationCount = await db.collection('schema_migrations').countDocuments();
  if (schemaMigrationCount > 0) {
    console.log(`[mongo] schema_migrations bookkeeping: ${schemaMigrationCount} applied SQL migration record(s) preserved.`);
  }

  const idx = async (col: string, spec: any, opts: any = {}) => {
    await db.collection(col).createIndex(spec, opts);
  };

  if (shouldSeedReferenceData()) {
    const districtsFile = path.join(process.cwd(), 'data', 'telangana_districts.json');
    let districts: any[] = [];
    if (fs.existsSync(districtsFile)) {
      try {
        districts = JSON.parse(fs.readFileSync(districtsFile, 'utf-8'));
      } catch {
        districts = [];
      }
    }
    await seedIfEmpty(
      db.collection('districts'),
      districts.filter((d: any) => d.district_name).map((d: any) => ({
        _id: d.district_id || `TG-${String(d.district_name).toUpperCase().slice(0, 3)}`,
        district_id: d.district_id || `TG-${String(d.district_name).toUpperCase().slice(0, 3)}`,
        district_name: d.district_name,
        monitoring_category: d.monitoring_category || 'Standard Monitoring',
        region_zone: d.region_zone || 'Central Telangana',
        data_source_mode: d.data_source_mode || 'Simulated Data',
        data_confidence: d.data_confidence || 'Medium',
      }))
    );

    const stationsFile = path.join(process.cwd(), 'data', 'hydrological_stations.json');
    let hydro: any[] = [];
    if (fs.existsSync(stationsFile)) {
      try {
        hydro = JSON.parse(fs.readFileSync(stationsFile, 'utf-8'));
      } catch {
        hydro = [];
      }
    }
    await seedIfEmpty(
      db.collection('hydrological_stations'),
      hydro.map((s: any) => ({
        _id: s.station_id,
        station_id: s.station_id,
        station_name: s.station_name,
        water_body_name: s.water_body_name,
        water_body_type: s.water_body_type,
        district_id: s.district_id,
        basin: s.basin || null,
        latitude: s.latitude || null,
        longitude: s.longitude || null,
        warning_threshold: s.warning_threshold || null,
        danger_threshold: s.danger_threshold || null,
        unit: s.unit || 'm',
        active: s.active ? 1 : 0,
        metadata: s.metadata ?? null,
      }))
    );
  } else {
    console.log('[mongo] reference-data seeding skipped (staging import mode or production opt-out).');
  }

  await Promise.all([
    idx('users', { role: 1 }),
    idx('users', { status: 1 }),
    idx('users', { email: 1 }, { unique: true, collation: { locale: 'en', caseLevel: true } }),
    idx('sessions', { user_id: 1, expires_at: 1 }),
    idx('sessions', { id: 1 }, { unique: true }),
    idx('password_resets', { token_hash: 1 }, { unique: true }),
    idx('email_verifications', { token_hash: 1 }, { unique: true }),
    idx('role_requests', { status: 1 }),
    idx('official_jurisdictions', { official_user_id: 1, district_id: 1 }, { unique: true }),
    idx('official_jurisdictions', { district_id: 1 }),
    idx('user_districts', { user_id: 1, district_id: 1 }, { unique: true }),
    idx('alert_subscriptions', { user_id: 1, district_id: 1 }, { unique: true }),
    idx('alert_subscriptions', { district_id: 1 }),
    idx('notification_preferences', { user_id: 1 }, { unique: true }),
    idx('audit_logs', { created_at: 1 }),
    idx('audit_logs', { actor_user_id: 1 }),
    idx('audit_logs', { entity_type: 1, entity_id: 1 }),
    idx('report_moderation_history', { report_id: 1, id: 1 }),
    idx('report_attachments', { report_id: 1 }),
    idx('districts', { district_name: 1 }, { unique: true, collation: { locale: 'en', caseLevel: true } }),
    idx('citizen_reports', { district_id: 1, status: 1, reported_at: 1 }),
    idx('citizen_reports', { reported_at: 1 }),
    idx('external_signals', { district_id: 1 }),
    idx('external_signals', { signal_type: 1 }),
    idx('external_signals', { recorded_at: 1 }),
    idx('external_signals', { district_id: 1, recorded_at: 1 }),
    idx('external_signals', { data_mode: 1 }),
    idx('hydrological_stations', { district_id: 1 }),
    idx('hydrological_stations', { water_body_type: 1 }),
    idx('forecast_snapshots', { district_id: 1 }),
    idx('forecast_snapshots', { forecast_horizon_hours: 1 }),
    idx('forecast_snapshots', { forecast_generated_at: 1 }),
    idx('alerts_history', { district_id: 1 }),
    idx('alerts_history', { alert_level: 1 }),
    idx('alerts_history', { status: 1 }),
    idx('alerts_history', { created_at: 1 }),
    idx('notification_history', { id: 1 }, { unique: true, sparse: true }),
    idx('notification_history', { user_id: 1 }),
    idx('notification_history', { timestamp: -1 }),
    idx('notification_history', { district_id: 1, timestamp: -1 }),
    idx('notification_history', { delivery_status: 1, timestamp: -1 }),
    idx('dataset_registry', { data_type: 1 }),
    idx('ingestion_runs', { dataset_id: 1, started_at: -1 }),
    idx('ingestion_runs', { status: 1 }),
    idx('weather_current', { district_id: 1, observed_at: -1, source_id: 1 }, { unique: true }),
    idx('weather_forecast_hourly', { district_id: 1, valid_at: 1, source_id: 1 }, { unique: true }),
    idx('weather_forecast_hourly', { valid_at: 1 }),
    idx('weather_historical_daily', { district_id: 1, obs_date: 1, source_id: 1 }, { unique: true }),
    idx('weather_historical_daily', { obs_date: 1 }),
    idx('rainfall_station_observations', { station_name: 1, observed_at: -1, source_id: 1 }, { unique: true }),
    idx('rainfall_station_observations', { district_id: 1, observed_at: -1 }),
    idx('groundwater_observations', { station_name: 1, observed_at: -1, source_id: 1 }, { unique: true }),
    idx('groundwater_observations', { district_id: 1, observed_at: -1 }),
    idx('river_level_observations', { station_name: 1, river: 1, observed_at: -1, source_id: 1 }, { unique: true }),
    idx('river_level_observations', { station_name: 1, observed_at: -1 }),
    idx('river_level_observations', { district_id: 1, observed_at: -1 }),
    idx('reservoir_observations', { reservoir_name: 1, observed_at: -1, source_id: 1 }, { unique: true }),
    idx('district_hydrology_features', { as_of: 1 }),
    idx('district_data_completeness', { dataset_id: 1 }),
    idx('notification_simulation_keys', { idempotency_key: 1 }, { unique: true }),
    idx('sequences', { name: 1 }, { unique: true }),
    idx('schema_migrations', { name: 1 }, { unique: true }),
  ]);

  await C('alerts_history').createIndex({ idempotency_key: 1 }, {
    unique: true,
    partialFilterExpression: { idempotency_key: { $type: 'string' } },
  });
}

// ---------------- Users ----------------

export async function insertUser(doc: Record<string, any>): Promise<number> {
  const id = await nextIdFor('users');
  const r = await C('users').insertOne({ _id: id, created_at: isoNow(), updated_at: isoNow(), ...doc });
  return Number(r.insertedId);
}

export async function findUserById(id: number): Promise<any> {
  return await C('users').findOne({ _id: id, deleted_at: null });
}

export async function listUsers(limit: number = 100, offset: number = 0): Promise<any[]> {
  const rows = await C('users').find({ deleted_at: null }, { sort: { created_at: -1 }, limit, skip: offset }).toArray();
  return rows.map((r: any) => ({
    id: Number(r._id),
    email: r.email,
    full_name: r.full_name,
    role: r.role,
    status: r.status,
    email_verified: Boolean(r.email_verified_at),
    created_at: r.created_at,
    last_login_at: r.last_login_at ?? null,
  }));
}

export async function updateUserPassword(userId: number, newHash: string): Promise<void> {
  await C('users').updateOne({ _id: userId }, { $set: { password_hash: newHash, updated_at: new Date() } });
}

export async function setUserStatus(targetId: number, status: string): Promise<void> {
  await C('users').updateOne({ _id: targetId }, { $set: { status, updated_at: new Date() } });
}

export async function findUserByEmailNorm(email: string): Promise<any> {
  return await C('users').findOne({ email: email.trim().toLowerCase(), deleted_at: null });
}

export async function updateUserEmailVerified(userId: number): Promise<void> {
  await C('users').updateOne({ _id: userId }, { $set: { email_verified_at: new Date() } });
}

export async function updateUserLastLogin(userId: number): Promise<void> {
  await C('users').updateOne({ _id: userId }, { $set: { last_login_at: new Date() } });
}

export async function countAdmins(): Promise<number> {
  return await C('users').countDocuments({ role: 'ADMIN', deleted_at: null });
}

// ---------------- Sessions ----------------

export async function createSession(
  userId: number,
  ip: string | null,
  userAgent: string | null
): Promise<{ token: string; expiresAt: string }> {
  const { token, tokenHash } = createToken();
  const expiresAt = new Date(Date.now() + 12 * 7 * 24 * 3600 * 1000);
  const r = await C('sessions').insertOne({
    id: tokenHash,
    user_id: userId,
    created_at: new Date(),
    expires_at: expiresAt,
    ip: ip || null,
    user_agent: userAgent || null,
    revoked_at: null,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function getSessionUser(token: string): Promise<any> {
  if (!token) return null;
  const row = await C('sessions').findOne({ id: hashToken(token) });
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  const user = await C('users').findOne({ _id: row.user_id, deleted_at: null });
  return toAuthUser(user);
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await C('sessions').updateOne({ id: hashToken(token), revoked_at: null }, { $set: { revoked_at: new Date() } });
}

export async function revokeAllUserSessions(userId: number, exceptTokenHash?: string): Promise<void> {
  const filter = exceptTokenHash ? { user_id: userId, id: { $ne: exceptTokenHash }, revoked_at: null } : { user_id: userId, revoked_at: null };
  await C('sessions').updateMany(filter, { $set: { revoked_at: new Date() } });
}

export async function purgeExpiredSessions(): Promise<number> {
  const r = await C('sessions').deleteMany({ $or: [{ expires_at: { $lt: new Date() } }, { revoked_at: { $ne: null } }] });
  return Number(r.deletedCount);
}

// ---------------- Email verifications ----------------

export async function insertEmailVerification(userId: number, tokenHash: string, expiresAt: string, createdAt: string): Promise<void> {
  await C('email_verifications').deleteMany({ user_id: userId });
  await C('email_verifications').insertOne({
    _id: await nextIdFor('email_verifications'),
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_at: createdAt,
  });
}

export async function findEmailVerificationByTokenHash(tokenHash: string): Promise<any> {
  return await C('email_verifications').findOne({ token_hash: tokenHash });
}

export async function markEmailVerificationUsed(id: number): Promise<void> {
  await C('email_verifications').updateOne({ _id: id }, { $set: { used_at: new Date() } });
}

// ---------------- Password resets ----------------

export async function insertPasswordReset(userId: number, tokenHash: string, expiresAt: string, createdAt: string): Promise<void> {
  await C('password_resets').deleteMany({ user_id: userId });
  await C('password_resets').insertOne({
    _id: await nextIdFor('password_resets'),
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_at: createdAt,
  });
}

export async function findPasswordResetByTokenHash(tokenHash: string): Promise<any> {
  return await C('password_resets').findOne({ token_hash: tokenHash });
}

export async function markPasswordResetUsed(id: number): Promise<void> {
  await C('password_resets').updateOne({ _id: id }, { $set: { used_at: new Date() } });
}

// ---------------- Role requests ----------------

export async function createRoleRequest(userId: number, reason: string, department: string): Promise<{ success: boolean; error?: string }> {
  const pending = await C('role_requests').findOne({ user_id: userId, status: 'PENDING' });
  if (pending) return { success: false, error: 'You already have a pending official access request.' };
  await C('role_requests').insertOne({
    _id: await nextIdFor('role_requests'),
    user_id: userId,
    requested_role: 'OFFICIAL',
    reason: reason || null,
    department: department || null,
    status: 'PENDING',
    created_at: new Date(),
  });
  await writeAuditLog({ actorUserId: userId, action: 'ROLE_REQUEST_SUBMITTED', entityType: 'role_request', entityId: userId });
  return { success: true };
}

export async function getUserPendingRoleRequest(userId: number): Promise<any> {
  return await C('role_requests').findOne({ user_id: userId, status: 'PENDING' });
}

export async function listRoleRequests(status?: string): Promise<any[]> {
  const filter = status ? { status } : {};
  const rows = await C('role_requests').find(filter).sort({ created_at: -1, _id: -1 }).toArray();
  return rows.map((r: any) => ({ ...r, id: r.id ?? r._id }));
}

export async function approveRoleRequest(requestId: number, adminUserId: number, jurisdictions: string[]): Promise<{ success: boolean; error?: string }> {
  const req = await C('role_requests').findOne({ _id: requestId });
  if (!req) return { success: false, error: 'Role request not found.' };
  if (req.status !== 'PENDING') return { success: false, error: 'This request has already been reviewed.' };

  const validDistricts: string[] = [];
  for (const j of jurisdictions) {
    const d = String(j).toLowerCase().trim();
    if (await C('districts').findOne({ _id: d })) validDistricts.push(d);
  }
  if (validDistricts.length === 0) return { success: false, error: 'At least one valid Telangana district jurisdiction is required.' };

  const now = new Date();
  await C('role_requests').updateOne({ _id: requestId }, { $set: { status: 'APPROVED', reviewed_by: adminUserId, reviewed_at: now } });
  await C('users').updateOne({ _id: req.user_id }, { $set: { role: 'OFFICIAL', updated_at: now } });

  const existingProfile = await C('official_profiles').findOne({ user_id: req.user_id });
  if (existingProfile) {
    await C('official_profiles').updateOne({ user_id: req.user_id }, { $set: {
      department: req.department || 'State Department',
      approval_status: 'APPROVED',
      approved_by: adminUserId,
      approved_at: now,
      updated_at: now,
    } });
  } else {
    await C('official_profiles').insertOne({
      user_id: req.user_id,
      department: req.department || 'State Department',
      approval_status: 'APPROVED',
      approved_by: adminUserId,
      approved_at: now,
      created_at: now,
      updated_at: now,
    });
  }
  await C('official_jurisdictions').deleteMany({ official_user_id: req.user_id });
  for (const districtId of validDistricts) {
    await C('official_jurisdictions').insertOne({
      official_user_id: req.user_id,
      district_id: districtId,
      granted_by: adminUserId,
      granted_at: now,
    });
  }
  await writeAuditLog({ actorUserId: adminUserId, actorRole: 'ADMIN', action: 'ROLE_REQUEST_APPROVED', entityType: 'user', entityId: req.user_id, details: { requestId, jurisdictions: validDistricts } });
  return { success: true };
}

export async function rejectRoleRequest(requestId: number, adminUserId: number, note: string): Promise<{ success: boolean; error?: string }> {
  const req = await C('role_requests').findOne({ _id: requestId });
  if (!req) return { success: false, error: 'Role request not found.' };
  if (req.status !== 'PENDING') return { success: false, error: 'This request has already been reviewed.' };
  await C('role_requests').updateOne({ _id: requestId }, { $set: { status: 'REJECTED', reviewed_by: adminUserId, reviewed_at: new Date(), review_note: note || null } });
  await writeAuditLog({ actorUserId: adminUserId, actorRole: 'ADMIN', action: 'ROLE_REQUEST_REJECTED', entityType: 'user', entityId: req.user_id, details: { requestId, note } });
  return { success: true };
}

// ---------------- Official profiles & jurisdictions ----------------

export async function getOfficialProfile(userId: number): Promise<any> {
  return await C('official_profiles').findOne({ user_id: userId });
}

export async function isApprovedOfficial(userId: number): Promise<boolean> {
  const profile = await getOfficialProfile(userId);
  return Boolean(profile && profile.approval_status === 'APPROVED');
}

export async function getOfficialJurisdictions(userId: number): Promise<string[]> {
  const rows = await C('official_jurisdictions').find({ official_user_id: userId }).toArray();
  return rows.map((r: any) => r.district_id);
}

export async function insertOfficialJurisdictions(officialUserId: number, districtIds: string[], grantedBy: number, grantedAt: Date): Promise<void> {
  await C('official_jurisdictions').deleteMany({ official_user_id: officialUserId });
  await C('official_jurisdictions').insertMany(districtIds.map(d => ({
    official_user_id: officialUserId,
    district_id: d,
    granted_by: grantedBy,
    granted_at: grantedAt,
  })));
}

// ---------------- User districts ----------------

export async function insertUserDistrict(userId: number, districtId: string): Promise<void> {
  await C('user_districts').insertOne({ user_id: userId, district_id: districtId, created_at: new Date() });
}

export async function getUserDistricts(userId: number): Promise<any[]> {
  return await C('user_districts').find({ user_id: userId }).toArray();
}

// ---------------- Alert subscriptions ----------------

export async function insertAlertSubscription(userId: number, districtId: string): Promise<void> {
  await C('alert_subscriptions').insertOne({
    _id: await nextIdFor('alert_subscriptions'),
    user_id: userId,
    district_id: districtId,
    min_severity: 'WATCH',
    created_at: new Date(),
  });
}

export async function getAlertSubscribers(districtId: string): Promise<any[]> {
  const subs = await C('alert_subscriptions').find({ district_id: districtId }).sort({ _id: 1 }).toArray();
  if (subs.length === 0) return [];
  const userIds = subs.map((s: any) => s.user_id);
  const users = new Map((await C('users').find({ _id: { $in: userIds } }).toArray()).map((u: any) => [u._id, u]));
  const prefs = new Map((await C('notification_preferences').find({ user_id: { $in: userIds } }).toArray()).map((p: any) => [p.user_id, p]));
  return subs
    .filter((s: any) => users.has(s.user_id))
    .map((s: any) => {
      const u = users.get(s.user_id)!;
      const p = prefs.get(s.user_id);
      return {
        user_id: s.user_id,
        min_severity: s.min_severity,
        subscription_id: s._id,
        email: u.email,
        full_name: u.full_name,
        phone: u.phone,
        phone_verified: u.phone_verified,
        status: u.status,
        email_enabled: p?.email_enabled,
        sms_enabled: p?.sms_enabled,
        whatsapp_enabled: p?.whatsapp_enabled,
        consent_given_at: p?.consent_given_at ?? null,
        unsubscribed_all_at: p?.unsubscribed_all_at ?? null,
      };
    });
}

// ---------------- Notification preferences ----------------

export async function getNotificationPreferences(userId: number): Promise<any> {
  return await C('notification_preferences').findOne({ user_id: userId });
}

export async function upsertNotificationPreferences(userId: number, prefs: Record<string, any>): Promise<any> {
  await C('notification_preferences').updateOne(
    { user_id: userId },
    { $set: { ...prefs, updated_at: new Date() } },
    { upsert: true }
  );
  return await getNotificationPreferences(userId);
}

// ---------------- Audit logs ----------------

export async function writeAuditLog(event: {
  actorUserId?: number | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  details?: Record<string, any> | null;
  ip?: string | null;
}): Promise<void> {
  try {
    await C('audit_logs').insertOne({
      _id: await nextIdFor('audit_logs'),
      actor_user_id: event.actorUserId ?? null,
      actor_role: event.actorRole ?? null,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId != null ? String(event.entityId) : null,
      details: event.details ? JSON.stringify(event.details) : null,
      ip: event.ip ?? null,
      created_at: new Date(),
    });
  } catch (err: any) {
    // Audit storage must never break authentication or authorization flows.
    // Log only the action name and a safe message (never event details/tokens).
    console.error(JSON.stringify({
      type: 'audit_log_write_failed',
      action: event.action,
      error: String(err?.message || 'unknown audit write error'),
    }));
  }
}

// ---------------- Districts ----------------

export async function hasDistrict(districtId: string): Promise<boolean> {
  return !!(await C('districts').findOne({ _id: districtId }));
}

export async function getAllDistrictIds(): Promise<string[]> {
  const rows = await C('districts').find({ _id: { $exists: true } }, { projection: { _id: 1 } }).toArray();
  return rows.map((r: any) => r._id);
}

// ---------------- Citizen reports ----------------

/**
 * Returns the flat report shape the frontend expects (SQLite LEFT JOIN parity):
 * `id` (not `_id`) plus classification columns either from the historical
 * `report_classification` collection or from a legacy nested `classification`.
 */
export function normalizeReportDoc(report: any, classification?: any): any {
  if (!report) return null;
  const { _id, classification: nested, ...rest } = report;
  const c = classification || nested || null;
  return {
    id: Number(_id ?? report.id),
    ...rest,
    impact: c?.impact ?? null,
    priority: c?.priority ?? null,
    summary: c?.summary ?? null,
    recommended_action: c?.recommended_action ?? null,
    model_provider: c?.model_provider ?? null,
    model_name: c?.model_name ?? null,
    processing_timestamp: c?.processing_timestamp ?? null,
  };
}

async function classificationsForReportIds(ids: number[]): Promise<Map<number, any>> {
  const map = new Map<number, any>();
  if (ids.length === 0) return map;
  const rows = await C('report_classification').find({ report_id: { $in: ids } }).toArray();
  for (const row of rows) map.set(Number(row.report_id), row);
  return map;
}

export async function insertReportWithClassification(data: {
  district_id: string;
  location_description?: string | null;
  incident_type: string;
  severity: string;
  description: string;
  image_reference?: string | null;
  reported_at?: string;
  created_at?: string;
  classification_source: string;
  classification_confidence?: number;
  status?: string;
  reporter_user_id?: number | null;
  classification: Record<string, any>;
}): Promise<any> {
  await initializeMongo();
  const nowStr = new Date().toISOString();
  const id = await nextIdFor('citizen_reports');
  const locDesc = (data.location_description || '').slice(0, 200);
  const desc = data.description.slice(0, 1000);
  const report: any = {
    _id: id,
    district_id: data.district_id,
    location_description: locDesc,
    incident_type: data.incident_type,
    severity: data.severity,
    description: desc,
    image_reference: data.image_reference || null,
    reported_at: data.reported_at || nowStr,
    created_at: data.created_at || nowStr,
    classification_source: data.classification_source,
    classification_confidence: data.classification_confidence ?? 1.0,
    ai_processed: 1,
    status: data.status || 'PENDING',
  };
  if (data.reporter_user_id) report.reporter_user_id = data.reporter_user_id;
  await C('citizen_reports').insertOne(report);

  let classificationDoc: any = null;
  if (data.classification) {
    const classificationId = await nextIdFor('report_classification');
    classificationDoc = {
      _id: classificationId,
      id: classificationId,
      report_id: id,
      incident_type: data.classification.incident_type || data.incident_type,
      severity: data.classification.severity || data.severity,
      impact: data.classification.impact || 'Localized hazard area',
      priority: data.classification.priority || 'Review',
      summary: data.classification.summary || desc.slice(0, 150),
      recommended_action: data.classification.recommended_action || 'Avoid waterlogged areas.',
      model_provider: data.classification.model_provider || (data.classification_source === 'Meta Llama' ? 'Meta Llama' : 'Rule Engine'),
      model_name: data.classification.model_name || (data.classification_source === 'Meta Llama' ? 'llama3.2:3b' : 'Rule-Based Fallback'),
      processing_timestamp: nowStr,
    };
    try {
      // No transaction: works on standalone MongoDB as well as Atlas replica sets.
      await C('report_classification').insertOne(classificationDoc);
    } catch (err) {
      // Best-effort cleanup so a failed classification does not leave an orphan report.
      try { await C('citizen_reports').deleteOne({ _id: id }); } catch { /* ignore cleanup failure */ }
      throw err;
    }
  }

  return normalizeReportDoc(report, classificationDoc);
}

export async function getReports(options: {
  district?: string;
  districts?: string[];
  reporterUserId?: number;
  severity?: string;
  status?: string;
  page?: number;
  limit?: number;
}): Promise<{ reports: any[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions: any[] = [];
  if (options.district && options.district !== 'All') conditions.push({ $or: [{ district_id: re(options.district) }, { district: re(options.district) }] });
  if (options.districts && options.districts.length > 0) conditions.push({ district_id: { $in: options.districts } });
  if (options.reporterUserId !== undefined && options.reporterUserId !== null) conditions.push({ reporter_user_id: options.reporterUserId });
  if (options.severity && options.severity !== 'All') conditions.push({ severity: re(options.severity) });
  if (options.status && options.status !== 'All') conditions.push({ status: re(options.status) });
  const filter = conditions.length ? { $and: conditions } : {};
  const [total, rows] = await Promise.all([
    C('citizen_reports').countDocuments(filter),
    C('citizen_reports').find(filter).sort({ _id: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  const classifications = await classificationsForReportIds(rows.map((r: any) => Number(r._id)));
  const reports = rows.map((r: any) => normalizeReportDoc(r, classifications.get(Number(r._id))));
  return { reports, total, page, limit };
}

export async function getReportById(id: number): Promise<any> {
  const report = await C('citizen_reports').findOne({ _id: id });
  if (!report) return null;
  const classification = await C('report_classification').findOne({ report_id: id });
  return normalizeReportDoc(report, classification);
}

export async function updateReportStatus(id: number, status: string): Promise<any> {
  const statusAliases: Record<string, string> = {
    New: 'PENDING', Reviewed: 'UNDER_REVIEW', Validated: 'VERIFIED', Resolved: 'RESOLVED', Rejected: 'REJECTED',
  };
  const valid = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'RESOLVED', 'REJECTED'];
  const normalized = statusAliases[status] || status;
  if (!valid.includes(normalized)) throw new Error(`Invalid status '${status}'. Must be one of: ${valid.join(', ')}`);
  await C('citizen_reports').updateOne({ _id: id }, { $set: { status: normalized, updated_at: new Date() } });
  return await getReportById(id);
}

export async function getDistrictAggregation(districtName: string): Promise<any> {
  const rows = await C('citizen_reports').find(
    { district_id: re(districtName), status: { $ne: 'REJECTED' } }
  ).sort({ _id: -1 }).toArray();
  const total = rows.length;
  if (total === 0) {
    return {
      district: districtName,
      total_reports: 0,
      reports_24h: 0,
      high_severity_reports: 0,
      critical_reports: 0,
      citizen_report_score: 0.0,
      citizen_points_contribution: 0.0,
      recent_trend: 'Stable',
      explainability: `No active citizen flood reports registered for ${districtName}.`,
      verified_reports: 0,
      unverified_reports: 0,
      scoring_basis: 'VERIFIED_ONLY',
    };
  }
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600000);
  const verifiedStatuses = new Set(['verified', 'validated']);
  const scoringRows = rows.filter(r => verifiedStatuses.has(String(r.status || '').toLowerCase()));
  let reports24h = 0;
  for (const r of rows) {
    const createdDate = new Date(r.created_at || r.reported_at || now.toISOString());
    if (createdDate >= twentyFourHoursAgo) reports24h++;
  }
  let highCount = 0, criticalCount = 0, rawScore = 0.0;
  for (const r of scoringRows) {
    const sev = (r.classification?.severity || r.severity || 'Moderate').toLowerCase();
    const createdDate = new Date(r.created_at || r.reported_at || now.toISOString());
    const isRecent = createdDate >= twentyFourHoursAgo;
    const recencyWeight = isRecent ? 1.0 : 0.40;
    let sevPts = 3.0;
    if (sev === 'critical') { criticalCount++; highCount++; sevPts = 30.0; }
    else if (sev === 'high') { highCount++; sevPts = 18.0; }
    else if (sev === 'moderate') { sevPts = 8.0; }
    rawScore += sevPts * recencyWeight;
  }
  if (highCount >= 2) rawScore += Math.min(20.0, highCount * 5.0);
  const citizenReportScore = Math.min(100.0, Math.round(rawScore * 100) / 100);
  const citizenPointsContribution = Math.round(citizenReportScore * 0.15 * 100) / 100;
  const unverifiedReports = total - scoringRows.length;
  let trend: 'Increasing' | 'Stable' | 'Decreasing' = 'Stable';
  if (reports24h >= 3) trend = 'Increasing';
  else if (reports24h >= 1) trend = 'Stable';
  else trend = 'Decreasing';
  const explainability = scoringRows.length === 0
    ? `${total} report(s) registered (${reports24h} in last 24h), none verified yet — no contribution to the risk index. Verification requires review by an approved official.`
    : (highCount > 0 || criticalCount > 0)
      ? `${scoringRows.length} verified report(s) scored (${reports24h} total in last 24h, ${unverifiedReports} unverified excluded), including ${highCount} High/Critical incidents. Ground field telemetry contributes ${citizenPointsContribution} pts to the composite flood risk index.`
      : `${scoringRows.length} verified report(s) scored (${unverifiedReports} unverified excluded). Ground telemetry contributes ${citizenPointsContribution} pts.`;
  return {
    district: districtName,
    total_reports: total,
    reports_24h: reports24h,
    high_severity_reports: highCount,
    critical_reports: criticalCount,
    citizen_report_score: citizenReportScore,
    citizen_points_contribution: citizenPointsContribution,
    recent_trend: trend,
    explainability,
    verified_reports: scoringRows.length,
    unverified_reports: unverifiedReports,
    scoring_basis: 'VERIFIED_ONLY',
  };
}

export async function getAllDistrictAggregations(districtNames: string[]): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const name of districtNames)     result[name] = await getDistrictAggregation(name);
  return result;
}

export async function recordModerationTransition(input: {
  report_id: number;
  from_status: string;
  to_status: string;
  actor_user_id: number | null;
  actor_role: string;
  reason?: string | null;
}): Promise<void> {
  const id = await nextIdFor('report_moderation_history');
  await C('report_moderation_history').insertOne({
    _id: id,
    id,
    report_id: input.report_id,
    from_status: input.from_status,
    to_status: input.to_status,
    actor_user_id: input.actor_user_id,
    actor_role: input.actor_role,
    reason: input.reason || null,
    created_at: new Date(),
  });
}

export async function getModerationHistory(reportId: number): Promise<any[]> {
  // Both historical imports and new writes persist the numeric `id`; sort on it
  // (indexed with report_id) rather than relying on insertion order.
  const rows = await C('report_moderation_history').find({ report_id: reportId }).sort({ id: 1, _id: 1 }).toArray();
  return Promise.all(rows.map(async (r: any) => {
    const user = r.actor_user_id ? await C('users').findOne({ _id: r.actor_user_id }) : null;
    return { ...r, actor_email: user?.email ?? null, actor_name: user?.full_name ?? null };
  }));
}

export interface ReportAttachmentInput {
  report_id: number;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
}

export async function insertReportAttachment(att: ReportAttachmentInput): Promise<void> {
  await C('report_attachments').insertOne({
    _id: await nextIdFor('report_attachments'),
    report_id: att.report_id,
    storage_path: att.storage_path,
    mime_type: att.mime_type,
    size_bytes: att.size_bytes,
    sha256: att.sha256,
    created_at: new Date(),
  });
}

export async function getReportAttachments(reportId: number): Promise<any[]> {
  return await C('report_attachments').find({ report_id: reportId }).sort({ _id: 1 }).toArray();
}

// ---------------- External signals ----------------

export interface InsertSignalInput {
  district_id: string;
  source_name: string;
  source_type: string;
  signal_type: string;
  value: number;
  unit: string;
  data_mode?: 'LIVE' | 'HISTORICAL' | 'SIMULATED' | 'FORECAST' | 'UNAVAILABLE';
  freshness?: 'FRESH' | 'AGING' | 'STALE' | 'EXPIRED';
  confidence?: number;
  is_valid?: number;
  recorded_at: string;
  ingested_at?: string;
  metadata?: any;
}

export async function insertExternalSignal(input: InsertSignalInput): Promise<number> {
  const r = await C('external_signals').insertOne({
    _id: await nextIdFor('external_signals'),
    district_id: input.district_id,
    source_name: input.source_name,
    source_type: input.source_type,
    signal_type: input.signal_type,
    value: input.value,
    unit: input.unit,
    data_mode: input.data_mode || 'LIVE',
    freshness: input.freshness || 'FRESH',
    confidence: input.confidence !== undefined ? input.confidence : 1.0,
    is_valid: input.is_valid !== undefined ? input.is_valid : 1,
    recorded_at: input.recorded_at,
    ingested_at: input.ingested_at || isoNow(),
    metadata: input.metadata ?? null,
  });
  return Number(r.insertedId);
}

export async function detectDuplicateSignal(districtId: string, sourceName: string, signalType: string, recordedAt: string): Promise<boolean> {
  return !!(await C('external_signals').findOne({ district_id: districtId, source_name: sourceName, signal_type: signalType, recorded_at: recordedAt }));
}

export interface HistoricalSignalRow {
  district_id: string;
  source_name: string;
  source_type: string;
  signal_type: string;
  value: number;
  unit: string;
  data_mode: string;
  freshness: string;
  confidence: number;
  is_valid: number;
  recorded_at: string;
  metadata?: Record<string, any> | string | null;
}

export async function insertHistoricalSignalsBatch(rows: HistoricalSignalRow[], ingestedAt?: string): Promise<number> {
  if (rows.length === 0) return 0;
  const ts = ingestedAt || isoNow();
  await C('external_signals').insertMany(
    rows.map((row: any) => ({
      district_id: row.district_id,
      source_name: row.source_name,
      source_type: row.source_type,
      signal_type: row.signal_type,
      value: row.value,
      unit: row.unit,
      data_mode: row.data_mode,
      freshness: row.freshness,
      confidence: row.confidence,
      is_valid: row.is_valid,
      recorded_at: row.recorded_at,
      ingested_at: ts,
      metadata: row.metadata ?? null,
    })),
    { ordered: false }
  );
  return rows.length;
}

export async function getExistingSignalDateKeys(sourceName: string, signalType: string = 'rainfall'): Promise<Set<string>> {
  const rows = await C('external_signals').find({ source_name: sourceName, signal_type: signalType }).project({ district_id: 1, recorded_at: 1 }).toArray();
  const keys = new Set<string>();
  for (const r of rows) keys.add(`${r.district_id}|${String(r.recorded_at).slice(0, 10)}`);
  return keys;
}

export async function getLatestRainfallSignal(districtId: string): Promise<any> {
  return await C('external_signals').findOne({ district_id: districtId, signal_type: 'rainfall', is_valid: 1 }, { sort: { recorded_at: -1 } });
}

export async function getRecentLiveSignalForDistrict(districtId: string, sourceName: string): Promise<any> {
  return await C('external_signals').findOne(
    { district_id: districtId, source_name: sourceName, signal_type: 'rainfall', data_mode: 'LIVE', is_valid: 1 },
    { sort: { recorded_at: -1 } }
  );
}

export async function getDistrictSignals(districtId: string, limit: number = 20): Promise<any[]> {
  return await C('external_signals').find({ district_id: districtId }, { sort: { recorded_at: -1 }, limit }).toArray();
}

const HYDRO_TYPES = ['river_level', 'river_flow', 'reservoir_level', 'reservoir_storage', 'reservoir_release', 'dam_discharge', 'hydrological_alert'];

export async function getLatestHydrologicalSignals(districtId?: string, signalType?: string): Promise<any[]> {
  const base: any = { is_valid: 1 };
  if (districtId && signalType) Object.assign(base, { district_id: districtId, signal_type: signalType });
  else if (districtId) Object.assign(base, { district_id: districtId, signal_type: { $in: HYDRO_TYPES } });
  else if (signalType) Object.assign(base, { signal_type: signalType });
  else Object.assign(base, { signal_type: { $in: HYDRO_TYPES } });
  return await C('external_signals').find(base, { sort: { recorded_at: -1 } }).toArray();
}

export async function getStationSignalHistory(
  districtId: string,
  signalType: string,
  stationId?: string,
  limit: number = 10
): Promise<any[]> {
  const or = stationId
    ? [{ 'metadata.station_id': stationId }, { source_name: new RegExp(esc(stationId)) }]
    : [];
  const query: any = { district_id: districtId, signal_type: signalType, is_valid: 1 };
  if (stationId) query.$or = or;
  return await C('external_signals').find(query, { sort: { recorded_at: -1 }, limit }).toArray();
}

// ---------------- Hydrological stations ----------------

export async function getAllHydrologicalStations(districtId?: string): Promise<any[]> {
  const col = C('hydrological_stations');
  if (districtId) return await col.find({ district_id: districtId }, { sort: { station_name: 1 } }).toArray();
  return await col.find({}, { sort: { district_id: 1, station_name: 1 } }).toArray();
}

export async function getHydrologicalStationById(stationId: string): Promise<any> {
  return await C('hydrological_stations').findOne({ station_id: stationId });
}

export async function insertHydrologicalStation(stn: {
  station_id: string;
  station_name: string;
  water_body_name: string;
  water_body_type: string;
  district_id: string;
  basin?: string;
  latitude?: number;
  longitude?: number;
  warning_threshold?: number;
  danger_threshold?: number;
  unit: string;
  active?: number;
  metadata?: any;
}): Promise<void> {
  await C('hydrological_stations').updateOne(
    { station_id: stn.station_id },
    { $set: {
      station_id: stn.station_id,
      station_name: stn.station_name,
      water_body_name: stn.water_body_name,
      water_body_type: stn.water_body_type,
      district_id: stn.district_id,
      basin: stn.basin || null,
      latitude: stn.latitude || null,
      longitude: stn.longitude || null,
      warning_threshold: stn.warning_threshold || null,
      danger_threshold: stn.danger_threshold || null,
      unit: stn.unit,
      active: stn.active !== undefined ? stn.active : 1,
      metadata: stn.metadata ? (typeof stn.metadata === 'string' ? JSON.parse(stn.metadata) : stn.metadata) : null,
    } },
    { upsert: true }
  );
}

// ---------------- Forecast snapshots ----------------

export async function insertForecastSnapshot(data: {
  district_id: string;
  forecast_generated_at: string;
  forecast_horizon_hours: number;
  projected_risk_score: number;
  current_risk_score: number;
  projected_risk_change: number;
  risk_trend: string;
  outlook_category: string;
  confidence: string;
  confidence_score: number;
  data_mode: string;
  primary_drivers?: any[];
  supporting_signals?: any[];
  forecast_sources?: string[];
  limitations?: string[];
  metadata?: Record<string, any>;
}): Promise<number> {
  const r = await C('forecast_snapshots').insertOne({
    _id: await nextIdFor('forecast_snapshots'),
    district_id: data.district_id,
    forecast_generated_at: data.forecast_generated_at,
    forecast_horizon_hours: data.forecast_horizon_hours,
    projected_risk_score: data.projected_risk_score,
    current_risk_score: data.current_risk_score,
    projected_risk_change: data.projected_risk_change,
    risk_trend: data.risk_trend,
    outlook_category: data.outlook_category,
    confidence: data.confidence,
    confidence_score: data.confidence_score,
    data_mode: data.data_mode,
    primary_drivers: data.primary_drivers ? JSON.stringify(data.primary_drivers) : null,
    supporting_signals: data.supporting_signals ? JSON.stringify(data.supporting_signals) : null,
    forecast_sources: data.forecast_sources ? JSON.stringify(data.forecast_sources) : null,
    limitations: data.limitations ? JSON.stringify(data.limitations) : null,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
    created_at: new Date(),
  });
  return Number(r.insertedId);
}

export async function getLatestDistrictForecastSnapshots(districtId: string): Promise<any[]> {
  return await C('forecast_snapshots').find(
    { district_id: districtId },
    { sort: { forecast_generated_at: -1, forecast_horizon_hours: 1 }, limit: 4 }
  ).toArray();
}

// ---------------- Alerts history ----------------

export async function insertAlertRecord(alert: any): Promise<string> {
  const legacyId = await nextIdFor('alerts_history');
  await C('alerts_history').replaceOne(
    { alert_id: alert.alert_id },
    {
      _id: alert.alert_id,
      legacy_id: legacyId,
      ...alert,
      status: alert.status || 'Active',
      created_at: alert.created_at || new Date(),
    },
    { upsert: true }
  );
  return alert.alert_id;
}

export async function getAlertsHistoryForDistrict(districtId: string, limit = 20): Promise<any[]> {
  return await C('alerts_history').find(
    { $or: [{ district_id: districtId }, { district_name: districtId }] },
    { sort: { created_at: -1 }, limit }
  ).toArray();
}

export async function getAllAlertsHistory(limit = 100): Promise<any[]> {
  return await C('alerts_history').find({}, { sort: { created_at: -1 }, limit }).toArray();
}

export async function updateAlertStatus(alertId: string, status: string): Promise<boolean> {
  const resolvedAt = (status === 'Resolved' || status === 'Acknowledged') ? new Date() : null;
  const r = await C('alerts_history').updateOne({ alert_id: alertId }, { $set: { status, resolved_at: resolvedAt } });
  return r.modifiedCount > 0;
}

// ---------------- Notification history ----------------

export async function getNotificationHistory(limit: number = 50, districtId?: string): Promise<any[]> {
  const query: any = { is_prototype: 1 };
  if (districtId) query.$or = [{ district_id: districtId }, { district_name: districtId }];
  const rows = await C('notification_history').find(query, { sort: { timestamp: -1 }, limit }).toArray();
  return rows.map((r: any) => ({
    ...r,
    metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : undefined,
  }));
}

// ---------------- Migration audit ----------------

export async function recordMigrationAudit(entry: Record<string, any>): Promise<void> {
  await C('migrations_audit').insertOne({ _id: new ObjectId(), ...entry });
}
