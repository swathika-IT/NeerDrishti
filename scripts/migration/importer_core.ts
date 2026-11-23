import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { validateMongoConnectionString } from '../../src/config/mongo_uri';

export interface MigrationMapping {
  collection: string;
  docs: any[];
}

export interface ApprovedExclusion {
  collection: string;
  sourceCount: number;
  reason: string;
}

/**
 * Approved policy exclusions for the staging import. These collections are
 * counted for reconciliation but never inserted, and are recorded in state.
 */
export const APPROVED_EXCLUSIONS = [
  { collection: 'sessions', sourceCount: 3, reason: 'expired_or_revoked_session_records' },
  { collection: 'email_verifications', sourceCount: 1, reason: 'expired_verification_record' },
  { collection: 'password_resets', sourceCount: 0, reason: 'empty_collection' },
] as const;

export const EXPECTED_APPROVED_IMPORT_TOTAL = 3613;

export interface InsertResult {
  inserted: number;
  skipped: number;
}

export interface MigrationStateCollection {
  countDocuments(filter?: any): Promise<number>;
  findOne(filter: any): Promise<any>;
  insertOne(doc: any): Promise<any>;
  updateOne(filter: any, update: any, options?: any): Promise<any>;
}

export function openSourceDatabase(sourcePath: string): DatabaseSync {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }
  return new DatabaseSync(sourcePath, { readOnly: true });
}

export function parseJson(value: any): any {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rows(sqlite: DatabaseSync, table: string): any[] {
  return sqlite.prepare(`SELECT * FROM "${table}"`).all() as any[];
}

export function compositeId(...parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => {
      if (part === null || part === undefined || part === '') {
        throw new Error('compositeId requires non-empty parts');
      }
      return String(part);
    })
    .join('|');
}

