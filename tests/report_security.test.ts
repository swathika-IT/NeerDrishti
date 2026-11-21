import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = process.cwd();
const SOURCE_DB = path.join(PROJECT_ROOT, 'data', 'neerdrishti.db');
const TEST_DB = path.join(os.tmpdir(), `neerdrishti-report-test-${Date.now()}.db`);
const PORT = 3220;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessWithoutNullStreams | null = null;
let serverLog = '';
let setupToken: string | null = null;

interface Jar { cookie: string }
const adminJar: Jar = { cookie: '' };
const citizenJar: Jar = { cookie: '' };
const officialJar: Jar = { cookie: '' };
const anonJar: Jar = { cookie: '' };
const rateJar: Jar = { cookie: '' };

function captureCookie(res: Response, jar: Jar): string[] {
  const setCookies: string[] = typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie') || ''].filter(Boolean);
  for (const sc of setCookies) {
    const m = sc.match(/nd_session=([^;]*)/);
    if (m) jar.cookie = `nd_session=${m[1]}`;
  }
  return setCookies;
}

async function req(method: string, urlPath: string, jar: Jar, body?: any) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  captureCookie(res, jar);
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Server not ready');
}

const validReport = (overrides: Record<string, any> = {}) => ({
  district: 'Hyderabad',
  location_description: 'Test locality near Musi',
  incident_type: 'Urban Flooding',
  severity: 'High',
  description: 'Water is rising quickly on the main street and blocking vehicles near the underpass.',
  ...overrides,
});

before(async () => {
  fs.copyFileSync(SOURCE_DB, TEST_DB);
  server = spawn(process.execPath, ['dist/server.cjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DATABASE_PATH: TEST_DB,
      COOKIE_SECURE: 'false',
      AUTH_DEV_EXPOSE_TOKENS: 'true',
      CLASSIFIER_FORCE_RULE_BASED: 'true',
      REPORT_RATE_LIMIT_MAX: '50',
      REPORT_RATE_LIMIT_USER_MAX: '20',
    },
  });
  server.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
    if (!setupToken) {
      const m = serverLog.match(/setup token \(valid 60 minutes\):[\s\S]*?\n\s+([A-Za-z0-9_-]{20,})/);
      if (m) setupToken = m[1];
    }
  });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  await waitForServer();

  // Bootstrap admin
  await req('POST', '/api/auth/setup-admin', anonJar, { token: setupToken, email: 'admin@nd.test', password: 'AdminPass12345' });
  await req('POST', '/api/auth/login', adminJar, { email: 'admin@nd.test', password: 'AdminPass12345' });

  // Citizen
  await req('POST', '/api/auth/register', citizenJar, { email: 'reporter@nd.test', password: 'CitizenPass123', full_name: 'Reporter One' });
  await req('POST', '/api/auth/login', citizenJar, { email: 'reporter@nd.test', password: 'CitizenPass123' });

  // Official scoped to Hyderabad
  const offJar: Jar = { cookie: '' };
  await req('POST', '/api/auth/register', offJar, { email: 'official@nd.test', password: 'OfficialPass123', full_name: 'Official One' });
  await req('POST', '/api/auth/login', offJar, { email: 'official@nd.test', password: 'OfficialPass123' });
  await req('POST', '/api/auth/role-request', offJar, { reason: 'Engineer', department: 'GHMC' });
  const pending = await req('GET', '/api/admin/role-requests?status=PENDING', adminJar);
  const target = pending.data.role_requests.find((r: any) => r.email === 'official@nd.test');
  await req('POST', `/api/admin/role-requests/${target.id}/approve`, adminJar, { jurisdictions: ['hyderabad'] });
  await req('POST', '/api/auth/login', officialJar, { email: 'official@nd.test', password: 'OfficialPass123' });

  // Dedicated citizen for rate-limit test
  await req('POST', '/api/auth/register', rateJar, { email: 'ratereporter@nd.test', password: 'RatePass12345', full_name: 'Rate Reporter' });
  await req('POST', '/api/auth/login', rateJar, { email: 'ratereporter@nd.test', password: 'RatePass12345' });
});

after(() => {
  if (server) server.kill();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

test('anonymous submission remains supported, stored as PENDING with no reporter link', async () => {
  const res = await req('POST', '/api/reports', anonJar, validReport());
  assert.equal(res.status, 201);
  assert.equal(res.data.report.status, 'PENDING');
  assert.equal(res.data.report.reporter_user_id, null);
  assert.equal(res.data.report.district_id, 'hyderabad');
});

test('authenticated citizen submission links reporter_user_id from the session', async () => {
  const res = await req('POST', '/api/reports', citizenJar, validReport({ district: 'warangal' }));
  assert.equal(res.status, 201);
  assert.ok(res.data.report.reporter_user_id, 'reporter_user_id must be set from the session');
  const mine = await req('GET', '/api/citizen/reports', citizenJar);
  assert.equal(mine.data.count, 1);
});

test('forged privileged fields are rejected', async () => {
  const withReporter = await req('POST', '/api/reports', anonJar, validReport({ reporter_user_id: 999 }));
  assert.equal(withReporter.status, 400);
  const withStatus = await req('POST', '/api/reports', anonJar, validReport({ status: 'VERIFIED' }));
  assert.equal(withStatus.status, 400);
  const withId = await req('POST', '/api/reports', anonJar, validReport({ id: 1 }));
  assert.equal(withId.status, 400);
  const withApproved = await req('POST', '/api/reports', anonJar, validReport({ approved: true }));
  assert.equal(withApproved.status, 400);
});

test('invalid districts, categories, severities, coordinates and timestamps are rejected', async () => {
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ district: 'Atlantis' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ incident_type: 'Alien Invasion' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ severity: 'Apocalyptic' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ description: 'too short' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ lat: 0, lng: 0 }))).status, 400, 'outside Telangana bounds');
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ lat: 17.4 }))).status, 400, 'lat without lng');
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ lat: 'abc', lng: 'def' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ reported_at: '2999-01-01T00:00:00Z' }))).status, 400, 'future timestamp');
});

