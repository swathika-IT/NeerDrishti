# Testing Report — 2026-11-21 (sandbox: Node 22, Python 3.12, Chromium via Playwright, **no outbound internet**)

| Suite | Tests | Result |
|---|---:|---|
| `npm test` (risk engine) | 13 | pass |
| `npm run test:ai` (brief validator, IMD classes, feature store, API JSON contract, SMS segmentation/preview) | 24 | pass |
| `npm run test:sim` (HTTP: notification simulator, idempotency, RBAC, JSON 404s, fresh-DB pipeline endpoints, **Python→SQLite→API contract**) | 10 | pass |
| `test:auth` / `reports` / `forecast` / `open-meteo` / `cap` / `notifications` / `email` / `historical` | 14 / 12 / 12 / 9 / 11 / 14 / 10 / 10 | pass |
| `test:hardening` (CSP updated: no third-party tile host by default; map config) | 20 | pass |
| `npm run test:py` (pytest: normaliser, CKAN paging/HTML rejection, schema discovery, zero-vs-missing, idempotent re-run, river rise on irregular intervals, Open-Meteo parsing, boundaries, slope, DEM→terrain) | 23 | pass |
| **Total** | **182** | **182 pass** |

Also run: `tsc --noEmit` clean; `npm run build` OK; `npm run migrate` on a populated DB (3→4, 5 existing reports preserved, backup written); `db:integrity` ok / 0 FK violations; production boot on an empty DB via `npm start`.

Real defects found by testing (and fixed): (1) fresh-DB bootstrap failure; (2) unknown `/api/*` routes returned HTML (root cause of the `Unexpected token '<'` error); (3) unknown district returned 400 instead of 404; (4) NWDP field matcher mapped `river` to the water-level column — found only by the cross-language contract test; (5) pysheds incompatible with NumPy 2 (shim added).

Browser (Chromium, 1280–1440 px and 390 px): Simple/Engineer views, district search, Playground, Alert Center simulator on 3 channels, **double-click → exactly 1 POST**, Telugu SMS → UCS-2, Risk Map with no tile provider shows district markers + fallback notice and makes no external tile requests (no 403 or error tiles).

**NOT tested / not possible here:** any live call to Open-Meteo, NWDP, OpenTopography, IMD/CAP; real-DEM terrain processing and real-boundary matching (only synthetic fixtures); LLM output from Ollama/hosted models; real WhatsApp/SMS/email delivery (never attempted — dry-run lock intact); Render deployment; map with an actual tile provider; screen readers; Safari/Firefox; load/performance tests. Synthetic fixtures verify logic, not data.
