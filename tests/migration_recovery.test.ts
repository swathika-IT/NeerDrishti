import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSourceDatabase } from '../scripts/migration/importer_core';
import { InMemoryMigrationStateStore, isCompleted, isStaleLock } from '../scripts/migration/recovery';

test('migration source database must exist before opening', () => {
  assert.throws(() => openSourceDatabase('/tmp/does-not-exist.db'), /Source database not found/);
});

test('isCompleted requires completed status and matching source count', () => {
  assert.equal(isCompleted({ status: 'completed', sourceCount: 3 }, 3), true);
  assert.equal(isCompleted({ status: 'completed', sourceCount: 2 }, 3), false);
  assert.equal(isCompleted({ status: 'running', sourceCount: 3 }, 3), false);
  assert.equal(isCompleted(null, 3), false);
});

test('isStaleLock only flags running locks older than the threshold', () => {
  assert.equal(isStaleLock(null), false);
  assert.equal(isStaleLock({ status: 'completed', startedAt: '2020-01-01T00:00:00.000Z' }), false);
  assert.equal(isStaleLock({ status: 'running', startedAt: '2020-01-01T00:00:00.000Z' }, Date.now()), true);
  assert.equal(isStaleLock({ status: 'running', startedAt: new Date().toISOString() }, Date.now()), false);
  assert.equal(isStaleLock({ status: 'running' }, Date.now()), false);
});

test('in-memory migration state store rejects duplicate lock ids', async () => {
  const store = new InMemoryMigrationStateStore();
  const state = await store.collection('migration_state');

  await state.insertOne({ _id: 'migration_lock', status: 'completed' });
  await assert.rejects(
    () => state.insertOne({ _id: 'migration_lock', status: 'running' }),
    (err: any) => err.code === 11000
  );
  assert.equal(await state.countDocuments(), 1);
  assert.equal(await state.countDocuments({ _id: 'migration_lock' }), 1);
  assert.equal((await state.findOne({ _id: 'migration_lock' })).status, 'completed');

  const result = await state.updateOne({ _id: 'migration_lock' }, { $set: { status: 'failed' } });
  assert.equal(result.modifiedCount, 1);
  assert.equal((await state.findOne({ _id: 'migration_lock' })).status, 'failed');
});
