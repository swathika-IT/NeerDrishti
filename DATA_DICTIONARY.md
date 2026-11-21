# Data Dictionary (migration 004)

All timestamps are **UTC ISO-8601 (`...Z`)** except `obs_date` (YYYY-MM-DD, Asia/Kolkata calendar day). The UI converts to IST for display. `NULL` always means *missing*; a measured zero is stored as `0`.
Status vocabulary: LIVE · FORECAST · HISTORICAL · ESTIMATED · IMPUTED · CACHED · STALE · UNAVAILABLE · UNVERIFIED. For telemetry, `LIVE/STALE/HISTORICAL` are **computed at read time** from `observed_at` (≤3 h / ≤72 h / older), never stored.

| Table | Grain / key | Key columns & units | Provenance |
|---|---|---|---|
| `dataset_registry` | `dataset_id` | name, provider, endpoint, resource_id, data_type, licence, `verified` (0/1) | set by ingestion; `verified=1` only after a human confirms identity |
| `ingestion_runs` | `run_id` | dataset_id, started/finished, status (SUCCESS/PARTIAL/FAILED), fetched/inserted/rejected, error | one row per run, written even on failure |
| `weather_current` | district, observed_at, source | temperature_c, relative_humidity_pct, precipitation_mm, weather_code | Open-Meteo model "current"; `data_status=FORECAST` (not a station observation) |
| `weather_forecast_hourly` | district, valid_at, source | temperature_c, precipitation_mm, rain_mm, humidity %, pressure_msl_hpa, precip_probability_pct | Open-Meteo forecast; upserted each refresh; `retrieved_at` kept |
| `weather_historical_daily` | district, obs_date, source | precipitation_sum_mm, rain_sum_mm, precipitation_hours, temp_max/min_c, relative_humidity_mean_pct (optional), grid lat/lon/elevation, model_note | Open-Meteo archive (gridded model data) |
| `rainfall_station_observations` | station, observed_at, source | rainfall_mm (hourly, NULL if missing), lat/lon, district_raw + district_id, quality_flag | NWDP telemetry |
| `groundwater_observations` | station, observed_at, source | groundwater_level_m, datum_note | NWDP; datum unverified; **not comparable to river level** |
| `river_level_observations` | station, river, observed_at, source | water_level_m, zero_gauge_m, msl_m, river, basin, tributary, district_lgd | NWDP Godavari/Krishna telemetry |
| `reservoir_observations` | reservoir, observed_at, source | inflow, outflow, storage, water_level, capacity, units_json, identity_verified | only after manual identity verification |
| `district_terrain_features` | district | elevation min/p10/mean/median/max (m), slope mean/p90 (deg), low_slope_pct (+threshold), flow_acc mean/p90 (cells), drainage_density_km_per_km2, twi_mean, method_note | DEM-derived, `ESTIMATED` |
| `district_hydrology_features` | district, as_of | river latest level/time, rise_1h/3h (m, max over stations), station_rain_24h_mm (max over stations with ≥12 valid hours), groundwater latest / 7-day change, data_status | derived from the tables above |
| `district_data_completeness` | district, dataset_id | status (AVAILABLE/MISSING/ESTIMATED), n_records, last_observed_at | derived |
| `notification_simulation_keys` | idempotency_key | simulation_id, user_id, response_json | notification simulator idempotency |

`quality_flag` values: `OK`, `VALUE_MISSING`, `NEGATIVE_RAINFALL_REJECTED`, `IMPLAUSIBLE_GT_300MM_PER_HOUR`, `COORD_OUTSIDE_TELANGANA_BOX`, `UNVERIFIED`.
Static risk inputs (flood history / terrain / drainage) remain in `data/district_features.json` with per-value provenance (DATASET / EXPERT_PRIOR / PROXY_DERIVED).
