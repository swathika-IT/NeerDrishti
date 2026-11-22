import { MongoClient } from 'mongodb';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

const TEST_DB_PREFIX = 'neerdrishti_ci_test';

export function getMongoTestUri(): string {
  const uri = (process.env.MONGODB_TEST_URI || process.env.MIGRATION_TEST_MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_TEST_URI (or MIGRATION_TEST_MONGODB_URI) is required');
  assertSafeMongoTestUri(uri);
  return uri;
}

export function assertSafeMongoTestUri(uri: string): void {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error('Invalid Mongo test URI'); }
  if (parsed.protocol !== 'mongodb:') throw new Error('Atlas/SRV/remote Mongo protocols are not allowed in CI test job');
  if (!['127.0.0.1', 'localhost', 'mongo', 'mongodb'].includes(parsed.hostname)) {
    throw new Error(`Remote Mongo host not allowed for tests: ${parsed.hostname}`);
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!dbName) throw new Error('Mongo test URI must include a database name');
  assertSafeTestDbName(dbName);
}

export function assertSafeTestDbName(dbName: string): void {
  if (!dbName.startsWith(TEST_DB_PREFIX)) throw new Error(`Unsafe test DB name: ${dbName}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) throw new Error('Unsafe test DB name characters');
}

export function uniqueTestDbUri(base = getMongoTestUri()): string {
  const u = new URL(base);
  const name = `${TEST_DB_PREFIX}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  assertSafeTestDbName(name);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function connectTestMongo(uri = getMongoTestUri()) {
  assertSafeMongoTestUri(uri);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const dbName = decodeURIComponent(new URL(uri).pathname.replace(/^\//, '').split('/')[0]);
  assertSafeTestDbName(dbName);
  return { client, db: client.db(dbName), dbName, uri };
}

export async function dropTestDb(client: MongoClient, dbName: string) {
  assertSafeTestDbName(dbName);
  await client.db(dbName).dropDatabase();
}

export async function waitForPort(port: number, host = '127.0.0.1', timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const s = net.createConnection({ host, port }, () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Port ${host}:${port} not ready`);
}

export async function spawnTestServer(opts: { port: number; mongoUri: string; extraEnv?: Record<string, string> }) {
  assertSafeMongoTestUri(opts.mongoUri);
  const cwd = process.cwd();
  const server = spawn(process.execPath, ['dist/server.cjs'], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(opts.port),
      MONGODB_URI: opts.mongoUri,
      COOKIE_SECURE: 'false',
      AUTH_DEV_EXPOSE_TOKENS: 'true',
      NEERDRISHTI_STAGING_IMPORT_MODE: 'false',
      NEERDRISHTI_SEED_REFERENCE_DATA: 'true',
      ...(opts.extraEnv || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let log = '';
  server.stdout.on('data', c => { log += c.toString(); if (log.length > 20000) log = log.slice(-20000); });
  server.stderr.on('data', c => { log += c.toString(); if (log.length > 20000) log = log.slice(-20000); });
  const base = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}\n${log}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { server, base, getLog: () => log };
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  server.kill();
  throw new Error(`Server not ready\n${log}`);
}

export async function stopTestServer(server: ChildProcessWithoutNullStreams | null) {
  if (!server) return;
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && server.exitCode === null) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  server.stdout?.removeAllListeners();
  server.stderr?.removeAllListeners();
}