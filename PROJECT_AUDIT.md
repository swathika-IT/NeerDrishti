# NeerDrishti — Project Audit

> **Update 2026-11-21 (round 2):** fixed since this audit was written: D7 (map now has polygon support + local fallback; the boundary file itself is still needed), HTTP-403/key-required tiles, `Unexpected token '<'` API errors, simulator/idempotency, data-pipeline code. Still open: D2/D3/D4 (real flood-history/terrain/drainage datasets), live-data verification, reservoir identity. See IMPLEMENTATION_REPORT.md and PENDING_VS_CODE_WORK.md. Test total is now 182.


Audit date: 2026-11-20 · Baseline: `NeerDrishti_Final_Handover_2026-11-06.zip` · Environment: Node 22, sandbox **without outbound internet** (only package registries/GitHub), so live Open-Meteo/IMD/CWC calls could **not** be exercised. Everything marked *verified* was run; everything else is stated as such.

## 1. Verified baseline (before my changes)
| Check | Result |
|---|---|
| `npm ci` | OK, 0 vulnerabilities |
| `npm run lint` (tsc) | OK |
| `npm run build` | OK (but single 1,734 KB JS bundle) |
| 10 test suites | 124/124 pass **only after** the fresh-DB bug below was fixed; 6 suites fail on a clean checkout |
| RBAC | `/api/notifications`, `/api/admin/users` return 401 unauthenticated (verified) |

## 2. Defects found (and status)
| # | Severity | Finding | Status |
|---|---|---|---|
| D1 | **Critical (security)** | `.env.example` contained a real-looking Gmail address and a 16-char Google App Password. Handover guide claimed "placeholders only". | **Sanitized in this delivery. You must revoke/rotate that App Password and check Git history of `ykavya613/NeerDrishti_login`.** |
| D2 | **Critical (data)** | Only 5 districts have individual history/terrain/drainage values (hard-coded in `server.ts`); 28 districts derive **all three** from one `prototype_vulnerability_score` (×0.95/0.90/0.85). 50% of the score weight for those districts is one number. | Externalised to `data/district_features.json` with per-value provenance; UI/API now label them ESTIMATED/IMPUTED. **Real datasets still needed.** |
| D3 | High (data) | Hard-coded values disagreed with the project's own CSVs (e.g. Hyderabad history 88 vs 80, terrain 75 vs 85, drainage 92 vs 85). | Documented; one source of truth now exists. You decide which is right or replace with datasets. |
| D4 | High (data) | "Historical flood frequency 2015–2025" does not exist in the project (`flood_events_telangana.json` = 639 bytes; `historical_external_signals` = 0 rows). | Open — needs dataset import (see DATA_SOURCES.md). |
| D5 | High | Fresh database could not be created: `initDatabase()` seeded reports before migration 002 and migration 003 ALTERs a table created lazily. The handover's "New local database" steps failed. | **Fixed** (additive; applied migrations untouched). |
| D6 | High (honesty) | Situation Room claimed "Live Telemetry Synced" and "33/33 Districts Synced (Live)" while all data was simulated. | **Fixed** — now computed from real data modes. |
| D7 | High | Risk Map draws centroid circles only; **no district boundary polygons exist**. | Open — needs a verified 33-district boundary file. |
| D8 | Medium | `/api/districts` payload 981 KB uncompressed. | **Fixed**: gzip → 92 KB; `?slim=1` → 15 KB. |
| D9 | Medium | Initial JS bundle 1.7 MB. | **Fixed**: 97 KB entry chunk; views lazy-loaded; no >500 KB chunk. |
| D10 | Medium | Public default scenario is "Heavy Rainfall" (simulated). | Mitigated with a prominent demo-data banner in Simple View. Consider defaulting to "Normal Conditions" for public deployment. |
| D11 | Low | `/api/districts` always returns `is_simulation: true` even if live rainfall is used. | Open (cosmetic; per-district `rainfall_data_mode` is accurate). |
| D12 | Low | Basin connections use `TEL-NIR`-style ids vs `nirmal`-style ids elsewhere. | Open — verify mapping layer. |
| D13 | Info | Open-Meteo "forecast" horizons are tagged `SIMULATED_FORECAST` (heuristic persistence), not an NWP/ML model. No model performance metrics exist. | Documented; none claimed. |

## 3. Module status (8 modules)
Legend: ✅ verified working · 🟡 works, needs improvement · 🔶 partial · ⛔ blocked (data/credentials)

| Module | Status | Evidence / notes |
|---|---|---|
| 1 Home / Situation Room | ✅ (Engineer) / ✅ new Simple View | Screenshot-verified desktop+mobile; labels now truthful. |
| 2 Live Dashboard | 🟡 | Loads; weights now from one config. Not redesigned. |
| 3 Situation Fusion | 🟡 | Loads (code-split). Source freshness exists; deep review pending. |
| 4 Alert Center | 🔶 / ⛔ | 14 notification tests pass in DRY_RUN. **No live WhatsApp/SMS provider is implemented**; live-send is intentionally blocked by env validation. |
| 5 Risk Map | 🔶 | Interactive circles work; **no boundaries (D7)**; no river/basin overlay verified. |
| 6 Data & IoT | 🟡 | Source list honest (SIMULATED/OFFLINE). IoT is simulated. |
| 7 Citizen Reports | ✅ backend (12 tests) / 🟡 UI | Validation, dedupe, rate-limit, moderation exist. Image handling is `image_reference` string validation — verify upload UX. |
| 8 AI Assistant | ✅ + improved | Grounded existing flow + new validated `/api/ai/citizen-brief`. |

## 4. Security review (code-level, not a penetration test)
Present and tested: CSP, HSTS (prod), CORS allow-list, security headers, rate limiting, RBAC middleware, env validation, DB integrity check, backups before migration. Gaps: D1 (secret in repo), JSON body limit 10 MB globally, no virus scanning of uploads, in-memory rate limiter (resets on restart, not shared across instances).

## 5. What I could not verify
Live Open-Meteo/CAP/IMD fetches; Ollama/Groq responses; Telugu/Hindi translation quality (needs a native reader); Render deployment; any real message delivery.
