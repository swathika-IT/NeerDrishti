# Implementation Report — round 2 (2026-11-21)

## Scope decision
Two large specifications were supplied. Done and verified: repairs, notification simulator, map fallback, AI cleanup, full data-engineering pipeline *code* with tests. Not possible in this environment: running it against live APIs (no internet), your Python scripts (not attached; rebuilt from your descriptions), the real boundary file/DEM. Everything unverified is listed in PENDING_VS_CODE_WORK.md.

## Changes
| Area | Problem / root cause | Change | Files |
|---|---|---|---|
| AI | `google-genai` still in `requirements.txt`; stale Gemini mentions | removed; the only AI client is OpenAI-compatible (Ollama default, any hosted OpenAI-compatible endpoint via env); docs/README aligned | requirements.txt, legacy/*, README.md |
| Registration `Unexpected token '<'` | server answered unknown `/api/*` with `index.html` (prod) / Express HTML 404; client called `res.json()` | `/api` 404 handler + JSON error middleware; `apiFetch` handles HTML/empty/network/invalid JSON; Auth/Account views use it | server.ts, src/lib/api.ts, AuthView, AccountView |
| Map 403 / key-required tiles | hard-coded third-party tile URL | server-driven `MAP_TILE_URL` (https only, CSP derived from it), default local fallback, polygon layer from boundaries, tile-error cap, "Basemap unavailable…" notice, Fit Telangana | src/config/map_config.ts, security.ts, RiskMapView.tsx |
| Notifications | no channel-aware preview, no idempotency | `preview.ts` (WhatsApp char count only; SMS GSM-7/UCS-2 segments; email subject/body), `/preview` `/simulate` `/simulations`, DB idempotency keys, masked contact, IST display, dry-run guard, read-only duplicate audit script | preview.ts, server.ts, NotificationSimulator.tsx, migration 004 |
| Data pipeline | none in app | migration 004 (12 tables + idempotency), `scripts/pipeline/*` (CKAN client, schema discovery, Open-Meteo, features, boundaries, DEM terrain, CLI), read APIs, status panel | migrations/004, scripts/pipeline, src/services/pipeline_data.ts, PipelineStatusPanel.tsx |
| Bug found by tests | NWDP `river` field mapped to the level column | exact/shortest-name matching + regression test | nwdp.py |

## Not changed (by design)
Five-factor weights; `NOTIFICATION_DRY_RUN=true` / `LIVE_SEND_ENABLED=false`; RBAC, bcrypt, HttpOnly sessions; existing migrations 001–003.

## Known limitations
Pipeline untested on live data; Open-Meteo archive model identity unconfirmed; NWDP timestamps assumed IST; reservoir identity unverified; terrain tested on synthetic DEM; frontend charts for the new telemetry not built; static risk inputs still prototype priors.
