# Historical Rainfall & Flood-Event Data Coverage (Phase 8 / Epic 3)

Generated 2026-11-04. Imported into the DEV database via the offline pipeline only (no live fetching in the app). Risk formula, weights and thresholds unchanged; LIVE/FORECAST/BASELINE/SIMULATED data untouched.

## Source register

| Field | Value |
|---|---|
| Dataset | IMD District-wise Daily Rainfall (via NWDP) — `Rainfall DistrictWise Daily IMD CSV` |
| Publisher | National Water Data Portal (NWIC), Ministry of Jal Shakti, Govt. of India / India Meteorological Department |
| Original URL | https://nwdp.nwic.gov.in/dataset/rainfall-daily-imd |
| Download resource | .../resource/8752174f-1d17-4aaf-8058-2eb396f50157/download |
| Access date | 2026-11-04 |
| File | 9,096,886 bytes (8.68 MB), sha256 `05f43a430d4c12eb634976aa984b7a104493fbbf2d03f6f9ac2c9bbb0a2022b3` |
| Licence | **UNVERIFIED — the NWDP resource page states "No License Provided"; GODL/NDSAP is NOT confirmed.** See `docs/NWDP_LICENCE_VERIFICATION.md`. Attribution recorded; internal research/demonstration use only; obtain written permission before redistribution. |
| Units | `Daily Actual` in **mm/day**; `Daily Normal` mm/day; `Daily Category` IMD code (e.g. LD/NR) |
| Date coverage obtained | 2026-08-19 → 2026-11-03 (76 days, rolling window; NOT a multi-year archive) |
| Geographic coverage | All-India file; **Telangana slice imported: 33/33 districts, 2,508 rows** |
| Stored as | `external_signals` rows, `data_mode='HISTORICAL'`, `source_name='NWDP IMD District-wise Daily Rainfall (GODL-India)'` (**legacy identifier — the `(GODL-India)` token is a label only and does NOT assert a licence**), `signal_type='rainfall'`, `unit='mm'`, `recorded_at='<date>T12:00:00.000Z'`, confidence 0.8(archive) |
| Metadata per row | dataset, publisher, source_url, licence (pre-verification legacy string on the 2,508 Epic-3 rows), licence_status (future imports = UNVERIFIED), accessed_on, original_district, original_state, district_mapping (direct/alias), unit, daily_normal_mm, daily_category |

## District mapping

- Canonical resolution via `district_normalizer`; unresolved rows are **rejected, never guessed**.
- Publisher abbreviations resolve through an explicit, auditable alias table (6 entries, verified against the NWDP Telangana list, 2026-11-04):

| Publisher name | Canonical ID | Rows |
|---|---|---|
| B. KOTHAGUDEM | bhadradri_kothagudem | 76 |
| J. BHUPALPALLY | jayashankar_bhupalpally | 76 |
| KUMARAM BHEEM | kumuram_bheem_asifabad | 76 |
| M. MALKAJGIRI | medchal_malkajgiri | 76 |
| PEDDAPALLE | peddapalli | 76 |
| Y. BHUVANAGIRI | yadadri_bhuvanagiri | 76 |

All other Telangana districts matched directly. Mapping type is stored per row (`district_mapping`).

## Coverage by district (all 33) — 76 days each (2026-08-19 → 2026-11-03)

| District | Rows | Date range | District | Rows | Date range |
|---|---|---|---|---|---|
| adilabad | 76 | 2026-08-19 → 2026-11-03 | nagarkurnool | 76 | 2026-08-19 → 2026-11-03 |
| bhadradri_kothagudem | 76 | " | nalgonda | 76 | " |
| hanumakonda | 76 | " | narayanpet | 76 | " |
| hyderabad | 76 | " | nirmal | 76 | " |
| jagtial | 76 | " | nizamabad | 76 | " |
| jangaon | 76 | " | peddapalli | 76 | " |
| jayashankar_bhupalpally | 76 | " | rajanna_sircilla | 76 | " |
| jogulamba_gadwal | 76 | " | ranga_reddy | 76 | " |
| kamareddy | 76 | " | sangareddy | 76 | " |
| karimnagar | 76 | " | siddipet | 76 | " |
| khammam | 76 | " | suryapet | 76 | " |
| kumuram_bheem_asifabad | 76 | " | vikarabad | 76 | " |
| mahabubabad | 76 | " | wanaparthy | 76 | " |
| mahabubnagar | 76 | " | warangal | 76 | " |
| mancherial | 76 | " | medak | 76 | " |
| medchal_malkajgiri | 76 | " | mulugu | 76 | " |
| yadadri_bhuvanagiri | 76 | " | | | |

**Total imported: 2,508 HISTORICAL rows.** Missing values (`ND`/`NA`) were skipped and counted — never written as 0. Duplicate (district, date) rows are rejected and re-imports insert nothing (idempotent, verified).

## Flood-event labels

- Specification: `docs/PHASE8_BASELINE_AND_EVENT_LABELS.md`.
- File: `data/flood_events_telangana.json` — currently **0 events** (honest template; no fabricated events). Validator: `npm run validate:events`.
- Backtest readiness: **NOT READY** — 0/3 verified events required in each of the 5 priority districts.

## Gaps and limitations

0. **Licence UNVERIFIED (2026-11-04):** the NWDP resource page explicitly states "No License Provided"; GODL/NDSAP was assumed in error and is not confirmed. Do not represent this dataset as openly licensed or redistribute it without written permission. See `docs/NWDP_LICENCE_VERIFICATION.md`. The 2,508 imported rows are preserved unmodified; their metadata stores the pre-verification licence string as a legacy value.
1. **No multi-year archive**: the NWDP daily dataset is a rolling ~11-week window. Multi-year daily rainfall (≥10 years) is required for time-based backtesting and is **not yet obtained**.
2. **No labeled flood events**: the event catalogue requires manual curation from IMD bulletins / Telangana SDMA reports (no automatic source exists). Until then, no MAE/RMSE/precision/recall/false-alarm claims are possible.
3. Historical rainfall is stored at district granularity for a single coordinate-free district label; it is not areal-averaged.
4. The pipeline is offline/manual by design (`npm run import:historical -- --file <csv> --apply`); the application does not fetch historical data at runtime.
5. Priority district rainfall intensity available immediately; useful for descriptive context, not for forecast accuracy claims.
