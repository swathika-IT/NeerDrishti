# API Documentation (additions in this delivery)

Existing endpoints are unchanged; see `server.ts` and `docs/`. Responses are gzip-compressed.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/districts[?slim=1&scenario=…]` | public | District status. `slim=1` omits forecast/situation/alert/hydrology blocks (~15 KB gz). Each district has `feature_provenance`. |
| `GET /api/risk/model` | public | Weights (sum = 1), category cut-offs, IMD rainfall classes. |
| `GET /api/data/completeness[?scenario=…]` | public | 33 × 6 matrix; each cell `{status, provenance, source, score, updated}`; status ∈ OBSERVED/ESTIMATED/IMPUTED/SIMULATED/MISSING. |
| `POST /api/ai/citizen-brief` | public, 30 req/min/IP | Body `{district_id, language: en|te|hi, question?, audience?: "engineer"}`. Returns `{text, source: "llm"|"deterministic", validation, fallback_reason?, context[, engineer]}`. 400 missing id · 404 unknown district · 429 rate-limited. |
| `GET /api/health/ready`, `/api/health/live` | public | Readiness (DB + migrations) / liveness. |

Admin, notification and report endpoints keep their existing RBAC (unauthenticated → 401, verified).

## Added with the data pipeline and simulator
| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/map/config` | public | Basemap config from env (`provider: none` → local fallback). |
| `GET /api/geo/districts` | public | District polygons (`available:false` + empty features until boundaries are loaded). |
| `GET /api/pipeline/registry` · `/api/pipeline/completeness` | public | Dataset registry with stored counts, freshness, last run; 33×7 completeness. |
| `GET /api/telemetry/river[?district=id]` · `/api/telemetry/hydrology-features` | public | Latest river reading per station (`data_status` computed at read time); derived features (rise, rain, groundwater). |
| `GET /api/terrain` | public | DEM-derived district features (`ESTIMATED`). |
| `GET /api/weather/forecast/:districtId` · `/api/weather/history/:districtId?from&to` | public | Stored Open-Meteo forecast / daily history; nulls preserved. |
| `POST /api/notifications/preview` | ADMIN | `{district_id, language, channel, severity?}` → actual risk, severity used, `severity_override`, channel-specific preview (SMS has encoding-aware segments; WhatsApp has none). |
| `POST /api/notifications/simulate` | ADMIN, 20/min | Same body + `contact?`; header `Idempotency-Key` required (8–80 chars). 201 new / 200 `replayed:true`. DRY_RUN only; refuses to run if the dry-run lock is off. |
| `GET /api/notifications/simulations?limit` | ADMIN | Simulation history (`SIM-…` ids). |
| any unknown `/api/*` | public | JSON `404 {error}` (never HTML). |
