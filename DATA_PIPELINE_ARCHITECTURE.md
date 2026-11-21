# Data Pipeline Architecture

```
Sources (Open-Meteo, NWDP/NWIC, OpenTopography, boundary GeoJSON)
   │  requests (retry/backoff, TLS verified, timeouts, pagination, 1-h cache for forecast)
   ▼
scripts/pipeline/*.py   discover schema → validate → normalise district ids → flag quality
   │  INSERT OR IGNORE / upsert (idempotent, incremental), ingestion_runs row per run
   ▼
SQLite (migration 004 tables)  +  data/raw, data/processed, data/quality_reports (large files stay on disk)
   │  features.py: hydrology features, completeness
   ▼
src/services/pipeline_data.ts  → /api/pipeline/*, /api/telemetry/*, /api/weather/*, /api/terrain, /api/geo/districts
   │  freshness (LIVE/STALE/HISTORICAL) computed at read time
   ▼
React: Data & IoT → "Data pipeline status", Risk Map polygons, Playground completeness
```
Design rules: schema discovery instead of assumed field names · NULL ≠ 0 · no silent imputation · unverified identity blocks ingestion (reservoirs) · the operational risk engine is untouched · every row keeps `source_id` and `retrieved_at`.
Tests: `npm run test:py` (23, parsers/validation/geospatial on synthetic data) and `tests/pipeline_contract.test.ts` (Python → SQLite → HTTP API contract; it caught a real column-matching bug).
