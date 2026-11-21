# Phase 8 — Epic 0 Baseline & Event Label Specification

Generated 2026-11-04. No application code, configuration, database content or migrations were changed for this document. All values below were measured on the DEV copy of `data/neerdrishti.db`.

## 1. Baseline metrics (before Epic 1)

### 1.1 Test results (all against current `dist/` build + tsx)

| Suite | Command | Result |
|---|---|---|
| Risk/forecast regression | `npm test` | 13/13 PASS |
| Auth & RBAC security | `npm run test:auth` | 13/13 PASS |
| Report validation/moderation | `npm run test:reports` | 12/12 PASS |
| Forecast validation | `npm run test:forecast` | 12/12 PASS |
| TypeScript lint | `npm run lint` | PASS (tsc --noEmit) |
| Production build | `npm run build` | PASS (`dist/server.cjs` ~469 kB) |
| Python tests | — | **NOT RUN — no working interpreter** (`python`, `py` are unusable Windows Store aliases on this machine) |

### 1.2 Database backup & verification

- Backup: `backups/neerdrishti-pre-migration-2026-11-04T09-11-48-266Z.db`
- Method: `VACUUM INTO` + `PRAGMA integrity_check` → **ok**
- DEV database sha256 (before any Phase 8 Epic changes): `187860E2851E57353965EB95804CB0673B087B8544C3AC20D8ECA0F17C518B04`
- Backup sha256: `CDD62D650D4340BC73263C3B9C0834DB7F558ADF86CAE2FC23AC4026B55A4452`
- Row counts (authoritative baseline):

| Table | Rows | Table | Rows |
|---|---|---|---|
| districts | 33 | external_signals | 338 |
| citizen_reports | 5 | hydrological_stations | 33 |
| report_classification | 5 | forecast_snapshots | 132 (all flagged invalid artefacts, preserved) |
| report_moderation_history | 5 | alerts_history / notification_history | 0 / 0 |
| users / sessions / audit_logs | 0 / 0 / 0 | schema_migrations | 3 |

- `PRAGMA integrity_check` = ok; `PRAGMA foreign_key_check` = clean; `journal_mode = wal`.

### 1.3 Source health snapshot

| Source | Mode | Health | Integration |
|---|---|---|---|
| Open-Meteo | LIVE | HEALTHY | CONNECTED (only live source; CC BY 4.0 attribution required) |
| IMD AWS | UNAVAILABLE | UNAVAILABLE | NOT_CONFIGURED (HTTP 401 without credentials) |
| Historical archives (TSDPS/IMD) | HISTORICAL | UNAVAILABLE | MANUAL_VERIFICATION (NWDP CSV open, not imported) |
| CWC / I&CAD | UNAVAILABLE | UNAVAILABLE | NOT_CONFIGURED (no self-serve API) |
| Simulation engine | SIMULATED | HEALTHY | LOCAL_ENGINE |

- `system_health = DEGRADED` (2 official sources offline — reported honestly), `active_mode = SIMULATION`, 17 virtual devices (17 online).
- `/api/health` = ok; `database = SQLite (data/neerdrishti.db)`; `/api/districts` = 33 districts; `llm_provider = Meta Llama (OpenAI-Compatible)`, model `llama3.2:3b`.
- Server startup runs the scheduled Open-Meteo refresh (`startScheduledRefresh`) — **external_signals grows +33 per server start** (338 → 371 after one smoke start). Additive real Open-Meteo LIVE rows; nothing deleted.

### 1.4 Known limitations (unchanged)

- No IMD/CWC/I&CAD integration (credentials/approvals required).
- Forecasts are heuristic; zero measured accuracy; 132 seeded snapshots are invalid artefacts.
- Hydrology is simulated fallback; notifications are prototype/mock; email delivery not configured.
- Citizen reports influence risk only when VERIFIED; risk formula unchanged (0.35/0.25/0.15/0.15/0.10).
- Python suite cannot run on this machine. No Docker/Postgres/deployment validated.

---

## 2. Historical flood-event label-file format

**File:** `data/flood_events_telangana.json` (to be created in Epic 3 by manual curation; does NOT exist yet — any values below are illustrative, not real events).

### 2.1 Top-level provenance block (mandatory)

