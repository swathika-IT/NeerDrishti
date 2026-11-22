import { MongoClient } from 'mongodb';

export interface MongoTestContext {
  uri: string;
  dbName: string;
  client: MongoClient;
}

const TEST_DB_PREFIX = 'neerdrishti_ci_test';

export function getMongoTestUri(): string {
  const uri = (process.env.MONGODB_TEST_URI || process.env.MIGRATION_TEST_MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_TEST_URI or MIGRATION_TEST_MONGODB_URI is required for MongoDB integration tests');
  assertSafeMongoTestUri(uri);
  return uri;
}

export function assertSafeMongoTestUri(uri: string): void {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error('Mongo test URI is invalid'); }
  if (parsed.protocol !== 'mongodb:') throw new Error('Mongo test URI must use mongodb:// (Atlas/SRV not allowed)');
  if (!['127.0.0.1', 'localhost', 'mongo', 'mongodb'].includes(parsed.hostname)) {
    throw new Error(`Mongo test URI host not allowed: ${parsed.hostname}`);
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!dbName) throw new Error('Mongo test URI must include database name');
  assertSafeTestDbName(dbName);
}

export function assertSafeTestDbName(dbName: string): void {
  if (!dbName.startsWith(TEST_DB_PREFIX)) {
    throw new Error(`Refusing unsafe test database name: ${dbName}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) throw new Error('Unsafe test database name characters');
}

export async function connectMongoTest(uri = getMongoTestUri()): Promise<MongoTestContext> {
  assertSafeMongoTestUri(uri);
  const parsed = new URL(uri);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0]);
  assertSafeTestDbName(dbName);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return { uri, dbName, client };
}

export async function resetMongoTestDb(ctx: MongoTestContext): Promise<void> {
  assertSafeTestDbName(ctx.dbName);
  const db = ctx.client.db(ctx.dbName);
  const collections = await db.collections();
  for (const c of collections) {
    await c.deleteMany({});
  }
}

export async function dropMongoTestDb(ctx: MongoTestContext): Promise<void> {
  assertSafeTestDbName(ctx.dbName);
  await ctx.client.db(ctx.dbName).dropDatabase();
}

export async function closeMongoTest(ctx: MongoTestContext): Promise<void> {
  await ctx.client.close();
}

export function installMongoTestEnv(uri = getMongoTestUri()): void {
  assertSafeMongoTestUri(uri);
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_TEST_URI = uri;
  process.env.NODE_ENV = 'test';
}