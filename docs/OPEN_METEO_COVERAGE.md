# Open-Meteo Live Rainfall — Coverage & Limitations (Phase 8 / Epic 1)

Source: **Open-Meteo** `https://api.open-meteo.com/v1/forecast` (hourly precipitation) for Telangana district-centre coordinates. **Open-Meteo is NOT an official government flood-warning source.**

## Request profile

- One HTTPS GET per district: `?latitude=…&longitude=…&hourly=precipitation&timezone=Asia/Kolkata`.
- Computed windows: **sum of last 24 hourly precipitation values** (`rainfall_mm_24h`) and **last 3 hours** (`rainfall_mm_3h`), unit **mm**.
- Refresh cadence: every `LIVE_DATA_REFRESH_MINUTES` (default 30 min); batched 5 concurrent requests with 150 ms spacing.
- Timeout: `OPEN_METEO_TIMEOUT_MS` (default 8000 ms), bounded retries `OPEN_METEO_RETRIES` (default 2) with exponential backoff + jitter for network errors / timeout / HTTP 429 / 5xx only. Other 4xx are permanent failures (no retry).
- In-process cache TTL `OPEN_METEO_CACHE_TTL_MS` (default 5 min) — identical coordinate requests reuse the last result.
- Duplicate suppression `DUPLICATE_SUPPRESSION_WINDOW_MS` (default 20 min) — a fresh Open-Meteo `LIVE` signal for the same district is not re-ingested.
- Rate-limit awareness: if ≥ half of a 5-district batch returns HTTP 429, the refresh stops early, records unprocessed districts as *"Not fetched: provider rate limit reached earlier in this cycle"*, and retries next cycle; timestamp recorded in `last_rate_limited_at`.
- Licence: CC BY 4.0, **non-commercial** free tier (~10,000 calls/day, 5,000/hour, 600/min) with required attribution **"Weather data by Open-Meteo.com"** (shown in the app footer).

## Provenance captured on every ingested signal

`source_name` = "Open-Meteo High-Resolution Telangana Ingestion" · `source_type` = `weather_service` · `data_mode` = `LIVE` · `unit` = `mm` · `recorded_at` (observation/retrieval timestamp at ingest, ISO) · metadata: `latitude`, `longitude`, `elevation`, `provider: open-meteo`, `matched_time` (model hour matched), `observation_time`, `retrieved_at`, `precipitation_units`.

Freshness is computed at read time (FRESH ≤3 h, AGING ≤12 h, STALE ≤24 h, EXPIRED >24 h). Stale/expired LIVE signals are **never** selected as authoritative live evidence (selection requires a verified connected-live source + FRESH/AGING).

## Honesty rules

- Data is **modelled/reanalysis-style grid output interpolated to the coordinates — not IMD station telemetry**.
- On failure or outage the source health becomes `DEGRADED` (partial) or `DOWN`/`UNAVAILABLE` (none) — never claimed healthy; `/api/rainfall/live-status` and `/api/sources` expose real success/fail/rate-limit state; `/api/data/health` reports `DEGRADED` while official sources are unconfigured.
- Nothing is fabricated on failure: no synthetic `LIVE` rows; the pipeline keeps prior signals (subject to freshness rules) and falls back to clearly-labelled `SIMULATED` data during scoring.
- IMD/CWC/I&CAD remain `NOT_CONFIGURED`/`UNAVAILABLE` (Epic 2+ only, credential-gated).

## District coverage (all 33) — approximate point coverage

Each row is one coordinate point (district metadata centre), not an areal average. Grid values may differ from a station reading within the district, particularly in large or elevation-variable districts (e.g., Nirmal escarpment, Bhadradri Kothagudem floodplain). Treat as **indicative model rainfall**, not a district-wide measured total.

| District | coordinates |
|---|---|
| Hyderabad | 17.3850, 78.4867 |
| Warangal | 17.9689, 79.5941 |
| Nirmal | 19.0964, 78.3430 |
| Mancherial | 18.8679, 79.4639 |
| Bhadradri Kothagudem | 17.5550, 80.6190 |
| Adilabad | 19.6641, 78.5320 |
| Hanumakonda | 18.0000, 79.5800 |
| Jagtial | 18.7946, 78.9126 |
| Jangaon | 17.7250, 79.1833 |
| Jayashankar Bhupalpally | 18.4319, 79.8636 |
| Jogulamba Gadwal | 16.2300, 77.8000 |
| Kamareddy | 18.3200, 78.3400 |
| Karimnagar | 18.4386, 79.1288 |
| Khammam | 17.2473, 80.1514 |
| Kumuram Bheem Asifabad | 19.3639, 79.2889 |
| Mahabubabad | 17.5986, 80.0039 |
| Mahabubnagar | 16.7488, 77.9856 |
| Medak | 18.0461, 78.2611 |
| Medchal-Malkajgiri | 17.6297, 78.4814 |
| Mulugu | 18.1928, 79.9392 |
| Nagarkurnool | 16.4853, 78.3333 |
| Nalgonda | 17.0577, 79.2684 |
| Narayanpet | 16.7400, 77.5000 |
| Nizamabad | 18.6725, 78.0941 |
| Peddapalli | 18.6167, 79.3833 |
| Rajanna Sircilla | 18.3847, 78.8356 |
| Ranga Reddy | 17.3000, 78.4000 |
| Sangareddy | 17.6194, 78.0811 |
| Siddipet | 18.1019, 78.8520 |
| Suryapet | 17.1400, 79.6200 |
| Vikarabad | 17.3367, 77.9047 |
| Wanaparthy | 16.3622, 78.0622 |
| Yadadri Bhuvanagiri | 17.5108, 78.8894 |

## Missing-data handling

| Situation | Behaviour |
|---|---|
| HTTP 429 / 5xx / timeout / network | Bounded retries → failure; health DEGRADED/DOWN; no fabricated values |
| Partial batch failure | Successful districts ingest; failures listed in `live-status.last_errors`; health DEGRADED |
| Total outage | health `DOWN`, `currentMode = UNAVAILABLE`; scoring falls back to labelled SIMULATED inputs |
| Stale retained signal | Freshness EXPIRED/STALE; excluded from live selection |
| Repeated refresh within 20 min | Duplicate suppressed; no new row; response flags `deduplicated` (or `from_cache`) |

## Verification

- `npm run test:open-meteo` — 9 offline tests with mocked HTTP (success, duplicate suppression, retry on 5xx, 429 rate-limit state, timeout, network failure, stale freshness, unconfigured-source honesty). **No real external requests in tests.**
- Real single-cycle smoke (temp DB copy, not DEV): 33/33 districts updated, 0 failures, cache 33, Open-Meteo registry `LIVE/HEALTHY/CONNECTED`.