test('attachment validation blocks SVG, javascript and invalid types; accepts small PNG', async () => {
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: svg }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: 'javascript:alert(1)' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: 'data:text/html;base64,PHNjcmlwdD4=' }))).status, 400);
  assert.equal((await req('POST', '/api/reports', anonJar, validReport({ image_reference: '/etc/passwd' }))).status, 400);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ok = await req('POST', '/api/reports', anonJar, validReport({ image_reference: png }));
  assert.equal(ok.status, 201);
});

test('unauthorized moderation is rejected', async () => {
  assert.equal((await req('PATCH', '/api/reports/1/status', anonJar, { status: 'VERIFIED' })).status, 401);
  assert.equal((await req('PATCH', '/api/reports/1/status', citizenJar, { status: 'VERIFIED' })).status, 403);
  assert.equal((await req('GET', '/api/reports/1/history', citizenJar)).status, 403);
});

test('official jurisdiction boundaries are enforced for moderation and history', async () => {
  // report 1 (hyderabad) is in jurisdiction; report 3 (warangal) is not
  assert.equal((await req('PATCH', '/api/reports/3/status', officialJar, { status: 'VERIFIED' })).status, 403);
  assert.equal((await req('GET', '/api/reports/3/history', officialJar)).status, 403);

  const ok = await req('PATCH', '/api/reports/1/status', officialJar, { status: 'VERIFIED', reason: 'Field verified by ward officer' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.report.status, 'VERIFIED');

  const history = await req('GET', '/api/reports/1/history', officialJar);
  assert.equal(history.status, 200);
  assert.ok(history.data.history.length >= 1);
  const last = history.data.history[history.data.history.length - 1];
  assert.equal(last.to_status, 'VERIFIED');
  assert.equal(last.actor_role, 'OFFICIAL');
  assert.match(String(last.reason), /Field verified/);
});

test('official cannot make an invalid lifecycle transition', async () => {
  // report 1 is now VERIFIED; VERIFIED -> PENDING is not allowed for officials
  const res = await req('PATCH', '/api/reports/1/status', officialJar, { status: 'PENDING' });
  assert.equal(res.status, 400);
});

test('admin moderation is recorded with actor, timestamps and history', async () => {
  const res = await req('PATCH', '/api/reports/3/status', adminJar, { status: 'VERIFIED', reason: 'Admin confirmed via district control room' });
  assert.equal(res.status, 200);
  assert.equal(res.data.report.status, 'VERIFIED');

  const history = await req('GET', '/api/reports/3/history', adminJar);
  assert.equal(history.status, 200);
  const adminEntry = history.data.history.find((h: any) => h.actor_role === 'ADMIN');
  assert.ok(adminEntry, 'admin action must appear in moderation history');
  assert.equal(adminEntry.to_status, 'VERIFIED');
  assert.ok(adminEntry.created_at);
});

test('unverified reports do not influence risk aggregation; rejected reports are excluded', async () => {
  // Baseline: report 1 (hyderabad) was PENDING then VERIFIED by official above; report 4 verified elsewhere.
  const before = await req('GET', '/api/reports/district/hyderabad/summary', anonJar);
  assert.equal(before.status, 200);
  const beforeScore = before.data.citizen_report_score;
  assert.equal(before.data.scoring_basis, 'VERIFIED_ONLY');
  assert.ok(beforeScore > 0, 'verified reports should contribute');

  // Reject the verified Hyderabad reports as admin (report 1 was verified by the official; report 2 is a seed VERIFIED report)
  const rejected1 = await req('PATCH', '/api/reports/1/status', adminJar, { status: 'REJECTED', reason: 'Duplicate report' });
  assert.equal(rejected1.status, 200);
  const rejected2 = await req('PATCH', '/api/reports/2/status', adminJar, { status: 'REJECTED', reason: 'Duplicate report' });
  assert.equal(rejected2.status, 200);

  const after = await req('GET', '/api/reports/district/hyderabad/summary', anonJar);
  assert.equal(after.data.citizen_report_score, 0, 'rejected reports must not contribute to risk');
  assert.equal(after.data.verified_reports, 0);

  // Public aggregate district payload still shows reports but citizen contribution dropped
  const districts = await req('GET', '/api/districts', anonJar);
  assert.equal(districts.status, 200);
  const hyd = districts.data.districts.find((d: any) => d.district_id === 'hyderabad');
  assert.ok(hyd, 'hyderabad district still present');
  assert.equal(hyd.citizen_report_score, 0);
});

test('authenticated submission rate limiting returns 429', async () => {
  let sawLimited = false;
  for (let i = 0; i < 30; i++) {
    const res = await req('POST', '/api/reports', rateJar, validReport());
    if (res.status === 429) { sawLimited = true; break; }
  }
  assert.equal(sawLimited, true, 'expected 429 once per-account report limit is exceeded');
});

test('existing report data is preserved (no deletions)', async () => {
  const all = await req('GET', '/api/reports', anonJar);
  assert.equal(all.status, 200);
  const ids = all.data.reports.map((r: any) => r.id);
  for (const id of [1, 2, 3, 4, 5]) {
    assert.ok(ids.includes(id), `seed report #${id} must still exist`);
  }
  assert.ok(all.data.total >= 5);
});
