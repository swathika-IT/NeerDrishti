import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const DB = path.join(os.tmpdir(), `nd-sim-test-${Date.now()}.db`);
const PORT = 3231;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcessWithoutNullStreams | null = null;
let log = '';
let setupToken: string | null = null;
const admin = { cookie: '' };
const anon = { cookie: '' };

async function req(method: string, p: string, jar: { cookie: string }, body?: any, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const sc: string[] = (res.headers as any).getSetCookie?.() ?? [];
  for (const c of sc) { const m = c.match(/nd_session=([^;]*)/); if (m) jar.cookie = `nd_session=${m[1]}`; }
  const text = await res.text();
  let data: any = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text, type: res.headers.get('content-type') || '' };
}

before(async () => {
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_PATH: DB, NEERDRISHTI_BACKUP_DIR: path.join(os.tmpdir(), `nd-sim-bk-${Date.now()}`), COOKIE_SECURE: 'false' };
  execFileSync(process.execPath, ['dist/bootstrap.cjs'], { cwd: ROOT, env, stdio: 'pipe' });   // fresh DB through the production bootstrap path
  server = spawn(process.execPath, ['dist/server.cjs'], { cwd: ROOT, env });
  server.stdout.on('data', (c) => { log += c.toString(); const m = log.match(/setup token \(valid 60 minutes\):[\s\S]*?\n\s+([A-Za-z0-9_-]{20,})/); if (m && !setupToken) setupToken = m[1]; });
  server.stderr.on('data', (c) => { log += c.toString(); });
  const end = Date.now() + 45000;
  while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* retry */ } await new Promise(r => setTimeout(r, 400)); }
  await new Promise(r => setTimeout(r, 500));
  const s = await req('POST', '/api/auth/setup-admin', anon, { token: setupToken, email: 'sim-admin@neerdrishti.test', password: 'AdminPass12345' });
  assert.equal(s.status, 201, `admin setup failed: ${s.text}`);
  const l = await req('POST', '/api/auth/login', admin, { email: 'sim-admin@neerdrishti.test', password: 'AdminPass12345' });
  assert.equal(l.status, 200);
});