export function buildMappings(sqlite: DatabaseSync): MigrationMapping[] {
  const districts = rows(sqlite, 'districts').map((r) => ({
    _id: r.district_id,
    district_id: r.district_id,
    district_name: r.district_name,
    monitoring_category: r.monitoring_category,
    region_zone: r.region_zone,
    data_source_mode: r.data_source_mode,
    data_confidence: r.data_confidence,
  }));

  const hydro = rows(sqlite, 'hydrological_stations').map((r) => ({
    _id: r.station_id,
    station_id: r.station_id,
    station_name: r.station_name,
    water_body_name: r.water_body_name,
    water_body_type: r.water_body_type,
    district_id: r.district_id,
    basin: r.basin,
    latitude: r.latitude,
    longitude: r.longitude,
    warning_threshold: r.warning_threshold,
    danger_threshold: r.danger_threshold,
    unit: r.unit,
    active: r.active,
    metadata: parseJson(r.metadata),
  }));

  const users = rows(sqlite, 'users').map((r) => ({ _id: r.id, ...r }));
  const sessions = rows(sqlite, 'sessions').map((r) => ({
    _id: r.id,
    id: r.id,
    user_id: r.user_id,
    created_at: r.created_at,
    expires_at: r.expires_at,
    ip: r.ip,
    user_agent: r.user_agent,
    revoked_at: r.revoked_at,
  }));
  const emailVerifications = rows(sqlite, 'email_verifications').map((r) => ({ _id: r.id, ...r }));
  const passwordResets = rows(sqlite, 'password_resets').map((r) => ({ _id: r.id, ...r }));
  const roleRequests = rows(sqlite, 'role_requests').map((r) => ({ _id: r.id, ...r }));

  const officialProfiles = rows(sqlite, 'official_profiles').map((r) => ({ _id: r.user_id, ...r }));

  const officialJurisdictions = rows(sqlite, 'official_jurisdictions').map((r) => ({
    _id: compositeId(r.official_user_id, r.district_id),
    official_user_id: r.official_user_id,
    district_id: r.district_id,
    granted_by: r.granted_by,
    granted_at: r.granted_at,
  }));

  const userDistricts = rows(sqlite, 'user_districts').map((r) => ({
    _id: compositeId(r.user_id, r.district_id),
    user_id: r.user_id,
    district_id: r.district_id,
    created_at: r.created_at,
  }));

  const alertSubs = rows(sqlite, 'alert_subscriptions').map((r) => ({ _id: r.id, ...r }));
  const notifPrefs = rows(sqlite, 'notification_preferences').map((r) => ({ _id: r.user_id, ...r }));
  const auditLogs = rows(sqlite, 'audit_logs').map((r) => ({ _id: r.id, ...r }));
  const citizenReports = rows(sqlite, 'citizen_reports').map((r) => ({ _id: r.id, ...r }));
  const reportClassification = rows(sqlite, 'report_classification').map((r) => ({ _id: r.id, ...r }));
  const moderation = rows(sqlite, 'report_moderation_history').map((r) => ({ _id: r.id, ...r }));
  const attachments = rows(sqlite, 'report_attachments').map((r) => ({ _id: r.id, ...r }));
  const externalSignals = rows(sqlite, 'external_signals').map((r) => ({ _id: r.id, ...r, metadata: parseJson(r.metadata) }));
  const forecasts = rows(sqlite, 'forecast_snapshots').map((r) => ({ _id: r.id, ...r }));
  const alertsHistory = rows(sqlite, 'alerts_history').map((r) => ({ _id: r.alert_id, legacy_id: r.id, ...r }));
  const notificationHistory = rows(sqlite, 'notification_history').map((r) => ({ _id: r.id, ...r }));

  const schemaMigrations = rows(sqlite, 'schema_migrations').map((r) => ({
    _id: r.name,
    id: r.id,
    name: r.name,
    checksum: r.checksum,
    applied_at: r.applied_at,
  }));

  const sequenceRows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").all();
  const seqRows = sequenceRows.length > 0 ? (sqlite.prepare('SELECT * FROM sqlite_sequence').all() as any[]) : [];
  const sequences = seqRows.map((r) => ({ _id: r.name, name: r.name, value: r.seq }));

  return [
    { collection: 'districts', docs: districts },
    { collection: 'hydrological_stations', docs: hydro },
    { collection: 'users', docs: users },
    { collection: 'sessions', docs: sessions },
    { collection: 'email_verifications', docs: emailVerifications },
    { collection: 'password_resets', docs: passwordResets },
    { collection: 'role_requests', docs: roleRequests },
    { collection: 'official_profiles', docs: officialProfiles },
    { collection: 'official_jurisdictions', docs: officialJurisdictions },
    { collection: 'user_districts', docs: userDistricts },
    { collection: 'alert_subscriptions', docs: alertSubs },
    { collection: 'notification_preferences', docs: notifPrefs },
    { collection: 'audit_logs', docs: auditLogs },
    { collection: 'citizen_reports', docs: citizenReports },
    { collection: 'report_classification', docs: reportClassification },
    { collection: 'report_moderation_history', docs: moderation },
    { collection: 'report_attachments', docs: attachments },
    { collection: 'external_signals', docs: externalSignals },
    { collection: 'forecast_snapshots', docs: forecasts },
    { collection: 'alerts_history', docs: alertsHistory },
    { collection: 'notification_history', docs: notificationHistory },
    { collection: 'schema_migrations', docs: schemaMigrations },
    { collection: 'sequences', docs: sequences },
  ];
}

export interface PlannedExclusion extends ApprovedExclusion {
  actualSourceCount: number;
  status: 'excluded_by_policy';
}

export interface ImportPlan {
  sourceCollectionCount: number;
  sourceTotal: number;
  imports: MigrationMapping[];
  exclusions: PlannedExclusion[];
  importedTotal: number;
  excludedTotal: number;
}