```json
{
  "dataset_provenance": {
    "created_by": "name or team",
    "created_on": "ISO-8601 date",
    "updated_at": "ISO-8601 date",
    "method": "hand-curated from institutional sources",
    "sources": [
      {
        "title": "string",
        "publisher": "Telangana SDMA | IMD | GHMC | Academic journal | ...",
        "url": "https://...",
        "accessed_on": "YYYY-MM-DD",
        "licence": "stated source licence, if known, else 'unknown — not redistributable without permission'"
      }
    ],
    "licence_note": "Source-specific licence applies per evidence item. Compilation is for internal research/backtesting."
  },
  "events": [ ... ]
}
```

### 2.2 Event object (required fields)

| Field | Type | Rule |
|---|---|---|
| `event_id` | string | Unique `TELANGANA-<onsetYear>-<districtId>-<seq>` |
| `district_id` | string | Must normalise via `district_normalizer` to one of the 33 canonical IDs. Unmapped → **rejected**, never guessed. |
| `onset_date` | `YYYY-MM-DD` | Required; ISO date. |
| `end_date` | `YYYY-MM-DD` | Optional; must be ≥ onset_date. |
| `event_type` | enum | `URBAN_FLOODING \| WATERLOGGING \| RIVER_OVERFLOW \| RESERVOIR_RELEASE \| CYCLONE_RAIN \| OTHER` |
| `peak_rainfall_mm_24h` | number \| null | `null` when not published — **never estimated**. |
| `affected_localities` | string[] | Free text, 1..20. |
| `severity` | enum | `LOW \| MODERATE \| HIGH \| CRITICAL` — documented rationale in `notes` |
| `outcome_label` | enum | `FLOOD_EVENT` \| `NEAR_MISS` \| `FALSE_ALARM` (used as dependent variable for backtesting) |
| `evidence` | array (1..10) | Each item: `{ type: 'IMD_BULLETIN' \| 'SDMA_REPORT' \| 'LOCAL_AUTHORITY' \| 'NEWS' \| 'ACADEMIC', title, url_or_reference, date }` |
| `verified_by` | string | Curator name(s). |
| `notes` | string | Includes severity rationale and data caveats. |

### 2.3 Provenance / attribution rules (mandatory)

1. Every event MUST cite **≥1 institutional source** (IMD / Telangana SDMA / state irrigation department) OR **≥2 independent secondary sources** (news/academic).
2. Every evidence item carries publisher + URL (or archival reference) + access date.
3. Numeric values are `null` where unknown; **fabrication is a defect, not an approximation**.
4. The file must record `created_by`, `created_on`, `updated_at`, `sources[]`, and per-source licence statements.
5. Compiled labels are for **backtesting and demonstration only**; any external use requires licence clearance.
6. Minimum viable for backtesting: **≥3 verified events in each of the 5 priority districts** (Hyderabad, Warangal, Nirmal, Mancherial, Bhadradri Kothagudem).

### 2.4 Validation rules (enforced later by Epic 3 ETL)

- `district_id` resolves to canonical Telangana ID (case-insensitive).
- `onset_date` / `end_date` are valid ISO dates; `end_date ≥ onset_date`.
- `outcome_label` ∈ `{FLOOD_EVENT, NEAR_MISS, FALSE_ALARM}`.
- `severity` ∈ `{LOW, MODERATE, HIGH, CRITICAL}`.
- No duplicate `(district_id, onset_date)` pairs (last writer wins only with explicit `--overwrite-events` flag; default: error).
- Every event has ≥1 evidence item with a working URL/reference string.

---

## 3. Epic 0 external-credentials checklist (user-owned)

- [ ] IMD account on `api.imd.gov.in` — register with `gov.in` / `nic.in` email (or nodal-officer letter).
      Contact listed on portal: `sankar.nath@imd.gov.in`, `kavita.navria@imd.gov.in`.
      Required: X-API-KEY (DEV + PROD), JWT (`POST /api/oauth/token.php`), static public IP for the deployment server, written non-commercial licence confirmation.
- [ ] NWDP district-wise IMD rainfall CSV — downloadable, but **licence UNVERIFIED**: the resource page states "No License Provided" (see `docs/NWDP_LICENCE_VERIFICATION.md`). Internal research/demonstration use only; written permission needed before redistribution.
- [ ] Copernicus CDS account (free) — only if ERA5-Land gaps need filling.
- [ ] SMTP provider account (dev: MailHog/Mailtrap). SMS: DLT sender ID + templates (Epic 5). WhatsApp Business approval (Epic 5).
- [ ] Secrets storage location agreed (never the repository).

Nothing in the repository will hold a credential. Every credential-gated feature stays `NOT_CONFIGURED` until Epic 2/5 are explicitly executed with user approvals.
