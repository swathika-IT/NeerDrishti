import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { getMongoTestUri, assertSafeMongoTestUri, spawnTestServer, stopTestServer, connectTestMongo, dropTestDb } from './helpers/mongo_integration_harness';

const MONGO_URI = getMongoTestUri();
assertSafeMongoTestUri(MONGO_URI);
let PORT = 3210;
let BASE = `http://127.0.0.1:${PORT}`;
let mongoCtx: any;

let server: ChildProcessWithoutNullStreams | null = null;
let serverLog = '';
let setupToken: string | null = null;

interface Jar {
  cookie: string;
}
const anonJar: Jar = { cookie: '' };
const adminJar: Jar = { cookie: '' };
const citizenJar: Jar = { cookie: '' };
const citizen2Jar: Jar = { cookie: '' };
const officialJar: Jar = { cookie: '' };

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
  const setCookies = captureCookie(res, jar);
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, setCookies };
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server did not become ready in time');
}

before(async () => {
  mongoCtx = await connectTestMongo(MONGO_URI);
  await mongoCtx.db.dropDatabase();
  const started = await spawnTestServer({ port: PORT, mongoUri: MONGO_URI, extraEnv: { AUTH_DEV_EXPOSE_TOKENS: 'true' } });
  server = started.server; BASE = started.base;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const m = started.getLog().match(/setup token \(valid 60 minutes\):[\s\S]*?\n\s+([A-Za-z0-9_-]{20,})/);
    if (m) { setupToken = m[1]; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  const now = new Date();
  await mongoCtx.db.collection('citizen_reports').insertMany([
    { _id: 1, id: 1, district_id: 'hyderabad', location_description: 'Musi River bank', incident_type: 'Urban Flooding', severity: 'High', description: 'Fixture report for jurisdiction test in Hyderabad district.', image_reference: null, lat: 17.385, lng: 78.4867, status: 'PENDING', reporter_user_id: null, reported_at: now, created_at: now, updated_at: now, confidence_score: 0.5, is_spam: 0 },
    { _id: 3, id: 3, district_id: 'warangal', location_description: 'Warangal low-lying area', incident_type: 'Urban Flooding', severity: 'High', description: 'Fixture report for jurisdiction test in Warangal district.', image_reference: null, lat: 17.969, lng: 79.594, status: 'PENDING', reporter_user_id: null, reported_at: now, created_at: now, updated_at: now, confidence_score: 0.5, is_spam: 0 },
  ]);
  await mongoCtx.db.collection('sequences').updateOne(
    { name: 'citizen_reports' },
    { $max: { value: 3 } },
    { upsert: true }
  );
});

after(async () => {
  await stopTestServer(server);
  if (mongoCtx) { await dropTestDb(mongoCtx.client, mongoCtx.dbName); await mongoCtx.client.close(); }
});

test('unauthenticated access to protected endpoints is rejected', async () => {
  assert.equal((await req('GET', '/api/admin/users', anonJar)).status, 401);
  assert.equal((await req('POST', '/api/simulation/set-scenario', anonJar, { scenario: 'Heavy Rainfall' })).status, 401);
  assert.equal((await req('POST', '/api/signals/ingest', anonJar, { district: 'Hyderabad', rainfall_mm: 10 })).status, 401);
  assert.equal((await req('POST', '/api/data/mode', anonJar, { mode: 'LIVE' })).status, 401);
  assert.equal((await req('PATCH', '/api/reports/1/status', anonJar, { status: 'VERIFIED' })).status, 401);
  assert.equal((await req('POST', '/api/notifications/dispatch', anonJar, {})).status, 401);
});

test('public read endpoints remain accessible without login', async () => {
  assert.equal((await req('GET', '/api/health', anonJar)).status, 200);
  const districts = await req('GET', '/api/districts', anonJar);
  assert.equal(districts.status, 200);
  assert.equal(districts.data.total_count, 33);
  assert.equal((await req('GET', '/api/reports', anonJar)).status, 200);
});

test('first-admin setup requires the one-time console token and is single-use', async () => {
  assert.ok(setupToken, 'setup token should be printed to the server console');
  const bad = await req('POST', '/api/auth/setup-admin', anonJar, { token: 'wrong-token', email: 'bad@example.com', password: 'BadPass123456' });
  assert.equal(bad.status, 403);

  const good = await req('POST', '/api/auth/setup-admin', anonJar, {
    token: setupToken,
    email: 'admin@neerdrishti.test',
    password: 'AdminPass12345',
  });
  assert.equal(good.status, 201);
  assert.equal(good.data.user.role, 'ADMIN');

  const reuse = await req('POST', '/api/auth/setup-admin', anonJar, {
    token: setupToken,
    email: 'admin2@neerdrishti.test',
    password: 'AdminPass12345',
  });
  assert.equal(reuse.status, 403);
});

test('admin login sets a hardened session cookie and grants admin access', async () => {
  const login = await req('POST', '/api/auth/login', adminJar, { email: 'admin@neerdrishti.test', password: 'AdminPass12345' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'ADMIN');
  const raw = login.setCookies.join('; ');
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /nd_session=/);

  const me = await req('GET', '/api/auth/me', adminJar);
  assert.equal(me.data.user.role, 'ADMIN');
  assert.equal((await req('GET', '/api/admin/users', adminJar)).status, 200);
  assert.equal((await req('GET', '/api/admin/overview', adminJar)).status, 200);
});

test('citizen registration, login, wrong-password rejection and email verification', async () => {
  const reg = await req('POST', '/api/auth/register', citizenJar, {
    email: 'citizen1@neerdrishti.test',
    password: 'CitizenPass123',
    full_name: 'Test Citizen',
  });
  assert.equal(reg.status, 201);
  assert.ok(reg.data.dev_verification_token, 'dev verification token expected when AUTH_DEV_EXPOSE_TOKENS=true');

  const wrong = await req('POST', '/api/auth/login', anonJar, { email: 'citizen1@neerdrishti.test', password: 'WrongPassword123' });
  assert.equal(wrong.status, 401);

  const login = await req('POST', '/api/auth/login', citizenJar, { email: 'citizen1@neerdrishti.test', password: 'CitizenPass123' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'CITIZEN');

  const verify = await req('POST', '/api/auth/verify-email', anonJar, { token: reg.data.dev_verification_token });
  assert.equal(verify.status, 200);
  const me = await req('GET', '/api/auth/me', citizenJar);
  assert.equal(me.data.user.email_verified, true);
});

test('citizens cannot access admin or official endpoints', async () => {
  assert.equal((await req('GET', '/api/admin/users', citizenJar)).status, 403);
  assert.equal((await req('GET', '/api/admin/audit-logs', citizenJar)).status, 403);
  assert.equal((await req('GET', '/api/official/me', citizenJar)).status, 403);
  assert.equal((await req('PATCH', '/api/reports/1/status', citizenJar, { status: 'VERIFIED' })).status, 403);
});

test('citizen data isolation: /api/citizen/reports only returns own reports', async () => {
  const mine = await req('GET', '/api/citizen/reports', citizenJar);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.count, 0, 'new citizen has no linked reports');

  const other = await req('POST', '/api/auth/register', citizen2Jar, {
    email: 'citizen2@neerdrishti.test',
    password: 'CitizenPass456',
    full_name: 'Second Citizen',
  });
  assert.equal(other.status, 201);
  const login2 = await req('POST', '/api/auth/login', citizen2Jar, { email: 'citizen2@neerdrishti.test', password: 'CitizenPass456' });
  assert.equal(login2.status, 200);
  const otherReports = await req('GET', '/api/citizen/reports', citizen2Jar);
  assert.equal(otherReports.data.count, 0);
});

test('official approval workflow and jurisdiction enforcement', async () => {
  // citizen2 requests official access
  const request = await req('POST', '/api/auth/role-request', citizen2Jar, { reason: 'Municipal engineer', department: 'GHMC' });
  assert.equal(request.status, 201);

  const pending = await req('GET', '/api/admin/role-requests?status=PENDING', adminJar);
  const target = pending.data.role_requests.find((r: any) => r.email === 'citizen2@neerdrishti.test');
  assert.ok(target, 'pending role request should be visible to admin');

  // reject with invalid jurisdiction proves validation
  const badApprove = await req('POST', `/api/admin/role-requests/${target.id}/approve`, adminJar, { jurisdictions: ['not_a_district'] });
  assert.equal(badApprove.status, 400);

  // approve scoped to Hyderabad only
  const approve = await req('POST', `/api/admin/role-requests/${target.id}/approve`, adminJar, { jurisdictions: ['hyderabad'] });
  assert.equal(approve.status, 200);

  const login = await req('POST', '/api/auth/login', officialJar, { email: 'citizen2@neerdrishti.test', password: 'CitizenPass456' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'OFFICIAL');

  const me = await req('GET', '/api/official/me', officialJar);
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.jurisdictions, ['hyderabad']);

  // in-jurisdiction report (id 1 = hyderabad) can be updated
  const okUpdate = await req('PATCH', '/api/reports/1/status', officialJar, { status: 'UNDER_REVIEW' });
  assert.equal(okUpdate.status, 200);

  // out-of-jurisdiction report (id 3 = warangal) is rejected
  const deniedUpdate = await req('PATCH', '/api/reports/3/status', officialJar, { status: 'UNDER_REVIEW' });
  assert.equal(deniedUpdate.status, 403);

  const deniedRead = await req('GET', '/api/official/reports?district=warangal', officialJar);
  assert.equal(deniedRead.status, 403);

  const scopedRead = await req('GET', '/api/official/reports', officialJar);
  assert.equal(scopedRead.status, 200);
  assert.ok(scopedRead.data.reports.every((r: any) => r.district_id === 'hyderabad'));
});

test('unapproved official (pending) is blocked from official endpoints', async () => {
  const jar: Jar = { cookie: '' };
  const reg = await req('POST', '/api/auth/register', jar, { email: 'pending@neerdrishti.test', password: 'CitizenPass789', full_name: 'Pending Official' });
  assert.equal(reg.status, 201);
  const login = await req('POST', '/api/auth/login', jar, { email: 'pending@neerdrishti.test', password: 'CitizenPass789' });
  assert.equal(login.status, 200);
  assert.equal((await req('GET', '/api/official/me', jar)).status, 403);
  assert.equal((await req('PATCH', '/api/reports/1/status', jar, { status: 'VERIFIED' })).status, 403);
});

test('logout invalidates the session', async () => {
  const jar: Jar = { cookie: '' };
  assert.equal((await req('POST', '/api/auth/login', jar, { email: 'citizen1@neerdrishti.test', password: 'CitizenPass123' })).status, 200);
  assert.equal((await req('GET', '/api/auth/me', jar)).data.user.role, 'CITIZEN');
  assert.equal((await req('POST', '/api/auth/logout', jar)).status, 200);
  assert.equal((await req('GET', '/api/auth/me', jar)).data.user, null);
  assert.equal((await req('GET', '/api/citizen/reports', jar)).status, 401);
});

test('account recovery flow issues a token and resets the password', async () => {
  const forgot = await req('POST', '/api/auth/forgot-password', anonJar, { email: 'citizen1@neerdrishti.test' });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.data.dev_reset_token, 'dev reset token expected when AUTH_DEV_EXPOSE_TOKENS=true');

  const unknown = await req('POST', '/api/auth/forgot-password', anonJar, { email: 'nobody@neerdrishti.test' });
  assert.equal(unknown.status, 200, 'account existence must not be revealed');
  assert.equal(unknown.data.dev_reset_token, undefined);

  const reset = await req('POST', '/api/auth/reset-password', anonJar, { token: forgot.data.dev_reset_token, new_password: 'CitizenNewPass123' });
  assert.equal(reset.status, 200);

  const oldLogin = await req('POST', '/api/auth/login', anonJar, { email: 'citizen1@neerdrishti.test', password: 'CitizenPass123' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await req('POST', '/api/auth/login', anonJar, { email: 'citizen1@neerdrishti.test', password: 'CitizenNewPass123' });
  assert.equal(newLogin.status, 200);
});

test('login rate limiting returns 429 after repeated attempts', async () => {
  let sawLimited = false;
  for (let i = 0; i < 15; i++) {
    const res = await req('POST', '/api/auth/login', anonJar, { email: 'ratelimit@neerdrishti.test', password: 'WrongPass12345' });
    if (res.status === 429) { sawLimited = true; break; }
  }
  assert.equal(sawLimited, true, 'expected HTTP 429 after repeated login attempts');
});

test('admin cannot suspend their own account', async () => {
  const me = await req('GET', '/api/auth/me', adminJar);
  const adminId = me.data.user.id;
  const res = await req('POST', `/api/admin/users/${adminId}/status`, adminJar, { status: 'SUSPENDED' });
  assert.equal(res.status, 400);
});

test('notification history and stats require admin authorization', async () => {
  for (const path of ['/api/notifications', '/api/notifications/stats']) {
    const trulyAnonymous: Jar = { cookie: '' };
    const anon = await req('GET', path, trulyAnonymous);
    assert.equal(anon.status, 401, `${path} must reject anonymous requests`);

    const citizen = await req('GET', path, citizen2Jar);
    assert.equal(citizen.status, 403, `${path} must reject non-admin requests`);

    const admin = await req('GET', path, adminJar);
    assert.equal(admin.status, 200, `${path} must allow admin requests`);
    assert.ok(admin.data);
  }

  assert.ok(Array.isArray((await req('GET', '/api/notifications', adminJar)).data.notifications));
  assert.equal(typeof (await req('GET', '/api/notifications/stats', adminJar)).data.totalDispatched, 'number');
});
