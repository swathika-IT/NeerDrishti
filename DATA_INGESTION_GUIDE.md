# Data Ingestion Guide

Everything below runs from the project root. The pipeline is Python (`scripts/pipeline`) and writes into the same SQLite file the Node server reads (`DATABASE_PATH`, default `data/neerdrishti.db`).

> **Status:** the pipeline code is written and unit-tested against **synthetic** records. It has **not** been run against the live NWDP, Open-Meteo or OpenTopography services (the build sandbox had no internet). Run the steps below on your machine and read the generated schema reports before trusting any dataset.

## 0. One-time setup
```powershell
python -m venv .venv ; .\.venv\Scripts\Activate.ps1
pip install -r requirements-pipeline.txt
npm ci ; npm run bootstrap        # creates schema + applies migrations 001-004 (backs up first)
python -m scripts.pipeline.cli registry
```
`npm run test:py` should report all tests passing before you start downloading.

## 1. Weather (Open-Meteo): no key needed
```powershell
python -m scripts.pipeline.cli archive --start 2023-01-01          # daily history, 33 districts (add --humidity for hourly->daily RH)
python -m scripts.pipeline.cli forecast                             # current + 7-day hourly (re-run hourly; responses cached 1 h)
```
Open-Meteo values are gridded **model** output at district centroids, not station observations. Check the model identity at open-meteo.com before calling the archive "ERA5". The archive lags real time by a few days.

## 2. NWDP telemetry: inspect first, then ingest
```powershell
python -m scripts.pipeline.cli inspect-nwdp nwdp_rainfall_telangana_sw      # prints fields + sample; compare with the portal page
python -m scripts.pipeline.cli nwdp nwdp_rainfall_telangana_sw --max 5000
python -m scripts.pipeline.cli nwdp nwdp_groundwater_telangana_gw --max 5000
python -m scripts.pipeline.cli nwdp nwdp_river_godavari
python -m scripts.pipeline.cli nwdp nwdp_river_krishna
```
Read `data/quality_reports/schema_*.json` / `ingest_*.json`: `discovered_mapping` (which source column was used for what), `unmatched_district_names`, `quality_flag_counts`, `unit_hint`. If a required field cannot be found the run fails loudly and writes the report. It never guesses.
Naive NWDP timestamps are **assumed IST** (stored as UTC). Confirm on the resource page.
If TLS fails, do not disable verification: obtain the missing intermediate certificate and set `NWDP_CA_BUNDLE`.

## 3. Reservoirs: identity must be verified by you
```powershell
python -m scripts.pipeline.cli inspect-nwdp nwdp_reservoir_candidate_a      # writes data/quality_reports/reservoir_inspect_*.json
python -m scripts.pipeline.cli inspect-nwdp nwdp_reservoir_candidate_b
```
The comments in the original scripts are **not** proof of which dam a resource contains. After reading the report and the portal page, create `data/metadata/reservoir_resources.json`:
```json
[{"dataset_id":"nwdp_reservoir_candidate_a","verified":true,"reservoir_name":"<name you confirmed>","district":"<district>","river":"<river>",
  "field_map":{"time":"<col>","inflow":"<col>","outflow":"<col>","storage":"<col or null>","water_level":"<col or null>","capacity":"<col or null>"},
  "units":{"inflow":"<unit as reported>"}}]
```
then `python -m scripts.pipeline.cli reservoir nwdp_reservoir_candidate_a`. Without this file reservoir ingestion refuses to run.

## 4. Boundaries and terrain
```powershell
python -m scripts.pipeline.cli boundaries path\to\District_NWIC.geojson     # -> data/processed/geographic/telangana_districts.geojson
$env:OPENTOPOGRAPHY_API_KEY = "<your key>"                                    # never commit
python -m scripts.pipeline.cli dem-download                                   # ~ full-state 30 m GeoTIFF (large)
python -m scripts.pipeline.cli terrain --resolution 90                        # start at 90 m; use 30 for the final run
```
`boundaries` reports the discovered state/district columns, unmatched names, repaired geometries and whether **all 33** districts are present (post-2019 list incl. Mulugu, Narayanpet). Fix any `missing_district_ids` before continuing. A 30 m full-state flow-routing run needs several GB of RAM; use `--resolution 90` first.

## 5. Derived features + completeness
```powershell
python -m scripts.pipeline.cli features      # district_hydrology_features + district_data_completeness
```
Schedule steps 1 (forecast), 2 and 5 hourly/6-hourly (Task Scheduler or cron). Runs are incremental and idempotent; each is logged in `ingestion_runs`.

## 6. Check it in the app
Engineer View → **Data & IoT** → *Data pipeline status* shows records, latest observation, freshness and last run per dataset. API: `/api/pipeline/registry`, `/api/telemetry/river`, `/api/telemetry/hydrology-features`, `/api/terrain`, `/api/weather/forecast/:id`, `/api/weather/history/:id`, `/api/geo/districts`.
