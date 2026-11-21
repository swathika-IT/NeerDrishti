import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Verifies the Python ingestion -> SQLite -> Node API contract with SYNTHETIC records.
const ROOT = process.cwd(), DB = path.join(os.tmpdir(), `nd-contract-${Date.now()}.db`), PORT = 3232, BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcessWithoutNullStreams | null = null;
const j = async (p: string) => (await fetch(`${BASE}${p}`)).json() as Promise<any>;

before(async () => {
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATABASE_PATH: DB, NEERDRISHTI_BACKUP_DIR: path.join(os.tmpdir(), `nd-c-bk-${Date.now()}`) };
  execFileSync(process.execPath, ['dist/bootstrap.cjs'], { cwd: ROOT, env, stdio: 'pipe' });
  const py = process.env.PYTHON || 'python3';
  execFileSync(py, ['tests/fixtures/seed_pipeline.py'], { cwd: ROOT, env, stdio: 'pipe' });
  server = spawn(process.execPath, ['dist/server.cjs'], { cwd: ROOT, env });
  const end = Date.now() + 45000;
  while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* retry */ } await new Promise(r => setTimeout(r, 400)); }
});
after(() => { server?.kill(); for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } } });

test('river telemetry: fresh reading is LIVE, 40-day-old reading is HISTORICAL (never LIVE), values & provenance preserved', async () => {
  const d = await j('/api/telemetry/river');
  const fresh = d.stations.find((s: any) => s.station_name === 'SYN-Bhadrachalam'), old = d.stations.find((s: any) => s.station_name === 'SYN-OldGauge');
  assert.equal(fresh.data_status, 'LIVE'); assert.equal(old.data_status, 'HISTORICAL');
  assert.equal(fresh.district_id, 'bhadradri_kothagudem'); assert.equal(fresh.source_id, 'nwdp_river_godavari'); assert.ok(fresh.retrieved_at); assert.match(fresh.observed_at, /Z$/);
  assert.equal(d.stations.length, 2);
});

test('hydrology features computed by Python are served: 3h rise, missing stays null (not 0)', async () => {
  const d = await j('/api/telemetry/hydrology-features');
  const b = d.districts.find((x: any) => x.district_id === 'bhadradri_kothagudem');
  assert.equal(b.data_status, 'LIVE'); assert.ok(Math.abs(b.river_rise_3h_m - 3.0) < 0.05, `rise ${b.river_rise_3h_m}`);
  const a = d.districts.find((x: any) => x.district_id === 'adilabad');
  assert.equal(a.latest_river_level_m, null); assert.equal(a.station_rain_24h_mm, null); assert.equal(a.data_status, 'UNAVAILABLE');
  assert.equal(d.districts.length, 33);
});

test('historical daily weather: zero stays 0, missing stays null, grid provenance present', async () => {
  const d = (await j('/api/weather/history/adilabad')).daily;
  assert.equal(d.length, 2); assert.equal(d[0].precipitation_sum_mm, 0); assert.equal(d[1].precipitation_sum_mm, null);
  assert.equal(d[0].grid_elevation_m, 300); assert.equal(d[0].data_status, 'HISTORICAL');
});

test('registry exposes stored counts, freshness and last ingestion run; completeness covers 33 districts x 7 datasets', async () => {
  const r = await j('/api/pipeline/registry');
  const g = r.datasets.find((x: any) => x.dataset_id === 'nwdp_river_godavari');
  assert.equal(g.stored_records, 6); assert.equal(g.freshness, 'LIVE'); assert.equal(g.last_run.status, 'SUCCESS'); assert.equal(g.verified, false);
  assert.equal(r.datasets.find((x: any) => x.dataset_id === 'nwdp_river_krishna').freshness, 'UNAVAILABLE');
  assert.equal((await j('/api/pipeline/completeness')).rows.length, 33 * 7);
});