after(() => {
  server?.kill();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

test('API never returns HTML: unknown routes and malformed bodies are JSON', async () => {
  const a = await req('GET', '/api/does-not-exist', anon); assert.equal(a.status, 404); assert.ok(a.type.includes('json')); assert.match(a.data.error, /not found/i);
  const b = await req('POST', '/api/auth/register', anon, '{"email":'); assert.ok(b.status >= 400 && b.status < 500); assert.ok(b.type.includes('json'), `got ${b.type}: ${b.text.slice(0, 60)}`);
  const c = await req('POST', '/api/nope', anon, {}); assert.equal(c.status, 404); assert.ok(c.type.includes('json'));
  const home = await req('GET', '/', anon); assert.ok(home.type.includes('html'));   // SPA itself still served
});

test('simulator endpoints require ADMIN', async () => {
  for (const [m, p] of [['POST', '/api/notifications/preview'], ['POST', '/api/notifications/simulate'], ['GET', '/api/notifications/simulations']] as const)
    assert.equal((await req(m, p, anon, m === 'GET' ? undefined : {})).status, 401, p);
});

test('preview keeps actual district risk separate from preview severity and flags overrides; WhatsApp has no SMS segments', async () => {
  const base = { district_id: 'nirmal', language: 'en', channel: 'WHATSAPP' };
  const a = await req('POST', '/api/notifications/preview', admin, base);
  assert.equal(a.status, 200); assert.equal(a.data.severity_override, false); assert.equal(a.data.severity_used, a.data.district.actual_severity);
  assert.equal(a.data.preview.metrics.sms, undefined); assert.doesNotMatch(JSON.stringify(a.data.preview), /segment/i);
  const other = a.data.district.actual_severity === 'CRITICAL' ? 'NORMAL' : 'CRITICAL';
  const b = await req('POST', '/api/notifications/preview', admin, { ...base, severity: other });
  assert.equal(b.data.severity_override, true); assert.equal(b.data.severity_used, other);
  const s = await req('POST', '/api/notifications/preview', admin, { ...base, channel: 'SMS', language: 'te' });
  assert.equal(s.data.preview.metrics.sms.encoding, 'UCS-2');
  assert.equal((await req('POST', '/api/notifications/preview', admin, { ...base, district_id: 'nowhere' })).status, 404);
  assert.equal((await req('POST', '/api/notifications/preview', admin, { ...base, language: 'fr' })).status, 400);
});

test('simulate: needs an idempotency key, is DRY_RUN, masks the contact, and a repeated key replays without a duplicate record', async () => {
  const body = { district_id: 'warangal', language: 'hi', channel: 'SMS', contact: '+919876543210' };
  assert.equal((await req('POST', '/api/notifications/simulate', admin, body)).status, 400);        // no key
  const key = 'test-key-0001-abcdef';
  const r1 = await req('POST', '/api/notifications/simulate', admin, body, { 'Idempotency-Key': key });
  assert.equal(r1.status, 201); assert.equal(r1.data.dry_run, true); assert.equal(r1.data.result, 'SIMULATED'); assert.equal(r1.data.replayed, false);
  assert.equal(r1.data.message, 'Simulation completed. No external message was sent.');
  assert.match(r1.data.simulation_id, /^SIM-/); assert.equal(r1.data.contact_masked, '+91*******210'); assert.ok(!JSON.stringify(r1.data).includes('9876543210'));
  assert.match(r1.data.created_at, /Z$/);
  const r2 = await req('POST', '/api/notifications/simulate', admin, body, { 'Idempotency-Key': key });
  assert.equal(r2.status, 200); assert.equal(r2.data.replayed, true); assert.equal(r2.data.simulation_id, r1.data.simulation_id);
  const rParallel = await Promise.all([1, 2, 3].map(() => req('POST', '/api/notifications/simulate', admin, body, { 'Idempotency-Key': 'test-key-parallel-xyz' })));
  assert.equal(new Set(rParallel.map(r => r.data.simulation_id)).size, 1, 'parallel duplicate submissions must collapse to one simulation');
  const hist = await req('GET', '/api/notifications/simulations?limit=50', admin);
  assert.equal(hist.data.simulations.length, 2);                                               // key-0001 + parallel, exactly once each
  assert.ok(hist.data.simulations.every((x: any) => x.status === 'DRY_RUN'));
});

test('simulate rejects invalid contacts and keys', async () => {
  const ok = { district_id: 'warangal', language: 'en', channel: 'WHATSAPP' };
  assert.equal((await req('POST', '/api/notifications/simulate', admin, { ...ok, contact: '98765' }, { 'Idempotency-Key': 'bad-contact-key-1' })).status, 400);
  assert.equal((await req('POST', '/api/notifications/simulate', admin, ok, { 'Idempotency-Key': 'short' })).status, 400);
});

test('new pipeline endpoints answer with JSON and honest empty states on a fresh database', async () => {
  const cfg = await req('GET', '/api/map/config', anon); assert.equal(cfg.data.provider, 'none'); assert.equal(cfg.data.url, null);
  const geo = await req('GET', '/api/geo/districts', anon);
  assert.equal(geo.status, 200); assert.ok(geo.type.includes('json')); assert.equal(geo.data.available, false); assert.deepEqual(geo.data.features, []);
  const reg = await req('GET', '/api/pipeline/registry', anon); assert.equal(reg.status, 200); assert.equal(reg.data.available, true);
  assert.equal((await req('GET', '/api/telemetry/river', anon)).data.stations.length, 0);
  assert.equal((await req('GET', '/api/weather/forecast/nirmal', anon)).data.available, false);
  assert.equal((await req('GET', '/api/weather/history/nirmal', anon)).data.daily.length, 0);
  const m = await req('GET', '/api/risk/model', anon); assert.equal(m.status, 200);
});
