export interface MigrationStateCollection {
  countDocuments(filter?: any): Promise<number>;
  findOne(filter: any): Promise<any>;
  insertOne(doc: any): Promise<any>;
  updateOne(filter: any, update: any, options?: any): Promise<any>;
}

export interface MigrationStateStore {
  collection(collection: string): Promise<MigrationStateCollection>;
  listCollections(): Promise<Array<{ name: string }>>;
}

export class InMemoryMigrationStateStore implements MigrationStateStore {
  private collections = new Map<string, any[]>();

  private get(name: string): any[] {
    if (!this.collections.has(name)) this.collections.set(name, []);
    return this.collections.get(name)!;
  }

  async collection(name: string) {
    const store = this;
    return {
      async countDocuments(filter?: any) {
        return store.get(name).filter(doc => matches(doc, filter)).length;
      },
      async findOne(filter: any) {
        return store.get(name).find(doc => matches(doc, filter)) || null;
      },
      async insertOne(doc: any) {
        const docs = store.get(name);
        if (docs.some(existing => matches(existing, { _id: doc?._id }))) {
          const error: any = new Error('E11000 duplicate key error');
          error.code = 11000;
          throw error;
        }
        docs.push({ ...doc });
        return { insertedId: doc?._id };
      },
      async updateOne(filter: any, update: any, options?: any) {
        const docs = store.get(name);
        const idx = docs.findIndex(doc => matches(doc, filter));
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
  return Object.entries(filter || {}).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).every(([operator, operand]) => {
        if (operator === '$ne') return doc?.[key] !== operand;
        if (operator === '$eq') return doc?.[key] === operand;
        return false;
      });
    }
    return doc?.[key] === value;
  });
}

export function isCompleted(state: any, sourceCount: number): boolean {
  return state?.status === 'completed' && state.sourceCount === sourceCount;
}

export function isStaleLock(lock: any, now: number = Date.now(), staleMs: number = 60 * 60 * 1000): boolean {
  if (!lock || lock.status !== 'running' || !lock.startedAt) return false;
  const started = new Date(lock.startedAt).getTime();
  return Number.isFinite(started) && now - started >= staleMs;
}

/**
 * Explicit, opt-in recovery for a stale lock. Never takes over automatically:
 * the caller must pass --recover-stale-lock. The lock is marked failed so the
 * normal acquireLock path can safely re-acquire it on the next run.
 */
export async function recoverStaleLock(
  state: MigrationStateCollection,
  now: number = Date.now(),
  staleMs: number = 60 * 60 * 1000
): Promise<{ recovered: boolean; reason: string }> {
  const lock = await state.findOne({ _id: 'migration_lock' });
  if (!lock || lock.status !== 'running') {
    return { recovered: false, reason: 'No running migration lock was found.' };
  }
  if (!isStaleLock(lock, now, staleMs)) {
    return { recovered: false, reason: 'Migration lock is still running and is not stale.' };
  }
  const result = await state.updateOne(
    { _id: 'migration_lock', status: 'running' },
    { $set: { status: 'failed', recoveredAt: new Date(now).toISOString(), recoveredReason: 'stale_lock_recovered' } }
  );
  const recovered = Number(result?.matchedCount ?? 0) > 0 || Number(result?.modifiedCount ?? 0) > 0;
  return {
    recovered,
    reason: recovered ? 'Stale lock marked failed; rerun the importer to re-acquire it.' : 'Lock changed while recovering; no action taken.',
  };
}
