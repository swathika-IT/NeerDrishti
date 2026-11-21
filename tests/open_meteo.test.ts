import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = process.cwd();
const SOURCE_DB = path.join(PROJECT_ROOT, 'data', 'neerdrishti.db');
const TEST_DB = path.join(os.tmpdir(), `neerdrishti-om-test-${Date.now()}.db`);

const mk = (id: string, name: string, lat: number, lng: number, zone: string) => ({
  district_id: id,
  district_name: name,
  latitude: lat,
  longitude: lng,
  monitoring_category: 'Standard Monitoring',
  data_source_mode: 'Simulated Data',
  data_confidence: 'Medium',
  terrain_type: 'Deccan',
  river_basin: 'Basin',
  historical_flood_context: 'ctx',
  major_past_events: 'events',
  vulnerable_hotspots: 'hotspots',
  primary_nala_network: 'nala',
  encroachment_level: 'Low',
  terrain_vulnerability: 50,
  category_basis: '',
  data_provenance: '',
  last_verified: '',
  region_zone: zone,
  simulation_zone: zone,
  prototype_vulnerability_score: 50,
  data_limitation_notes: '',
});

const SET_A = [mk('hyderabad', 'Hyderabad', 17.385, 78.4867, 'Central Telangana'),
               mk('warangal', 'Warangal', 17.969, 79.594, 'Central Telangana'),
               mk('nirmal', 'Nirmal', 19.096, 78.343, 'North Telangana')] as any;
const SET_B = [mk('khammam', 'Khammam', 17.247, 80.151, 'Central Telangana'),
               mk('karimnagar', 'Karimnagar', 18.439, 79.129, 'Central Telangana'),
               mk('nizamabad', 'Nizamabad', 18.672, 78.094, 'North Telangana')] as any;
const SET_C = [mk('adilabad', 'Adilabad', 19.665, 78.532, 'North Telangana'),
               mk('jangaon', 'Jangaon', 17.723, 79.149, 'Central Telangana'),
               mk('suryapet', 'Suryapet', 17.140, 79.620, 'Central Telangana')] as any;
const SET_D = [mk('narayanpet', 'Narayanpet', 16.729, 77.495, 'South Telangana'),
               mk('wanaparthy', 'Wanaparthy', 16.367, 78.064, 'South Telangana'),
               mk('vikarabad', 'Vikarabad', 17.332, 77.901, 'South Telangana')] as any;
const SET_E = [mk('yadadri_bhuvanagiri', 'Yadadri Bhuvanagiri', 17.724, 78.973, 'Central Telangana'),
               mk('siddipet', 'Siddipet', 18.101, 78.852, 'North Telangana'),
               mk('kamareddy', 'Kamareddy', 18.318, 78.337, 'North Telangana')] as any;
const SET_F = [mk('mahabubnagar', 'Mahabubnagar', 16.747, 77.980, 'South Telangana'),
               mk('jogulamba_gadwal', 'Jogulamba Gadwal', 16.236, 77.802, 'South Telangana'),
               mk('peddapalli', 'Peddapalli', 18.615, 79.383, 'Godavari Influence Region')] as any;

const hourlyPayload = (baseRain: number) => ({
  latitude: 17.0,
  longitude: 79.0,
  generationtime_ms: 0.1,
  utc_offset_seconds: 19800,
  timezone: 'Asia/Kolkata',
  timezone_abbreviation: 'IST',
  elevation: 505,
  hourly_units: { time: 'iso8601', precipitation: 'mm' },
  hourly: {
    time: Array.from({ length: 24 }, (_, i) => `2026-11-04T${String(i).padStart(2, '0')}:00`),
    precipitation: Array.from({ length: 24 }, (_, i) => (i >= 21 ? baseRain : 0.1)),
  },
});

interface MockResponse { status: number; body: any }

let fetchCalls: string[] = [];
let mockHandler: (url: string) => MockResponse = () => ({ status: 200, body: hourlyPayload(4) });
let fetchBehavior: 'respond' | 'throw' | 'hang' = 'respond';

const originalFetch = globalThis.fetch;

function installMockFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    fetchCalls.push(url);
    if (fetchBehavior === 'hang') {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }
      }) as any;
    }
    if (fetchBehavior === 'throw') throw new Error('network down');
    const { status, body } = mockHandler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as any;
}

let openMeteoService: any;
let DATA_SOURCES: any;

