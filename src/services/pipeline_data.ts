/**
 * Read-side access to data-pipeline collections (migration 004).
 * Every row returned carries observed/valid time, retrieval time, source and a freshness status
 * computed AT READ TIME from the observation timestamp. Nothing here is ever labelled LIVE unless
 * the observation is recent. Missing values stay null.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/mongo';

export type DataStatus = 'LIVE' | 'FORECAST' | 'HISTORICAL' | 'ESTIMATED' | 'STALE' | 'UNAVAILABLE' | 'UNVERIFIED';

export function freshness(observedAt: string | null | undefined, now = Date.now()): DataStatus {
  if (!observedAt) return 'UNAVAILABLE';
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return 'UNVERIFIED';
  const h = (now - t) / 3_600_000;
  return h <= 3 ? 'LIVE' : h <= 72 ? 'STALE' : 'HISTORICAL';
}

async function collectionExists(name: string): Promise<boolean> {
  const db = getDb();
  const cols = await db.listCollections({ name }).toArray();
  return cols.length > 0;
}

export async function pipelineAvailable(): Promise<boolean> {
  return collectionExists('dataset_registry');
}

export async function getRegistry() {
  if (!(await pipelineAvailable())) return { available: false, datasets: [] };
  const db = getDb();
  const datasets = await db.collection('dataset_registry').find({}).sort({ data_type: 1, dataset_id: 1 }).toArray();
  const countMap: Record<string, { col: string; maxField: string; filter?: any }> = {
    openmeteo_archive_daily: { col: 'weather_historical_daily', maxField: 'obs_date' },
    openmeteo_forecast: { col: 'weather_forecast_hourly', maxField: 'valid_at' },
    nwdp_rainfall_telangana_sw: { col: 'rainfall_station_observations', maxField: 'observed_at' },
    nwdp_groundwater_telangana_gw: { col: 'groundwater_observations', maxField: 'observed_at' },
    nwdp_river_godavari: { col: 'river_level_observations', maxField: 'observed_at', filter: { source_id: 'nwdp_river_godavari' } },
    nwdp_river_krishna: { col: 'river_level_observations', maxField: 'observed_at', filter: { source_id: 'nwdp_river_krishna' } },
    dem_srtm_30m: { col: 'district_terrain_features', maxField: 'computed_at' },
  };

  const out = [];
  for (const d of datasets) {
    const run =
      (await db.collection('ingestion_runs').find({ dataset_id: d.dataset_id, run_id: { $exists: true } }).sort({ run_id: -1 }).limit(1).next()) ??
      (await db.collection('ingestion_runs').find({ dataset_id: d.dataset_id }).sort({ started_at: -1 }).limit(1).next());
    const cfg = countMap[d.dataset_id];
    let latest: string | null = null;
    let storedRecords = 0;
    if (cfg && await collectionExists(cfg.col)) {
      const col = db.collection(cfg.col);
      const filter = cfg.filter || {};
      storedRecords = await col.countDocuments(filter);
      if (storedRecords > 0) {
        const latestDoc = await col.find(filter).sort({ [cfg.maxField]: -1 }).limit(1).next();
        latest = latestDoc?.[cfg.maxField] ?? null;
      }
    }
    out.push({
      ...d,
      verified: !!d.verified,
      stored_records: storedRecords,
      latest_observation: latest,
      freshness: storedRecords > 0 ? (d.data_type === 'weather' && d.default_status === 'HISTORICAL' ? 'HISTORICAL' : freshness(latest)) : 'UNAVAILABLE',
      last_run: run ?? null,
    });
  }
  return { available: true, datasets: out };
}

export async function getRiverTelemetry(districtId?: string) {
  if (!(await collectionExists('river_level_observations'))) return [];
  const db = getDb();
  const match: any = districtId ? { district_id: districtId } : {};
  const rows = await db.collection('river_level_observations').aggregate([
    { $match: match },
    { $sort: { observed_at: -1 } },
    { $group: { _id: { station_name: '$station_name', river: '$river' }, doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { river: 1, station_name: 1 } },
  ]).toArray();
  return rows.map((r: any) => ({ ...r, data_status: freshness(r.observed_at), unit: 'm (as reported by source; gauge datum see zero_gauge_m/msl_m)' }));
}

export async function getHydrologyFeatures() {
  if (!(await collectionExists('district_hydrology_features'))) return [];
  const db = getDb();
  return await db.collection('district_hydrology_features').aggregate([
    { $sort: { as_of: -1 } },
    { $group: { _id: '$district_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { district_id: 1 } },
  ]).toArray();
}

export async function getTerrain() {
  if (!(await collectionExists('district_terrain_features'))) return [];
  return await getDb().collection('district_terrain_features').find({}).sort({ district_id: 1 }).toArray();
}

export async function getDistrictForecast(districtId: string) {
  if (!(await collectionExists('weather_forecast_hourly'))) return { available: false, hourly: [], current: null };
  const db = getDb();
  const hourly = await db.collection('weather_forecast_hourly').find({ district_id: districtId }).sort({ valid_at: 1 }).toArray();
  const current = await db.collection('weather_current').find({ district_id: districtId }).sort({ observed_at: -1 }).limit(1).next();
  return {
    available: hourly.length > 0, current, hourly,
    note: 'Open-Meteo values are weather-model output, not station observations. Null precipitation means missing, not zero.',
    retrieved_at: hourly.length ? (hourly[0] as any).retrieved_at : null,
  };
}

export async function getDistrictHistory(districtId: string, from?: string, to?: string) {
  if (!(await collectionExists('weather_historical_daily'))) return [];
  return await getDb().collection('weather_historical_daily').find({
    district_id: districtId,
    obs_date: { $gte: from || '0000-01-01', $lte: to || '9999-12-31' },
  }).sort({ obs_date: 1 }).toArray();
}

export async function getTelemetryCompleteness() {
  if (!(await collectionExists('district_data_completeness'))) return [];
  return await getDb().collection('district_data_completeness').find({}).sort({ district_id: 1, dataset_id: 1 }).toArray();
}

export function getBoundariesGeoJson(): any | null {
  const p = path.join(process.cwd(), 'data', 'processed', 'geographic', 'telangana_districts.geojson');
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; } catch { return null; }
}
