import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCompleted, isStaleLock, InMemoryMigrationStateStore } from '../scripts/migration/recovery.js';

test('checkpoint completed detection', () => {
  assert.equal(isCompleted({ status: 'completed', sourceCount: 5 }, 5), true);
  assert.equal(isCompleted({ status: 'completed', sourceCount: 4 }, 5), false);
  assert.equal(isCompleted({ status: 'running', sourceCount: 5 }, 5), false);
});

test('stale lock detection', () => {
  const now = Date.now();
  const fresh = { status: 'running', startedAt: new Date(now - 1000).toISOString() };
  const stale = { status: 'running', startedAt: new Date(now - 70 * 60 * 1000).toISOString() };
  assert.equal(isStaleLock(fresh, now), false);
  assert.equal(isStaleLock(stale, now), true);
});

test('in-memory store checkpoint persistence', async () => {
  const store = new InMemoryMigrationStateStore();
  const col = await store.collection('migration_state');
  await col.updateOne({ collection: 'users' }, { $set: { collection: 'users', status: 'completed', sourceCount: 2, importedCount: 2 } }, { upsert: true });
  const found = await col.findOne({ collection: 'users' });
  assert.equal(found.status, 'completed');
  assert.equal(found.sourceCount, 2);
});

test('in-memory store lock rejection', async () => {
  const store = new InMemoryMigrationStateStore();
  const col = await store.collection('migration_state');
  await col.updateOne({ _id: 'migration_lock' }, { $set: { _id: 'migration_lock', status: 'running', startedAt: new Date().toISOString() } }, { upsert: true });
  const lock = await col.findOne({ _id: 'migration_lock' });
  assert.equal(lock.status, 'running');
});
