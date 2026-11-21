/**
 * Read-side access to the data-pipeline tables (migration 004).
 * Every row returned carries observed/valid time, retrieval time, source and a freshness status
 * computed AT READ TIME from the observation timestamp. Nothing here is ever labelled LIVE unless
 * the observation is recent. Missing values stay null.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/sqlite';

export type DataStatus = 'LIVE' | 'FORECAST' | 'HISTORICAL' | 'ESTIMATED' | 'STALE' | 'UNAVAILABLE' | 'UNVERIFIED';

export function freshness(observedAt: string | null | undefined, now = Date.now()): DataStatus {
  if (!observedAt) return 'UNAVAILABLE';
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return 'UNVERIFIED';
  const h = (now - t) / 3_600_000;
  return h <= 3 ? 'LIVE' : h <= 72 ? 'STALE' : 'HISTORICAL';
}

function tableExists(name: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function pipelineAvailable(): boolean {
  return tableExists('dataset_registry');
}

export function getRegistry() {
  if (!pipelineAvailable()) return { available: false, datasets: [] };
  const db = getDb();
  const datasets = db.prepare('SELECT * FROM dataset_registry ORDER BY data_type, dataset_id').all() as any[];
  const counts: Record<string, string> = {
    openmeteo_archive_daily: 'SELECT COUNT(*) n, MAX(obs_date) m FROM weather_historical_daily',
    openmeteo_forecast: 'SELECT COUNT(*) n, MAX(valid_at) m FROM weather_forecast_hourly',
    nwdp_rainfall_telangana_sw: 'SELECT COUNT(*) n, MAX(observed_at) m FROM rainfall_station_observations',
    nwdp_groundwater_telangana_gw: 'SELECT COUNT(*) n, MAX(observed_at) m FROM groundwater_observations',
    nwdp_river_godavari: "SELECT COUNT(*) n, MAX(observed_at) m FROM river_level_observations WHERE source_id='nwdp_river_godavari'",
    nwdp_river_krishna: "SELECT COUNT(*) n, MAX(observed_at) m FROM river_level_observations WHERE source_id='nwdp_river_krishna'",
    dem_srtm_30m: 'SELECT COUNT(*) n, MAX(computed_at) m FROM district_terrain_features',
  };
  return {
    available: true,
    datasets: datasets.map(d => {
      const run = db.prepare('SELECT status, started_at, finished_at, records_fetched, records_inserted, records_rejected, error_message FROM ingestion_runs WHERE dataset_id=? ORDER BY run_id DESC LIMIT 1').get(d.dataset_id) as any;
      const c = counts[d.dataset_id] ? (db.prepare(counts[d.dataset_id]).get() as any) : null;
      const latest = c?.m ?? null;
      return {
        ...d,
        verified: !!d.verified,
        stored_records: c?.n ?? 0,
        latest_observation: latest,
        freshness: c && c.n > 0 ? (d.data_type === 'weather' && d.default_status === 'HISTORICAL' ? 'HISTORICAL' : freshness(latest)) : 'UNAVAILABLE',
        last_run: run ?? null,
      };
    }),
  };
}

export function getRiverTelemetry(districtId?: string) {
  if (!tableExists('river_level_observations')) return [];
  const rows = getDb().prepare(`
    SELECT o.* FROM river_level_observations o
    JOIN (SELECT station_name, river, MAX(observed_at) m FROM river_level_observations GROUP BY station_name, river) l
      ON l.station_name=o.station_name AND IFNULL(l.river,'')=IFNULL(o.river,'') AND l.m=o.observed_at
    ${districtId ? 'WHERE o.district_id = ?' : ''} ORDER BY o.river, o.station_name`).all(...(districtId ? [districtId] : [])) as any[];
  return rows.map(r => ({ ...r, data_status: freshness(r.observed_at), unit: 'm (as reported by source; gauge datum see zero_gauge_m/msl_m)' }));
}

export function getHydrologyFeatures() {
  if (!tableExists('district_hydrology_features')) return [];
  return getDb().prepare(`SELECT h.* FROM district_hydrology_features h
    JOIN (SELECT district_id, MAX(as_of) m FROM district_hydrology_features GROUP BY district_id) l ON l.district_id=h.district_id AND l.m=h.as_of
    ORDER BY h.district_id`).all();
}

export function getTerrain() {
  return tableExists('district_terrain_features') ? getDb().prepare('SELECT * FROM district_terrain_features ORDER BY district_id').all() : [];
}

export function getDistrictForecast(districtId: string) {
  if (!tableExists('weather_forecast_hourly')) return { available: false, hourly: [], current: null };
  const db = getDb();
  const hourly = db.prepare('SELECT * FROM weather_forecast_hourly WHERE district_id=? ORDER BY valid_at').all(districtId) as any[];
  const current = db.prepare('SELECT * FROM weather_current WHERE district_id=? ORDER BY observed_at DESC LIMIT 1').get(districtId) as any;
  return {
    available: hourly.length > 0, current, hourly,
    note: 'Open-Meteo values are weather-model output, not station observations. Null precipitation means missing, not zero.',
    retrieved_at: hourly.length ? hourly[0].retrieved_at : null,
  };
}

export function getDistrictHistory(districtId: string, from?: string, to?: string) {
  if (!tableExists('weather_historical_daily')) return [];
  return getDb().prepare('SELECT obs_date, precipitation_sum_mm, rain_sum_mm, precipitation_hours, temp_max_c, temp_min_c, relative_humidity_mean_pct, grid_lat, grid_lon, grid_elevation_m, model_note, retrieved_at, data_status FROM weather_historical_daily WHERE district_id=? AND obs_date>=? AND obs_date<=? ORDER BY obs_date')
    .all(districtId, from || '0000-01-01', to || '9999-12-31');
}

export function getTelemetryCompleteness() {
  return tableExists('district_data_completeness') ? getDb().prepare('SELECT * FROM district_data_completeness ORDER BY district_id, dataset_id').all() : [];
}

export function getBoundariesGeoJson(): any | null {
  const p = path.join(process.cwd(), 'data', 'processed', 'geographic', 'telangana_districts.geojson');
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; } catch { return null; }
}