export function buildImportPlan(
  mappings: MigrationMapping[],
  options: {
    exclusions?: readonly ApprovedExclusion[];
    expectedTotal?: number;
    validateExclusionCounts?: boolean;
  } = {}
): ImportPlan {
  const exclusions = options.exclusions ?? APPROVED_EXCLUSIONS;
  const excludedNames = new Set(exclusions.map((e) => e.collection));
  if (excludedNames.size !== exclusions.length) {
    throw new Error('Approved exclusions contain duplicate collection names');
  }

  const mappingsByName = new Map(mappings.map((m) => [m.collection, m]));
  for (const exclusion of exclusions) {
    const mapping = mappingsByName.get(exclusion.collection);
    if (!mapping) {
      throw new Error(`Approved exclusion references unknown collection: ${exclusion.collection}`);
    }
    if (options.validateExclusionCounts !== false && mapping.docs.length !== exclusion.sourceCount) {
      throw new Error(
        `Excluded collection count mismatch: ${exclusion.collection} expected=${exclusion.sourceCount} actual=${mapping.docs.length}`
      );
    }
  }

  const imports = mappings.filter((m) => !excludedNames.has(m.collection));
  const plannedExclusions: PlannedExclusion[] = exclusions.map((exclusion) => ({
    collection: exclusion.collection,
    sourceCount: exclusion.sourceCount,
    actualSourceCount: mappingsByName.get(exclusion.collection)!.docs.length,
    reason: exclusion.reason,
    status: 'excluded_by_policy' as const,
  }));

  const sourceTotal = mappings.reduce((sum, m) => sum + m.docs.length, 0);
  const importedTotal = imports.reduce((sum, m) => sum + m.docs.length, 0);
  const excludedTotal = plannedExclusions.reduce((sum, e) => sum + e.actualSourceCount, 0);
  if (sourceTotal !== importedTotal + excludedTotal) {
    throw new Error('Import plan count reconciliation failed');
  }
  if (options.expectedTotal !== undefined && importedTotal !== options.expectedTotal) {
    throw new Error(`Planned import total mismatch: expected=${options.expectedTotal} actual=${importedTotal}`);
  }

  return {
    sourceCollectionCount: mappings.length,
    sourceTotal,
    imports,
    exclusions: plannedExclusions,
    importedTotal,
    excludedTotal,
  };
}

export function formatImportPlanSummary(plan: ImportPlan, mode: 'DRY-RUN' | 'APPLY'): string[] {
  const lines = [
    `Source collections: ${plan.sourceCollectionCount}`,
    `Mode: ${mode}`,
    `Planned imported documents: ${plan.importedTotal}`,
    `Excluded by policy: ${plan.exclusions.length}`,
  ];
  for (const mapping of plan.imports) {
    lines.push(
      mode === 'DRY-RUN'
        ? `${mapping.collection}: ${mapping.docs.length} (dry-run)`
        : `${mapping.collection}: ${mapping.docs.length} planned`
    );
  }
  for (const exclusion of plan.exclusions) {
    lines.push(
      `${exclusion.collection}: EXCLUDED_BY_POLICY source=${exclusion.actualSourceCount} reason=${exclusion.reason}`
    );
  }
  lines.push(`Imported documents: ${plan.importedTotal}`);
  lines.push(`Excluded documents: ${plan.excludedTotal}`);
  return lines;
}

export async function recordPolicyExclusions(
  state: MigrationStateCollection,
  plan: ImportPlan,
  now: number = Date.now()
): Promise<void> {
  for (const exclusion of plan.exclusions) {
    await state.updateOne(
      { collection: exclusion.collection },
      {
        $set: {
          collection: exclusion.collection,
          status: 'excluded_by_policy',
          policy: 'approved_exclusion',
          sourceCount: exclusion.actualSourceCount,
          reason: exclusion.reason,
          recordedAt: new Date(now).toISOString(),
        },
      },
      { upsert: true }
    );
  }
}

