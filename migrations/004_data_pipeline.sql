-- NeerDrishti migration 004: data-engineering tables (SQLite dialect)
-- Additive only: new tables + indexes. No existing table or row is modified.
-- Every observation row carries: source_id, observed/valid time, retrieved_at, units (in column names), quality_flag.
-- data_status vocabulary: LIVE | FORECAST | HISTORICAL | ESTIMATED | IMPUTED | CACHED | STALE | UNAVAILABLE | UNVERIFIED

CREATE TABLE IF NOT EXISTS dataset_registry (
  dataset_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  provider       TEXT NOT NULL,
  endpoint       TEXT,
  resource_id    TEXT,
  data_type      TEXT NOT NULL,            -- weather | rainfall | groundwater | river_level | reservoir | boundary | dem | ...
  default_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  licence        TEXT,
  coverage_note  TEXT,
  verified       INTEGER NOT NULL DEFAULT 0, -- 1 only after schema + identity verified against the live API
  notes          TEXT,
  registered_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  run_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id        TEXT NOT NULL REFERENCES dataset_registry(dataset_id),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,          -- RUNNING | SUCCESS | PARTIAL | FAILED
  records_fetched   INTEGER NOT NULL DEFAULT 0,
  records_inserted  INTEGER NOT NULL DEFAULT 0,
  records_rejected  INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  params_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_dataset ON ingestion_runs(dataset_id, started_at DESC);

CREATE TABLE IF NOT EXISTS weather_current (
  district_id          TEXT NOT NULL REFERENCES districts(district_id),
  observed_at          TEXT NOT NULL,      -- model time, UTC ISO-8601
  retrieved_at         TEXT NOT NULL,
  temperature_c        REAL,
  relative_humidity_pct REAL,
  precipitation_mm     REAL,
  weather_code         INTEGER,
  source_id            TEXT NOT NULL,
  data_status          TEXT NOT NULL DEFAULT 'FORECAST', -- modelled current conditions, NOT a station observation
  PRIMARY KEY (district_id, observed_at, source_id)
);

CREATE TABLE IF NOT EXISTS weather_forecast_hourly (
  district_id            TEXT NOT NULL REFERENCES districts(district_id),
  valid_at               TEXT NOT NULL,
  retrieved_at           TEXT NOT NULL,
  temperature_c          REAL,
  precipitation_mm       REAL,
  rain_mm                REAL,
  relative_humidity_pct  REAL,
  weather_code           INTEGER,
  pressure_msl_hpa       REAL,
  precip_probability_pct REAL,
  source_id              TEXT NOT NULL,
  data_status            TEXT NOT NULL DEFAULT 'FORECAST',
  PRIMARY KEY (district_id, valid_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_wfh_valid ON weather_forecast_hourly(valid_at);

CREATE TABLE IF NOT EXISTS weather_historical_daily (
  district_id            TEXT NOT NULL REFERENCES districts(district_id),
  obs_date               TEXT NOT NULL,    -- YYYY-MM-DD (Asia/Kolkata day as returned by the API timezone)
  precipitation_sum_mm   REAL,
  rain_sum_mm            REAL,
  precipitation_hours    REAL,
  temp_max_c             REAL,
  temp_min_c             REAL,
  relative_humidity_mean_pct REAL,
  model_note             TEXT,             -- archive model/reanalysis identity as reported by the API
  grid_lat               REAL,
  grid_lon               REAL,
  grid_elevation_m       REAL,
  retrieved_at           TEXT NOT NULL,
  source_id              TEXT NOT NULL,
  data_status            TEXT NOT NULL DEFAULT 'HISTORICAL',
  PRIMARY KEY (district_id, obs_date, source_id)
);
CREATE INDEX IF NOT EXISTS idx_whd_date ON weather_historical_daily(obs_date);

CREATE TABLE IF NOT EXISTS rainfall_station_observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  station_name     TEXT NOT NULL,
  district_id      TEXT REFERENCES districts(district_id), -- NULL when the raw name could not be mapped
  district_raw     TEXT,
  latitude         REAL,
  longitude        REAL,
  observed_at      TEXT NOT NULL,
  rainfall_mm      REAL,                   -- NULL = missing (never coerced to 0)
  source_id        TEXT NOT NULL,
  retrieved_at     TEXT NOT NULL,
  quality_flag     TEXT NOT NULL DEFAULT 'OK',
  UNIQUE (station_name, observed_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_rso_district_time ON rainfall_station_observations(district_id, observed_at);

CREATE TABLE IF NOT EXISTS groundwater_observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  station_name     TEXT NOT NULL,
  district_id      TEXT REFERENCES districts(district_id),
  district_raw     TEXT,
  latitude         REAL,
  longitude        REAL,
  observed_at      TEXT NOT NULL,
  groundwater_level_m REAL,                -- datum/reference NOT yet verified; not comparable to river level
  datum_note       TEXT,
  source_id        TEXT NOT NULL,
  retrieved_at     TEXT NOT NULL,
  quality_flag     TEXT NOT NULL DEFAULT 'OK',
  UNIQUE (station_name, observed_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_gwo_district_time ON groundwater_observations(district_id, observed_at);

CREATE TABLE IF NOT EXISTS river_level_observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  station_name     TEXT NOT NULL,
  district_id      TEXT REFERENCES districts(district_id),
  district_raw     TEXT,
  district_lgd     TEXT,
  river            TEXT,
  basin            TEXT,
  tributary        TEXT,
  latitude         REAL,
  longitude        REAL,
  msl_m            REAL,
  zero_gauge_m     REAL,
  observed_at      TEXT NOT NULL,
  water_level_m    REAL,
  source_id        TEXT NOT NULL,
  retrieved_at     TEXT NOT NULL,
  quality_flag     TEXT NOT NULL DEFAULT 'OK',
  UNIQUE (station_name, river, observed_at, source_id)
);
CREATE INDEX IF NOT EXISTS idx_rlo_station_time ON river_level_observations(station_name, observed_at);
CREATE INDEX IF NOT EXISTS idx_rlo_district_time ON river_level_observations(district_id, observed_at);

CREATE TABLE IF NOT EXISTS reservoir_observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reservoir_name   TEXT NOT NULL,
  district_id      TEXT REFERENCES districts(district_id),
  river            TEXT,
  observed_at      TEXT NOT NULL,
  inflow           REAL,
  outflow          REAL,
  storage          REAL,
  water_level      REAL,
  capacity         REAL,
  units_json       TEXT,                    -- units exactly as reported by the source
  identity_verified INTEGER NOT NULL DEFAULT 0,
  source_id        TEXT NOT NULL,
  retrieved_at     TEXT NOT NULL,
  quality_flag     TEXT NOT NULL DEFAULT 'UNVERIFIED',
  UNIQUE (reservoir_name, observed_at, source_id)
);

CREATE TABLE IF NOT EXISTS district_terrain_features (
  district_id        TEXT PRIMARY KEY REFERENCES districts(district_id),
  elev_min_m REAL, elev_p10_m REAL, elev_mean_m REAL, elev_median_m REAL, elev_max_m REAL,
  slope_mean_deg REAL, slope_p90_deg REAL,
  low_slope_pct REAL, low_slope_threshold_deg REAL,
  flow_acc_mean REAL, flow_acc_p90 REAL,
  drainage_density_km_per_km2 REAL,
  twi_mean REAL,
  method_note        TEXT NOT NULL,
  dem_source         TEXT NOT NULL,
  computed_at        TEXT NOT NULL,
  data_status        TEXT NOT NULL DEFAULT 'ESTIMATED'  -- derived from DEM, not measured
);

CREATE TABLE IF NOT EXISTS district_hydrology_features (
  district_id          TEXT NOT NULL REFERENCES districts(district_id),
  as_of                TEXT NOT NULL,
  n_river_stations     INTEGER NOT NULL DEFAULT 0,
  latest_river_level_m REAL,
  latest_river_observed_at TEXT,
  river_rise_1h_m      REAL,
  river_rise_3h_m      REAL,
  n_rain_stations      INTEGER NOT NULL DEFAULT 0,
  station_rain_24h_mm  REAL,
  groundwater_latest_m REAL,
  groundwater_change_7d_m REAL,
  data_status          TEXT NOT NULL,
  computed_at          TEXT NOT NULL,
  PRIMARY KEY (district_id, as_of)
);

CREATE TABLE IF NOT EXISTS district_data_completeness (
  district_id      TEXT NOT NULL REFERENCES districts(district_id),
  dataset_id       TEXT NOT NULL,
  status           TEXT NOT NULL,           -- AVAILABLE | MISSING | ESTIMATED | SIMULATED | STALE | UNVERIFIED
  n_records        INTEGER NOT NULL DEFAULT 0,
  last_observed_at TEXT,
  computed_at      TEXT NOT NULL,
  PRIMARY KEY (district_id, dataset_id)
);

-- Server-side idempotency for notification SIMULATIONS (dry-run only). A repeated key replays the stored response.
CREATE TABLE IF NOT EXISTS notification_simulation_keys (
  idempotency_key TEXT PRIMARY KEY,
  simulation_id   TEXT NOT NULL,
  user_id         INTEGER,
  created_at      TEXT NOT NULL,
  response_json   TEXT NOT NULL
);
