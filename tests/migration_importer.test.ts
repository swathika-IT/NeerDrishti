import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  acquireLock,
  buildMappings,
  compositeId,
  insertDocuments,
  releaseLock,
  validateMongoUri,
  verifyCompletedCollection,
} from '../scripts/migration/importer_core';
import { InMemoryMigrationStateStore } from '../scripts/migration/recovery';

class MemoryCollection {
  collectionName: string;
  private docs = new Map<any, any>();

  constructor(name: string, initial: any[] = []) {
    this.collectionName = name;
    for (const doc of initial) this.docs.set(doc._id, JSON.parse(JSON.stringify(doc)));
  }

  async insertOne(doc: any) {
    if (this.docs.has(doc._id)) {
      const error: any = new Error('E11000 duplicate key error');
      error.code = 11000;
      throw error;
    }
    this.docs.set(doc._id, JSON.parse(JSON.stringify(doc)));
    return { insertedId: doc._id };
  }

  async findOne(filter: any) {
    if (filter && filter._id !== undefined) {
      const doc = this.docs.get(filter._id);
      return doc ? JSON.parse(JSON.stringify(doc)) : null;
    }
    for (const doc of this.docs.values()) {
      if (Object.entries(filter || {}).every(([key, value]) => doc[key] === value)) {
        return JSON.parse(JSON.stringify(doc));
      }
    }
    return null;
  }

  async countDocuments() {
    return this.docs.size;
  }

