import assert from 'node:assert/strict';
import { test } from 'node:test';

function isCompleted(state: any, sourceCount: number): boolean {
  return state?.status === 'completed' && state.sourceCount === sourceCount;
}

function isStaleLock(lock: any, now: number = Date.now(), staleMs: number = 60 * 60 * 1000): boolean {
  if (!lock || lock.status !== 'running' || !lock.startedAt) return false;
  const started = new Date(lock.startedAt).getTime();
  return Number.isFinite(started) && now - started >= staleMs;
}

class InMemoryMigrationStateStore {
  private collections = new Map<string, any[]>();
  private get(name: string): any[] {
    if (!this.collections.has(name)) this.collections.set(name, []);
    return this.collections.get(name)!;
  }
  async collection(name: string) {
    const store = this;
    return {
      async countDocuments(filter?: any) {
        return store.get(name).filter((doc: any) => matches(doc, filter)).length;
      },
      async findOne(filter: any) {
        return store.get(name).find((doc: any) => matches(doc, filter)) || null;
      },
      async updateOne(filter: any, update: any, options?: any) {
        const docs = store.get(name);
        const idx = docs.findIndex((doc: any) => matches(doc, filter));
        if (idx >= 0) {
          docs[idx] = { ...docs[idx], ...(update.$set || {}) };
          return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (options?.upsert) {
          docs.push({ ...(update.$set || {}) });
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      },
    };
  }
  async listCollections() {
    return Array.from(this.collections.keys()).map(name => ({ name }));
  }
}

function matches(doc: any, filter: any): boolean {
  if (!filter) return true;
  return Object.entries(filter || {}).every(([key, value]) => doc?.[key] === value);
}

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
