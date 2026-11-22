import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { getMongoTestUri, assertSafeMongoTestUri, spawnTestServer, stopTestServer, connectTestMongo, dropTestDb } from './helpers/mongo_integration_harness';

const MONGO_URI = getMongoTestUri();
assertSafeMongoTestUri(MONGO_URI);
let PORT = 3232;
let BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcessWithoutNullStreams | null = null;
let mongo: any;
const j = async (p: string) => (await fetch(`${BASE}${p}`)).json() as Promise<any>;

before(async () => {
  mongo = await connectTestMongo(MONGO_URI);
  await mongo.db.dropDatabase();
  const { initDatabase } = await import('../src/db/mongo');
  await initDatabase();
  const now = Date.now();
  await mongo.db.collection('pipeline_ingestion_runs').insertMany([
    { run_id: 'run-live', dataset_id: 'nwdp_river_godavari', source_id: 'nwdp_river_godavari', run_started_at: new Date(now-60000), run_finished_at: new Date(now-30000), status: 'SUCCESS', records_seen: 6, records_inserted: 6, records_updated: 0, records_skipped: 0 },
    { run_id: 'run-krishna', dataset_id: 'nwdp_river_krishna', source_id: 'nwdp_river_krishna', run_started_at: new Date(now-60000), run_finished_at: new Date(now-30000), status: 'SUCCESS', records_seen: 0, records_inserted: 0, records_updated: 0, records_skipped: 0 },
  ]);
  await mongo.db.collection('river_telemetry_readings').insertMany([
    { district_id: 'bhadradri_kothagudem', district_name: 'Bhadradri Kothagudem', station_name: 'SYN-Bhadrachalam', river_name: 'Godavari', observed_at: new Date(now-30*60*1000), recorded_at: new Date(now-30*60*1000), retrieved_at: new Date(now-5*60*1000), water_level_m: 13.2, danger_level_m: 17.75, warning_level_m: 16.75, data_status: 'LIVE', quality_flag: 'VALID', source_id: 'nwdp_river_godavari', source_name: 'NWDP Godavari', source_url: 'https://example.test/godavari' },
    { district_id: 'bhadradri_kothagudem', district_name: 'Bhadradri Kothagudem', station_name: 'SYN-OldGauge', river_name: 'Godavari', observed_at: new Date(now-40*24*60*60*1000), recorded_at: new Date(now-40*24*60*60*1000), retrieved_at: new Date(now-40*24*60*60*1000), water_level_m: 10.1, danger_level_m: 17.75, warning_level_m: 16.75, data_status: 'HISTORICAL', quality_flag: 'VALID', source_id: 'nwdp_river_godavari', source_name: 'NWDP Godavari', source_url: 'https://example.test/godavari' },
  ]);
  await mongo.db.collection('hydrology_district_features').insertMany([
    { district_id: 'bhadradri_kothagudem', district_name: 'Bhadradri Kothagudem', computed_at: new Date(now-5*60*1000), data_status: 'LIVE', latest_river_level_m: 13.2, river_rise_3h_m: 3.0, station_rain_24h_mm: 12, source_id: 'nwdp_river_godavari' },
    { district_id: 'adilabad', district_name: 'Adilabad', computed_at: new Date(now-5*60*1000), data_status: 'UNAVAILABLE', latest_river_level_m: null, river_rise_3h_m: null, station_rain_24h_mm: null, source_id: null },
  ]);
  await mongo.db.collection('historical_weather_daily').insertMany([
    { district_id: 'adilabad', district_name: 'Adilabad', date: '2026-11-20', precipitation_sum_mm: 0, precipitation_missing: false, grid_elevation_m: 300, data_status: 'HISTORICAL', source_id: 'open_meteo_archive', recorded_at: new Date(now-86400000) },
    { district_id: 'adilabad', district_name: 'Adilabad', date: '2026-11-21', precipitation_sum_mm: null, precipitation_missing: true, grid_elevation_m: 300, data_status: 'HISTORICAL', source_id: 'open_meteo_archive', recorded_at: new Date(now-86400000) },
  ]);
  const started = await spawnTestServer({ port: PORT, mongoUri: MONGO_URI });
  server = started.server; BASE = started.base;
});

after(async () => {
  await stopTestServer(server);
  if (mongo) { await dropTestDb(mongo.client, mongo.dbName); await mongo.client.close(); }
});

test('river telemetry: fresh reading is LIVE, 40-day-old reading is HISTORICAL (never LIVE), values & provenance preserved', async () => {
  const d = await j('/api/telemetry/river');
  const fresh = d.stations.find((s: any) => s.station_name === 'SYN-Bhadrachalam');
  const old = d.stations.find((s: any) => s.station_name === 'SYN-OldGauge');
  assert.equal(fresh.data_status, 'LIVE'); assert.equal(old.data_status, 'HISTORICAL');
  assert.equal(fresh.district_id, 'bhadradri_kothagudem'); assert.equal(fresh.source_id, 'nwdp_river_godavari');
  assert.ok(fresh.retrieved_at); assert.match(String(fresh.observed_at), /Z|T/);
});

test('hydrology features are served; missing stays null (not 0)', async () => {
  const d = await j('/api/telemetry/hydrology-features');
  const b = d.districts.find((x: any) => x.district_id === 'bhadradri_kothagudem');
  assert.equal(b.data_status, 'LIVE'); assert.ok(Math.abs(b.river_rise_3h_m - 3.0) < 0.05);
  const a = d.districts.find((x: any) => x.district_id === 'adilabad');
  assert.equal(a.latest_river_level_m, null); assert.equal(a.station_rain_24h_mm, null);
});

test('historical daily weather: zero stays 0, missing stays null, provenance present', async () => {
  const d = (await j('/api/weather/history/adilabad')).daily;
  assert.ok(d.length >= 2);
  assert.equal(d[0].precipitation_sum_mm, 0); assert.equal(d[1].precipitation_sum_mm, null);
  assert.equal(d[0].grid_elevation_m, 300); assert.equal(d[0].data_status, 'HISTORICAL');
});

test('registry exposes stored counts, freshness and last ingestion run', async () => {
  const r = await j('/api/pipeline/registry');
  const g = r.datasets.find((x: any) => x.dataset_id === 'nwdp_river_godavari');
  assert.ok(g); assert.equal(g.last_run?.status, 'SUCCESS');
});