before(async () => {
  fs.copyFileSync(SOURCE_DB, TEST_DB);
  process.env.DATABASE_PATH = TEST_DB;
  process.env.OPEN_METEO_CACHE_TTL_MS = '0';
  process.env.OPEN_METEO_TIMEOUT_MS = '300';
  process.env.OPEN_METEO_RETRIES = '2';
  installMockFetch();

  const svc = await import('../src/services/open_meteo_service');
  openMeteoService = svc.openMeteoService;
  const cfg = await import('../src/config/data_sources');
  DATA_SOURCES = cfg.DATA_SOURCES;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

test('successful fetch ingests a LIVE signal into the signal pipeline', async () => {
  fetchBehavior = 'respond';
  fetchCalls = [];
  mockHandler = () => ({ status: 200, body: hourlyPayload(4) });
  const result = await openMeteoService.refreshAllDistricts(SET_A);
  assert.equal(result.success_count, 3);
  assert.equal(result.fail_count, 0);
  assert.equal(DATA_SOURCES.OPEN_METEO_TELEMETRY.health, 'HEALTHY');
  assert.equal(DATA_SOURCES.OPEN_METEO_TELEMETRY.currentMode, 'LIVE');
});

test('duplicate suppression: re-refresh does not re-ingest within the window', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(TEST_DB);
  const beforeCount = db.prepare('select count(*) c from external_signals').get() as any;
  fetchBehavior = 'respond';
  fetchCalls = [];
  mockHandler = () => ({ status: 200, body: hourlyPayload(4) });
  const result = await openMeteoService.refreshAllDistricts(SET_A);
  const afterCount = db.prepare('select count(*) c from external_signals').get() as any;
  assert.equal(afterCount.c, beforeCount.c);
  assert.equal(result.success_count, 3);
});

test('no outbound requests escape the mocked fetch harness', async () => {
  const urls: string[] = [];
  fetchBehavior = 'respond';
  fetchCalls = [];
  mockHandler = () => ({ status: 200, body: hourlyPayload(2) });
  await openMeteoService.refreshAllDistricts(SET_B);
  for (const url of fetchCalls) {
    assert.ok(url.startsWith('https://api.open-meteo.com/'), `non-mocked URL: ${url}`);
    urls.push(url);
  }
  assert.ok(urls.length >= 3);
});

test('5xx responses are retried with backoff and eventually succeed', async () => {
  fetchBehavior = 'respond';
  fetchCalls = [];
  let calls = 0;
  mockHandler = () => {
    calls += 1;
    return calls <= 2
      ? { status: 500, body: { error: 'upstream' } }
      : { status: 200, body: hourlyPayload(6) };
  };
  const result = await openMeteoService.fetchLiveRainfallForDistrict(SET_C[0]);
  assert.equal(result.success, true);
  assert.ok(calls >= 3, `expected retries before success, got ${calls} call(s)`);
});

test('persistent 429 marks source rate-limited with honest DOWN health', async () => {
  fetchBehavior = 'respond';
  fetchCalls = [];
  mockHandler = () => ({ status: 429, body: { error: 'rate limited' } });
  const result = await openMeteoService.refreshAllDistricts(SET_D);
  assert.equal(result.success_count, 0);
  assert.ok(result.fail_count >= 3);
  assert.equal(DATA_SOURCES.OPEN_METEO_TELEMETRY.health, 'DOWN');
  assert.equal(DATA_SOURCES.OPEN_METEO_TELEMETRY.currentMode, 'UNAVAILABLE');
  assert.equal(openMeteoService.getStatus().last_rate_limited_at === null, false);
});

test('request that never resolves times out and fails honestly', async () => {
  fetchBehavior = 'hang';
  fetchCalls = [];
  const result = await openMeteoService.fetchLiveRainfallForDistrict(SET_E[0]);
  assert.equal(result.success, false);
  assert.ok(result.error);
});

test('network failure surfaces as failed refresh without fabricating LIVE data', async () => {
  fetchBehavior = 'throw';
  fetchCalls = [];
  const result = await openMeteoService.refreshAllDistricts(SET_F);
  assert.equal(result.success_count, 0);
  assert.equal(DATA_SOURCES.OPEN_METEO_TELEMETRY.health, 'DOWN');
  assert.equal(result.fail_count, 3);
});

test('stale observations are stored with EXPIRED freshness and never as fresh LIVE', async () => {
  const mod = await import('../src/services/rainfall_service');
  const stale = mod.rainfallService.ingestObservation({
    rawDistrict: 'Hyderabad',
    rainfall_mm: 50,
    unit: 'mm',
    sourceName: 'Open-Meteo High-Resolution Telangana Ingestion',
    sourceType: 'weather_service',
    dataMode: 'LIVE',
    timestamp: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
  } as any);
  assert.equal(stale.success, true);
  assert.equal(stale.signal.freshness, 'EXPIRED');
  assert.notEqual(stale.signal.freshness, 'FRESH');
});

test('unconnected sources remain clearly marked offline', async () => {
  assert.equal(DATA_SOURCES.OPEN_METEO_TELEMETRY.integrationStatus, 'CONNECTED');
  assert.equal(DATA_SOURCES.IMD_AWS_TELANGANA.integrationStatus, 'NOT_CONFIGURED');
  assert.equal(DATA_SOURCES.IMD_AWS_TELANGANA.currentMode, 'UNAVAILABLE');
  assert.equal(DATA_SOURCES.CWC_TELANGANA_HYDROMET.currentMode, 'UNAVAILABLE');
  assert.equal(DATA_SOURCES.TELANGANA_HISTORICAL_BASELINE.integrationStatus, 'MANUAL_VERIFICATION');
});