  async updateOne(filter: any, update: any) {
    const existing = await this.findOne(filter);
    if (!existing) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(existing, update.$set || {});
    this.docs.set(existing._id, JSON.parse(JSON.stringify(existing)));
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

function createFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neerdrishti-migration-'));
  const dbPath = path.join(dir, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE districts (district_id TEXT, district_name TEXT, monitoring_category TEXT, region_zone TEXT, data_source_mode TEXT, data_confidence TEXT);
    CREATE TABLE hydrological_stations (station_id TEXT, station_name TEXT, water_body_name TEXT, water_body_type TEXT, district_id TEXT, basin TEXT, latitude REAL, longitude REAL, warning_threshold REAL, danger_threshold REAL, unit TEXT, active INTEGER, metadata TEXT);
    CREATE TABLE users (id INTEGER, email TEXT, password_hash TEXT, full_name TEXT, role TEXT, status TEXT, phone TEXT, phone_verified INTEGER, email_verified_at TEXT, email_verify_token_hash TEXT, created_at TEXT, updated_at TEXT, last_login_at TEXT, deleted_at TEXT);
    CREATE TABLE sessions (id TEXT, user_id INTEGER, created_at TEXT, expires_at TEXT, ip TEXT, user_agent TEXT, revoked_at TEXT);
    CREATE TABLE email_verifications (id INTEGER, user_id INTEGER, token_hash TEXT, expires_at TEXT, used_at TEXT, created_at TEXT);
    CREATE TABLE password_resets (id INTEGER, user_id INTEGER, token_hash TEXT, expires_at TEXT, used_at TEXT, created_at TEXT);
    CREATE TABLE role_requests (id INTEGER, user_id INTEGER, requested_role TEXT, reason TEXT, department TEXT, status TEXT, reviewed_by INTEGER, reviewed_at TEXT, review_note TEXT, created_at TEXT);
    CREATE TABLE official_profiles (user_id INTEGER, department TEXT, designation TEXT, employee_reference TEXT, approval_status TEXT, approved_by INTEGER, approved_at TEXT, rejection_reason TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE official_jurisdictions (official_user_id INTEGER, district_id TEXT, granted_by INTEGER, granted_at TEXT);
    CREATE TABLE user_districts (user_id INTEGER, district_id TEXT, created_at TEXT);
    CREATE TABLE alert_subscriptions (id INTEGER, user_id INTEGER, district_id TEXT, min_severity TEXT, created_at TEXT);
    CREATE TABLE notification_preferences (user_id INTEGER, email_enabled INTEGER, sms_enabled INTEGER, whatsapp_enabled INTEGER, consent_given_at TEXT, consent_source TEXT, unsubscribed_all_at TEXT, quiet_hours_start TEXT, quiet_hours_end TEXT, updated_at TEXT);
    CREATE TABLE audit_logs (id INTEGER, actor_user_id INTEGER, actor_role TEXT, action TEXT, entity_type TEXT, entity_id TEXT, details TEXT, ip TEXT, created_at TEXT);
    CREATE TABLE citizen_reports (id INTEGER, district_id TEXT);
    CREATE TABLE report_classification (id INTEGER, report_id INTEGER);
    CREATE TABLE report_moderation_history (id INTEGER, report_id INTEGER);
    CREATE TABLE report_attachments (id INTEGER, report_id INTEGER);
    CREATE TABLE external_signals (id INTEGER, metadata TEXT);
    CREATE TABLE forecast_snapshots (id INTEGER, district_id TEXT);
    CREATE TABLE alerts_history (id INTEGER, alert_id TEXT);
    CREATE TABLE notification_history (id INTEGER, district_id TEXT);
    CREATE TABLE schema_migrations (id INTEGER, name TEXT, checksum TEXT, applied_at TEXT);
    CREATE TABLE _autoinc (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `);
  db.exec(`
    INSERT INTO districts VALUES ('TG-1','District One','Standard','Central','Simulated','Medium');
    INSERT INTO hydrological_stations VALUES ('ST-1','Station One','River','river_level','TG-1','Godavari',1.0,2.0,3.0,4.0,'m',1,'{"a":1}');
    INSERT INTO users VALUES (1,'a@example.com','hash','A','ADMIN','ACTIVE',NULL,0,NULL,NULL,'2026-01-01','2026-01-01',NULL,NULL),(2,'b@example.com','hash','B','CITIZEN','ACTIVE',NULL,0,NULL,NULL,'2026-01-01','2026-01-01',NULL,NULL);
    INSERT INTO sessions VALUES ('sess_a',1,'2026-01-01','2026-02-01',NULL,NULL,NULL),('sess_b',2,'2026-01-01','2026-02-01',NULL,NULL,NULL);
    INSERT INTO email_verifications VALUES (1,1,'tok1','2026-02-01',NULL,'2026-01-01');
    INSERT INTO official_jurisdictions VALUES (1,'TG-1',1,'2026-01-01');
    INSERT INTO user_districts VALUES (1,'TG-1','2026-01-01');
    INSERT INTO audit_logs VALUES (1,1,'ADMIN','ACTION','user','1',NULL,NULL,'2026-01-01');
    INSERT INTO citizen_reports VALUES (1,'TG-1');
    INSERT INTO report_classification VALUES (1,1);
    INSERT INTO report_moderation_history VALUES (1,1);
    INSERT INTO external_signals VALUES (1,'{"station":"ST-1"}');
    INSERT INTO forecast_snapshots VALUES (1,'TG-1');
    INSERT INTO schema_migrations VALUES (1,'001_identity_access.sql','abc','2026-01-01'),(2,'002_reports_canonicalization.sql','def','2026-01-01'),(3,'003_signals_notifications_integrity.sql','ghi','2026-01-01');
    DELETE FROM sqlite_sequence;
    INSERT INTO sqlite_sequence (name, seq) VALUES ('users',2),('citizen_reports',1),('report_classification',1),('external_signals',1),('forecast_snapshots',1),('report_moderation_history',1),('audit_logs',1),('email_verifications',1);
  `);
  return { db, dir };
}

function mappingFor(mappings: Array<{ collection: string; docs: any[] }>, collection: string) {
  const mapping = mappings.find((m) => m.collection === collection);
  assert.ok(mapping, `missing mapping ${collection}`);
  return mapping;
}

test('buildMappings produces all 23 collections with expected counts', () => {
  const { db, dir } = createFixtureDb();
  try {
    const mappings = buildMappings(db);
    assert.equal(mappings.length, 23);
    const expected: Record<string, number> = {
      districts: 1,
      hydrological_stations: 1,
      users: 2,
      sessions: 2,
      email_verifications: 1,
      password_resets: 0,
      role_requests: 0,
      official_profiles: 0,
      official_jurisdictions: 1,
      user_districts: 1,
      alert_subscriptions: 0,
      notification_preferences: 0,
      audit_logs: 1,
      citizen_reports: 1,
      report_classification: 1,
      report_moderation_history: 1,
      report_attachments: 0,
      external_signals: 1,
      forecast_snapshots: 1,
      alerts_history: 0,
      notification_history: 0,
      schema_migrations: 3,
      sequences: 8,
    };
    for (const [collection, count] of Object.entries(expected)) {
      assert.equal(mappingFor(mappings, collection).docs.length, count, collection);
    }
    const total = mappings.reduce((sum, m) => sum + m.docs.length, 0);
    assert.equal(total, 26);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deterministic IDs are stable across builds and match natural keys', () => {
  const { db, dir } = createFixtureDb();
  try {
    const first = buildMappings(db);
    const second = buildMappings(db);

    const sessions = mappingFor(first, 'sessions').docs;
    assert.deepEqual(sessions.map((d) => d._id).sort(), ['sess_a', 'sess_b']);
    assert.deepEqual(sessions.map((d) => d._id).sort(), mappingFor(second, 'sessions').docs.map((d) => d._id).sort());

    assert.deepEqual(mappingFor(first, 'official_jurisdictions').docs.map((d) => d._id), ['1|TG-1']);
    assert.deepEqual(mappingFor(first, 'user_districts').docs.map((d) => d._id), ['1|TG-1']);
    assert.equal(compositeId(1, 'TG-1'), '1|TG-1');
    assert.throws(() => compositeId(1, ''));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema_migrations and sequences bookkeeping is preserved', () => {
  const { db, dir } = createFixtureDb();
  try {
    const mappings = buildMappings(db);
    const schema = mappingFor(mappings, 'schema_migrations').docs;
    assert.deepEqual(schema.map((d) => d._id), [
      '001_identity_access.sql',
      '002_reports_canonicalization.sql',
      '003_signals_notifications_integrity.sql',
    ]);
    assert.equal(schema[0].checksum, 'abc');
    assert.equal(schema[0].applied_at, '2026-01-01');

    const sequences = mappingFor(mappings, 'sequences').docs;
    assert.equal(sequences.length, 8);
    assert.equal(sequences.find((d) => d.name === 'users').value, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertDocuments is idempotent across reruns', async () => {
  const { db, dir } = createFixtureDb();
  try {
    const docs = mappingFor(buildMappings(db), 'districts').docs;
    const col = new MemoryCollection('districts');
    const first = await insertDocuments(col, docs);
    const second = await insertDocuments(col, docs);
    assert.deepEqual(first, { inserted: 1, skipped: 0 });
    assert.deepEqual(second, { inserted: 0, skipped: 1 });
    assert.equal(await col.countDocuments(), 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertDocuments rejects conflicting duplicate records', async () => {
  const { db, dir } = createFixtureDb();
  try {
    const docs = mappingFor(buildMappings(db), 'districts').docs;
    const col = new MemoryCollection('districts', [{ _id: docs[0]._id, district_name: 'Different' }]);
    await assert.rejects(() => insertDocuments(col, docs), /Conflicting record/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertDocuments rejects unexpected extra records', async () => {
  const { db, dir } = createFixtureDb();
  try {
    const docs = mappingFor(buildMappings(db), 'districts').docs;
    const col = new MemoryCollection('districts', [{ _id: 'extra' }]);
    await assert.rejects(() => insertDocuments(col, docs), /Unexpected extra records/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('insertDocuments rejects a non-empty target for an empty source', async () => {
  const col = new MemoryCollection('password_resets', [{ _id: 1 }]);
  await assert.rejects(() => insertDocuments(col, []), /Unexpected extra records/);
});

test('verifyCompletedCollection checks counts before skipping', async () => {
  const state = { status: 'completed', sourceCount: 2 };
  const matching = new MemoryCollection('users', [{ _id: 1 }, { _id: 2 }]);
  assert.equal(await verifyCompletedCollection(matching, state, 2), true);

  const incomplete = new MemoryCollection('users', [{ _id: 1 }]);
  await assert.rejects(() => verifyCompletedCollection(incomplete, state, 2), /Checkpoint count mismatch/);

  assert.equal(await verifyCompletedCollection(matching, { status: 'running', sourceCount: 2 }, 2), false);
  assert.equal(await verifyCompletedCollection(matching, null, 2), false);
});

test('acquireLock prevents concurrent importers and refuses stale running locks', async () => {
  const store = new InMemoryMigrationStateStore();
  const state = await store.collection('migration_state');

  assert.deepEqual(await acquireLock(state), { acquired: true });
  const second = await acquireLock(state);
  assert.equal(second.acquired, false);
  assert.match(second.reason || '', /manual recovery required/);

  await releaseLock(state, 'completed');
  assert.deepEqual(await acquireLock(state), { acquired: true });

  await releaseLock(state, 'failed');
  await state.updateOne(
    { _id: 'migration_lock' },
    { $set: { status: 'running', startedAt: '2020-01-01T00:00:00.000Z' } }
  );
  const stale = await acquireLock(state);
  assert.equal(stale.acquired, false);
  assert.match(stale.reason || '', /manual recovery required/);
});

test('validateMongoUri enforces the staging database and rejects ac_solutions', () => {
  assert.equal(validateMongoUri('').ok, false);
  assert.equal(validateMongoUri('mongodb://host/').ok, false);
  assert.equal(validateMongoUri('mongodb://host/ac_solutions').ok, false);
  assert.equal(validateMongoUri('mongodb://host/other_db').ok, false);
  assert.equal(validateMongoUri('mongodb://host/neerdrishti_staging').ok, true);
  assert.equal(validateMongoUri('mongodb+srv://host/neerdrishti_staging?retryWrites=true').ok, true);
});
