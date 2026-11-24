import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPROVED_EXCLUSIONS,
  EXPECTED_APPROVED_IMPORT_TOTAL,
  acquireLock,
  buildImportPlan,
  formatImportPlanSummary,
  isCompleted,
  recordPolicyExclusions,
  verifyCompletedCollection,
  verifyPolicyExclusions,
} from '../scripts/migration/importer_core';
import type { MigrationMapping } from '../scripts/migration/importer_core';
import { InMemoryMigrationStateStore, recoverStaleLock } from '../scripts/migration/recovery';

function fixtureMappings(): MigrationMapping[] {
  return [
    { collection: 'districts', docs: [{ _id: 'TG-1', district_name: 'District One' }] },
    { collection: 'users', docs: [{ _id: 1, password_hash: 'bcrypt-fixture-hash' }] },
    { collection: 'sessions', docs: [{ _id: 's1' }, { _id: 's2' }] },
    { collection: 'email_verifications', docs: [{ _id: 1 }] },
    { collection: 'password_resets', docs: [] },
    { collection: 'sequences', docs: [{ _id: 'users', value: 1 }] },
  ];
}

function fixtureExclusions() {
  return [
    { collection: 'sessions', sourceCount: 2, reason: 'expired_or_revoked_session_records' },
    { collection: 'email_verifications', sourceCount: 1, reason: 'expired_verification_record' },
    { collection: 'password_resets', sourceCount: 0, reason: 'empty_collection' },
  ];
}

test('approved exclusion policy is exact', () => {
  assert.deepEqual(APPROVED_EXCLUSIONS.map((e) => e.collection), [
    'sessions',
    'email_verifications',
    'password_resets',
  ]);
  assert.deepEqual(APPROVED_EXCLUSIONS.map((e) => e.sourceCount), [3, 1, 0]);
  assert.equal(EXPECTED_APPROVED_IMPORT_TOTAL, 3613);
});

test('buildImportPlan excludes only approved collections and preserves password hashes', () => {
  const plan = buildImportPlan(fixtureMappings(), { exclusions: fixtureExclusions(), expectedTotal: 3 });
  assert.deepEqual(plan.imports.map((m) => m.collection), ['districts', 'users', 'sequences']);
  assert.equal(plan.sourceCollectionCount, 6);
  assert.equal(plan.sourceTotal, 6);
  assert.equal(plan.importedTotal, 3);
  assert.equal(plan.excludedTotal, 3);
  assert.equal(plan.exclusions.length, 3);
  const users = plan.imports.find((m) => m.collection === 'users');
  assert.ok(users);
  assert.equal(users.docs[0].password_hash, 'bcrypt-fixture-hash');
});

test('dry-run summary reports exclusions and per-collection counts', () => {
  const plan = buildImportPlan(fixtureMappings(), { exclusions: fixtureExclusions(), expectedTotal: 3 });
  const summary = formatImportPlanSummary(plan, 'DRY-RUN').join('\n');
  assert.match(summary, /Mode: DRY-RUN/);
  assert.match(summary, /Planned imported documents: 3/);
  assert.match(summary, /districts: 1 \(dry-run\)/);
  assert.match(summary, /sessions: EXCLUDED_BY_POLICY source=2 reason=expired_or_revoked_session_records/);
  assert.match(summary, /email_verifications: EXCLUDED_BY_POLICY source=1 reason=expired_verification_record/);
  assert.match(summary, /password_resets: EXCLUDED_BY_POLICY source=0 reason=empty_collection/);
});

test('buildImportPlan rejects count mismatches, unknown exclusions, and wrong totals', () => {
  assert.throws(
    () =>
      buildImportPlan(fixtureMappings(), {
        exclusions: [{ collection: 'sessions', sourceCount: 99, reason: 'bad' }],
      }),
    /Excluded collection count mismatch/
  );
  assert.throws(
    () =>
      buildImportPlan(fixtureMappings(), {
        exclusions: [{ collection: 'unknown', sourceCount: 0, reason: 'bad' }],
      }),
    /unknown collection/
  );
  assert.throws(
    () => buildImportPlan(fixtureMappings(), { exclusions: fixtureExclusions(), expectedTotal: 2 }),
    /Planned import total mismatch/
  );
});

test('policy exclusions are recorded as exclusions, not completed imports', async () => {
  const plan = buildImportPlan(fixtureMappings(), { exclusions: fixtureExclusions(), expectedTotal: 3 });
  const store = new InMemoryMigrationStateStore();
  const state = await store.collection('migration_state');
  const now = Date.parse('2026-11-23T00:00:00.000Z');

  await recordPolicyExclusions(state, plan, now);
  const sessionsState = await state.findOne({ collection: 'sessions' });
  assert.equal(sessionsState.status, 'excluded_by_policy');
  assert.equal(sessionsState.policy, 'approved_exclusion');
  assert.equal(sessionsState.sourceCount, 2);
  assert.equal(sessionsState.reason, 'expired_or_revoked_session_records');
  assert.equal(isCompleted(sessionsState, 2), false);
  assert.equal(
    await verifyCompletedCollection({ countDocuments: async () => 2 } as any, sessionsState, 2),
    false
  );
  assert.equal(await verifyPolicyExclusions(state, plan), true);
});

test('policy exclusion verification rejects tampered checkpoint states', async () => {
  const plan = buildImportPlan(fixtureMappings(), { exclusions: fixtureExclusions(), expectedTotal: 3 });
  const store = new InMemoryMigrationStateStore();
  const state = await store.collection('migration_state');
  await recordPolicyExclusions(state, plan);
  await state.updateOne({ collection: 'email_verifications' }, { $set: { status: 'completed' } });
  await assert.rejects(() => verifyPolicyExclusions(state, plan), /Missing policy-exclusion checkpoint/);
});

test('stale lock recovery preserves policy exclusion checkpoints', async () => {
  const plan = buildImportPlan(fixtureMappings(), { exclusions: fixtureExclusions(), expectedTotal: 3 });
  const store = new InMemoryMigrationStateStore();
  const state = await store.collection('migration_state');
  const now = Date.parse('2026-11-23T00:00:00.000Z');

  await recordPolicyExclusions(state, plan, now);
  assert.equal((await acquireLock(state, now)).acquired, true);
  const recovery = await recoverStaleLock(state, now + 2 * 60 * 60 * 1000);
  assert.equal(recovery.recovered, true);
  const sessionsState = await state.findOne({ collection: 'sessions' });
  assert.equal(sessionsState.status, 'excluded_by_policy');
  assert.equal(await verifyPolicyExclusions(state, plan), true);
});
