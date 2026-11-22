import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { getMongoTestUri, assertSafeMongoTestUri, spawnTestServer, stopTestServer, connectTestMongo, dropTestDb } from './helpers/mongo_integration_harness';

const MONGO_URI = getMongoTestUri();
assertSafeMongoTestUri(MONGO_URI);
let PORT = 3220;
let BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcessWithoutNullStreams | null = null;
let setupToken: string | null = null;
let mongoCtx: any;

interface Jar { cookie: string }
const adminJar: Jar = { cookie: '' };
const citizenJar: Jar = { cookie: '' };
const officialJar: Jar = { cookie: '' };
const anonJar: Jar = { cookie: '' };
const rateJar: Jar = { cookie: '' };

function captureCookie(res: Response, jar: Jar) {
  const setCookies: string[] = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [res.headers.get('set-cookie') || ''].filter(Boolean);
  for (const sc of setCookies) {
    const m = sc.match(/nd_session=([^;]*)/);
    if (m) jar.cookie = `nd_session=${m[1]}`;
  }
}
async function req(method: string, urlPath: string, jar: Jar, body?: any) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  captureCookie(res, jar);
  let data: any = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const validReport = (overrides: Record<string, any> = {}) => ({
  district: 'Hyderabad', location_description: 'Test locality near Musi', incident_type: 'Urban Flooding', severity: 'High',
  description: 'Water is rising quickly on the main street and blocking vehicles near the underpass.', ...overrides,
});

before(async () => {
  mongoCtx = await connectTestMongo(MONGO_URI);
  await mongoCtx.db.dropDatabase();
  const started = await spawnTestServer({ port: PORT, mongoUri: MONGO_URI, extraEnv: { CLASSIFIER_FORCE_RULE_BASED: 'true', REPORT_RATE_LIMIT_MAX: '50', REPORT_RATE_LIMIT_USER_MAX: '20' } });
  server = started.server; BASE = started.base;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const m = started.getLog().match(/setup token \(valid 60 minutes\):[\s\S]*?\n\s+([A-Za-z0-9_-]{20,})/);
    if (m) { setupToken = m[1]; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(setupToken, 'setup token required');
  await req('POST', '/api/auth/setup-admin', anonJar, { token: setupToken, email: 'admin@nd.test', password: 'AdminPass12345' });
  await req('POST', '/api/auth/login', adminJar, { email: 'admin@nd.test', password: 'AdminPass12345' });
  await req('POST', '/api/auth/register', citizenJar, { email: 'reporter@nd.test', password: 'CitizenPass123', full_name: 'Reporter One' });
  await req('POST', '/api/auth/login', citizenJar, { email: 'reporter@nd.test', password: 'CitizenPass123' });
  const offJar: Jar = { cookie: '' };
  await req('POST', '/api/auth/register', offJar, { email: 'official@nd.test', password: 'OfficialPass123', full_name: 'Official One' });
  await req('POST', '/api/auth/login', offJar, { email: 'official@nd.test', password: 'OfficialPass123' });
  await req('POST', '/api/auth/role-request', offJar, { reason: 'Engineer', department: 'GHMC' });
  const pending = await req('GET', '/api/admin/role-requests?status=PENDING', adminJar);
  const target = pending.data.role_requests.find((r: any) => r.email === 'official@nd.test');
  await req('POST', `/api/admin/role-requests/${target.id}/approve`, adminJar, { jurisdictions: ['hyderabad'] });
  await req('POST', '/api/auth/login', officialJar, { email: 'official@nd.test', password: 'OfficialPass123' });
  await req('POST', '/api/auth/register', rateJar, { email: 'ratereporter@nd.test', password: 'RatePass12345', full_name: 'Rate Reporter' });
  await req('POST', '/api/auth/login', rateJar, { email: 'ratereporter@nd.test', password: 'RatePass12345' });
});

after(async () => {
  await stopTestServer(server);
  if (mongoCtx) { await dropTestDb(mongoCtx.client, mongoCtx.dbName); await mongoCtx.client.close(); }
});

test('anonymous submission remains supported, stored as PENDING with no reporter link', async () => {
  const res = await req('POST', '/api/reports', anonJar, validReport());
  assert.equal(res.status, 201);
  assert.equal(res.data.report.status, 'PENDING');
  assert.equal(res.data.report.reporter_user_id, null);
  assert.equal(res.data.report.district_id, 'hyderabad');
});

test('authenticated citizen submission links reporter_user_id from session', async () => {
  const res = await req('POST', '/api/reports', citizenJar, validReport({ district: 'warangal' }));
  assert.equal(res.status, 201);
  assert.ok(res.data.report.reporter_user_id);
  const mine = await req('GET', '/api/citizen/reports', citizenJar);
  assert.equal(mine.status, 200);
  assert.ok(mine.data.count >= 1);
});

test('forged privileged fields are rejected', async () => {
  for (const body of [validReport({ reporter_user_id: 999 }), validReport({ status: 'VERIFIED' }), validReport({ id: 1 }), validReport({ approved: true })]) {
    const r = await req('POST', '/api/reports', anonJar, body);
    assert.equal(r.status, 400);
  }
});

test('invalid districts, categories, severities, coordinates and timestamps are rejected', async () => {
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ district: 'Atlantis' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ incident_type: 'Alien Invasion' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ severity: 'Apocalyptic' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ description: 'too short' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ lat: 0, lng: 0 }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ lat: 17.4 }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ reported_at: '2999-01-01T00:00:00Z' }))).status, 400);
});