export async function verifyPolicyExclusions(state: MigrationStateCollection, plan: ImportPlan): Promise<boolean> {
  for (const exclusion of plan.exclusions) {
    const recorded = await state.findOne({ collection: exclusion.collection });
    if (!recorded || recorded.status !== 'excluded_by_policy') {
      throw new Error(`Missing policy-exclusion checkpoint: ${exclusion.collection}`);
    }
    if (recorded.policy !== 'approved_exclusion') {
      throw new Error(`Invalid policy-exclusion marker: ${exclusion.collection}`);
    }
    if (Number(recorded.sourceCount) !== exclusion.actualSourceCount) {
      throw new Error(
        `Policy-exclusion count mismatch: ${exclusion.collection} expected=${exclusion.actualSourceCount} actual=${recorded.sourceCount}`
      );
    }
  }
  return true;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function canonical(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Buffer.isBuffer(value)) return `buffer:${value.toString('base64')}`;
  if (typeof value === 'object' && (value._bsontype === 'ObjectId' || typeof value.toHexString === 'function')) {
    return `objectid:${String(typeof value.toHexString === 'function' ? value.toHexString() : value)}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return `date:${parsed.toISOString()}`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function collectionName(col: any): string {
  return String(col?.collectionName ?? 'collection');
}

export async function insertDocuments(col: any, docs: any[]): Promise<InsertResult> {
  const name = collectionName(col);
  if (docs.length === 0) {
    const emptyTargetCount = await col.countDocuments();
    if (emptyTargetCount !== 0) {
      throw new Error(`Unexpected extra records in ${name}: source=0, target=${emptyTargetCount}`);
    }
    return { inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  for (const doc of docs) {
    try {
      await col.insertOne(doc);
      inserted++;
    } catch (err: any) {
      if (err?.code === 11000) {
        const existing = await col.findOne({ _id: doc._id });
        if (!existing) {
          throw new Error(`Duplicate _id=${String(doc._id)} in ${name} but no existing document was found.`);
        }
        if (canonical(existing) !== canonical(doc)) {
          throw new Error(`Conflicting record for _id=${String(doc._id)} in ${name}; refusing to skip.`);
        }
        skipped++;
        continue;
      }
      throw err;
    }
  }

  const targetCount = await col.countDocuments();
  if (targetCount < docs.length) {
    throw new Error(`Incomplete collection ${name}: source=${docs.length}, target=${targetCount}`);
  }
  if (targetCount > docs.length) {
    throw new Error(`Unexpected extra records in ${name}: source=${docs.length}, target=${targetCount}`);
  }
  return { inserted, skipped };
}

export function isCompleted(state: any, sourceCount: number): boolean {
  return state?.status === 'completed' && state.sourceCount === sourceCount;
}

export async function verifyCompletedCollection(col: any, state: any, sourceCount: number): Promise<boolean> {
  if (!isCompleted(state, sourceCount)) return false;
  const targetCount = await col.countDocuments();
  if (targetCount !== sourceCount) {
    throw new Error(`Checkpoint count mismatch: state sourceCount=${sourceCount}, target count=${targetCount}`);
  }
  return true;
}

export interface LockResult {
  acquired: boolean;
  reason?: string;
}

export async function acquireLock(state: MigrationStateCollection, now: number = Date.now()): Promise<LockResult> {
  const existing = await state.findOne({ _id: 'migration_lock' });
  if (existing?.status === 'running') {
    return { acquired: false, reason: 'migration_lock is running; manual recovery required' };
  }

  try {
    await state.insertOne({
      _id: 'migration_lock',
      status: 'running',
      startedAt: new Date(now).toISOString(),
      pid: process.pid,
    });
    return { acquired: true };
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const current = await state.findOne({ _id: 'migration_lock' });
    if (current?.status === 'running') {
      return { acquired: false, reason: 'migration_lock is running; manual recovery required' };
    }
    const result = await state.updateOne(
      { _id: 'migration_lock', status: { $ne: 'running' } },
      {
        $set: {
          _id: 'migration_lock',
          status: 'running',
          startedAt: new Date(now).toISOString(),
          pid: process.pid,
        },
      }
    );
    if (result?.matchedCount === 1 || result?.modifiedCount === 1) {
      return { acquired: true };
    }
    return { acquired: false, reason: 'migration_lock already exists; manual recovery required' };
  }
}

export async function releaseLock(state: MigrationStateCollection, status: 'completed' | 'failed' = 'completed'): Promise<void> {
  await state.updateOne(
    { _id: 'migration_lock' },
    { $set: { status, completedAt: new Date().toISOString() } }
  );
}

export interface MongoUriCheck {
  ok: boolean;
  database?: string;
  reason?: string;
}

export function validateMongoUri(uri: string): MongoUriCheck {
  const check = validateMongoConnectionString(uri);
  if (!check.ok) return { ok: false, reason: check.reason };
  const database = check.database!;
  if (database === 'ac_solutions') return { ok: false, reason: 'MONGODB_URI targets ac_solutions' };
  if (database !== 'neerdrishti_staging') {
    return { ok: false, reason: `MONGODB_URI database must be neerdrishti_staging (found ${database})` };
  }
  return { ok: true, database };
}