test('attachment validation blocks SVG/javascript/invalid types; accepts small PNG', async () => {
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: svg }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: 'javascript:alert(1)' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: 'data:text/html;base64,PHNjcmlwdD4=' }))).status, 400);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: png }))).status, 201);
});

test('unauthorized moderation is rejected', async () => {
  assert.equal((await req('PATCH', '/api/reports/1/status', anonJar, { status: 'VERIFIED' })).status, 401);
  assert.equal((await req('PATCH', '/api/reports/1/status', citizenJar, { status: 'VERIFIED' })).status, 403);
  assert.equal((await req('GET', '/api/reports/1/history', citizenJar)).status, 403);
});

test('official jurisdiction boundaries are enforced for moderation and history', async () => {
  const hyd = await req('POST', '/api/reports', anonJar, validReport({ district: 'Hyderabad' }));
  const war = await req('POST', '/api/reports', anonJar, validReport({ district: 'Warangal' }));
  assert.equal((await req('PATCH', `/api/reports/${war.data.report.id}/status`, officialJar, { status: 'VERIFIED' })).status, 403);
  assert.equal((await req('GET', `/api/reports/${war.data.report.id}/history`, officialJar)).status, 403);
  const ok = await req('PATCH', `/api/reports/${hyd.data.report.id}/status`, officialJar, { status: 'VERIFIED', reason: 'Field verified by ward officer' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.report.status, 'VERIFIED');
  const history = await req('GET', `/api/reports/${hyd.data.report.id}/history`, officialJar);
  assert.equal(history.status, 200);
  assert.ok(history.data.history.length >= 1);
  const last = history.data.history[history.data.history.length - 1];
  assert.equal(last.to_status, 'VERIFIED');
  assert.equal(last.actor_role, 'OFFICIAL');
});

test('admin moderation is recorded with actor and history', async () => {
  const war = await req('POST', '/api/reports', anonJar, validReport({ district: 'Warangal' }));
  const res = await req('PATCH', `/api/reports/${war.data.report.id}/status`, adminJar, { status: 'VERIFIED', reason: 'Admin confirmed' });
  assert.equal(res.status, 200);
  const history = await req('GET', `/api/reports/${war.data.report.id}/history`, adminJar);
  assert.equal(history.status, 200);
  assert.ok(history.data.history.some((h: any) => h.actor_role === 'ADMIN' && h.to_status === 'VERIFIED'));
});