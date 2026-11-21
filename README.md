# NeerDrishti — Flood Intelligence for Telangana (33 districts)

> **Prototype for information only. Not an official warning system.** Emergency: **112**.

## What's new (2026-11-20)
- **Simple View / Engineer View** toggle (header). Simple View: district search, SAFE / BE CAREFUL / HIGH FLOOD RISK / EMERGENCY INFORMATION, IMD rainfall thresholds, "why this risk", NOW…+24H outlook, read-aloud, English/Telugu/Hindi.
- **Data Science Playground** (Engineer View): weight explorer, correlation, completeness matrix, lag-analysis status.
- **Honest data labelling**: every static risk input has provenance (DATASET / EXPERT_PRIOR / PROXY_DERIVED); currently *none* come from datasets — see `PROJECT_AUDIT.md`.
- Validated AI brief endpoint with deterministic fallback; gzip + code-splitting; Render blueprint; fresh-DB bootstrap fix.

## Data pipeline & simulator (round 2)
Python ingestion (`scripts/pipeline`, see DATA_INGESTION_GUIDE.md) loads NWDP telemetry, Open-Meteo weather, boundaries and DEM terrain into SQLite (migration 004) with per-row provenance; **nothing has been ingested yet** and nothing is shown as live until it is. Admin-only **Notification Simulator** (Engineer View → Alert Center) previews WhatsApp/SMS/Email and records idempotent DRY_RUN simulations — no message is ever sent. Basemap tiles are configured via `MAP_TILE_URL`; without it the map uses a local fallback.
AI: Llama via local Ollama (default) or any OpenAI-compatible endpoint, always with a deterministic fallback. There is no Gemini dependency.

## Quick start
```
npm ci && cp .env.example .env && npm run bootstrap && npm run dev
```
Tests: `npm run lint && npm test && npm run test:ai && …` (see `TESTING_REPORT.md`).

## Docs
`PROJECT_AUDIT.md` · `IMPLEMENTATION_ROADMAP.md` · `DATA_SOURCES.md` · `API_DOCUMENTATION.md` · `DEPLOYMENT_GUIDE.md` · `TESTING_REPORT.md` · `docs/`

---

# NeerDrishti: AI-Powered Urban Flood Intelligence and Advisory System for Telangana

NeerDrishti (నీర్ దృష్టి) is an AI-powered urban flood intelligence platform for Telangana that combines deterministic mathematical flood-risk scoring (0–100) with LLM reasoning layers, crowdsourced citizen reports, and explainable bilingual advisories (English & Telugu).

---

## 🏛️ System Architecture

```text
Data Sources (Rainfall, Flood History, Location Risk, Drainage, Citizen Reports)
       │
       ▼
Data Processing & Validation (Dynamic 33-District Schema & Data Completeness Engine)
       │
       ▼
Deterministic Flood Risk Engine (Normalized 0–100 Weighted Score)
       │
       ▼
LLM Reasoning & RAG Layer (Hydrological Profiles + Ground Evidence)
       │
       ▼
Bilingual Advisory Engine (English Safety Protocols + Localized Telugu Warnings)
       │
       ▼
Interactive Web Dashboard & Geospatial Map (React + Leaflet + Express)
```

---

## 🗺️ Telangana-Wide Architecture & Monitoring Categories

NeerDrishti scales across all **33 districts of Telangana** with strict data honesty and provenance tracking. It classifies districts into three monitoring tiers:

### 1. Priority Flood Monitoring Districts (5 Districts)
* **Hyderabad, Warangal, Nirmal, Mancherial, Bhadradri Kothagudem**
* **Characteristics:** High urban density / river confluence risk, comprehensive historical context, curated hydrological knowledge bases (`knowledge_base/*.md`), and live telemetry simulation.

### 2. Standard Monitoring Districts (15 Districts)
* **Khammam, Nizamabad, Karimnagar, Nalgonda, Jagtial, Rajanna Sircilla, Peddapalli, Mulugu, Jayashankar Bhupalpally, Komaram Bheem Asifabad, Mahabubnagar, Wanaparthy, Jogulamba Gadwal, Rangareddy, Medchal Malkajgiri**
* **Characteristics:** Seasonal flood risk zones, major river basin drainage points, and verified geography.

### 3. Limited Data Districts (13 Districts)
* **Adilabad, Sangareddy, Siddipet, Medak, Kamareddy, Vikarabad, Jangaon, Mahabubabad, Hanamkonda, Suryapet, Yadadri Bhuvanagiri, Nagarkurnool, Narayanpet**
* **Characteristics:** Prototype baseline scores with explicit data limitation notes and transparent confidence intervals.

---

## 📐 Deterministic Risk Scoring Formula

The risk score is calculated deterministically on a 0–100 scale:

$$\text{Flood Risk Score} = (R \times 0.35) + (H \times 0.25) + (L \times 0.15) + (C \times 0.15) + (D \times 0.10)$$

* **Rainfall Score ($R$, 35%):** 24-hour rainfall input normalized (0–150+ mm).
* **Flood History Score ($H$, 25%):** Historical flood recurrence and basin vulnerability.
* **Location Risk Score ($L$, 15%):** Elevation, terrain, and low-lying depression factor.
* **Citizen Report Score ($C$, 15%):** Crowdsourced verified incident density.
* **Drainage Vulnerability ($D$, 10%):** Nala bottlenecks, urban run-off impedance, and lake overflow susceptibility.

**Risk Classification Tiers:**
* **0–25:** 🟢 **LOW**
* **26–50:** 🟡 **MODERATE**
* **51–75:** 🟠 **HIGH**
* **76–100:** 🔴 **CRITICAL**

---

## 🔒 Data Accuracy & Provenance Rules

1. **No Fabricated Telemetry:** All non-sensor inputs are explicitly marked with `data_provenance` (e.g. `Curated Hydrological Profile`, `Prototype Baseline`).
2. **Data Completeness Metric:** Every district exposes a transparent completeness percentage (0–100%) indicating the availability of real-time vs. baseline parameters.
3. **Transparent Limitations:** Advisories for districts with limited data explicitly acknowledge gaps to prevent false certainty.

---

## 📁 Project Structure

```text
.
├── data/
│   ├── telangana_districts.json  # Central source of truth for all 33 districts
│   └── *.csv                     # Telemetry, sensor, and report data
├── knowledge_base/               # In-depth Markdown profiles for priority districts
├── src/                          # Backend & data processing modules
│   ├── config.py                 # Dynamic district loader & constants
│   ├── data_processor.py         # 33-district data processor & scoring engine
│   ├── risk_engine.py            # Mathematical formula implementation
│   ├── llm_reasoning.py          # LLM prompt orchestration & fallback reasoning
│   └── types.ts                  # Shared TypeScript interfaces
├── src/components/               # React UI Views
│   ├── HomeView.tsx              # Telangana 33-district overview & category filter
│   ├── LiveDashboardView.tsx     # Telemetry dashboard, formula inspector, LLM reasoning
│   ├── RiskMapView.tsx           # Leaflet geospatial risk envelope map
│   ├── CitizenReportView.tsx     # Crowdsourced reporting & AI NLP triage
│   └── AIAssistantView.tsx       # Grounded bilingual chat assistant
├── server.ts                     # Express API server (grounded LLM via Ollama or any OpenAI-compatible endpoint, deterministic fallback)
└── tests/                        # Automated unit and regression tests
```

---

## 🚀 Execution & Development

### Frontend & Node Server
```bash
npm run dev
```

### Run Python Tests
```bash
python3 -m unittest discover tests/
```

## 💾 Database, Migrations & Backups

SQLite (via `node:sqlite`) is the development store. The schema is owned by the TypeScript migrator — never edit the DB by hand.

```bash
npm run migrate   # apply pending migrations (auto-creates a verified backup in backups/ first)
npm run db:backup # create a verified database backup
npm run db:integrity # check SQLite integrity, foreign keys, required tables, counts, and migrations
```

- Migrations live in `migrations/NNN_name.sql` and are tracked in the `schema_migrations` table (with checksums — applied files must not be edited).
- Python DDL is frozen — `src/database.py` no longer creates/alters tables; it fails loudly if the DB is unmigrated.
- **Backups**: `backups/neerdrishti-pre-migration-<timestamp>.db` (VACUUM INTO snapshot, integrity-checked before use). Keep the latest **30** backups plus any pre-deployment backup; prune older ones manually. `backups/` is gitignored — do not commit database copies.
- **Restore**: stop the server → copy the chosen backup over `data/neerdrishti.db` → run `npm run db:integrity` → restart → check `/api/health/live` and `/api/health/ready` → spot-check `/api/districts`.
- A restore drill was previously performed on a temporary copied database; the development database has not been overwritten as part of Epic 6.

Production deployment should evaluate managed PostgreSQL (see DEVELOPMENT_PROGRESS.md); no automatic cutover is performed.

## 🔐 Authentication & Roles (Phase 5)

Roles: **PUBLIC** (no account; dashboards/maps stay open) · **CITIZEN** (self-registration) · **OFFICIAL** (admin-approved, district-scoped) · **ADMIN**.

- Passwords hashed with bcrypt (cost 12). Sessions are server-side rows in SQLite; the browser holds only a random opaque token in an `nd_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production).
- First administrator: on startup with **zero** admins, a one-time setup token is printed **only to the server console**; create the admin via `POST /api/auth/setup-admin`. No default admin or hardcoded password exists. The token is single-use and rotates on restart.
- Email delivery code is present but **disabled** in this environment; no verification or reset email is delivered while `MAIL_DRY_RUN=true`. Set `APP_BASE_URL` to your public HTTPS origin before enabling any future mail flow. Production startup rejects `AUTH_DEV_EXPOSE_TOKENS=true`.
- Protected mutations (scenario/data-mode changes, signal & IoT ingestion, rainfall refresh, alert recalculation, notification dispatch) require **ADMIN**; report/alert moderation requires an approved **OFFICIAL** or **ADMIN** and is jurisdiction-checked. Security-sensitive actions are written to `audit_logs`.
- Login/registration/recovery endpoints are rate limited (in-memory, per-process).
- Run security tests: `npm run test:auth` (uses a temporary database copy; never touches `data/neerdrishti.db`).

## 📝 Citizen Reporting & Moderation (Phase 6)

- Lifecycle: **PENDING → UNDER_REVIEW → VERIFIED / REJECTED** (plus RESOLVED). New reports are always server-set to **PENDING**; clients cannot submit a status.
- **Anonymous submission remains supported** for backward compatibility and is IP rate limited (`REPORT_RATE_LIMIT_MAX`/hour). Authenticated citizens are additionally limited per account (`REPORT_RATE_LIMIT_USER_MAX`/hour) and linked via `reporter_user_id` from the session — never from the request body.
- Server-side validation: canonical Telangana district IDs (via the district normalizer), canonical categories (Urban Flooding, Waterlogging, Blocked Drainage, Rising Water Levels, Road Flooding, Lakes or Canals Overflow, Other), severity, description length, optional Telangana-bounded coordinates, and recent ISO timestamps. Privileged fields (`id`, `status`, `reporter_user_id`, …) in a payload are rejected.
- Attachments: only PNG/JPEG/WEBP data URIs (≤2 MB) or `https` URLs. SVG, `javascript:`/`data:text/html`, path traversal and executable payloads are rejected; metadata is recorded in `report_attachments`. **No image content analysis exists** — classification never claims "verified visual" and image presence never raises confidence.
- Moderation: only approved OFFICIALs (within their assigned jurisdictions) or ADMINs may change status. Every change is written to `report_moderation_history` (actor, timestamp, from/to status, reason) and `audit_logs`. History is exposed via `GET /api/reports/:id/history`.
- **Risk engine**: only **VERIFIED** reports contribute to the citizen-report term of the flood-risk formula (unchanged weights/thresholds). PENDING/UNDER_REVIEW/REJECTED reports remain visible to moderators and in listings but score zero. Each district summary exposes `verified_reports`, `unverified_reports` and `scoring_basis: "VERIFIED_ONLY"`.
- Run reporting tests: `npm run test:reports`.

## 🧪 Phase 8 Status, Validation & Demo Readiness (Epics 0–7)

Phase 8 added:

- Epic 0: baseline and event-label specification
- Epic 1: Open-Meteo modelled grid rainfall hardening
- Epic 2: data reliability/provenance and honest source registry
- Epic 3: NWDP/IMD historical rainfall import (licence UNVERIFIED)
- Epic 4: IMD/SACHET CAP official-warning ingestion and display (not added to risk scoring)
- Epic 5: notification pipeline in **DRY_RUN only**
- Epic 6: production hardening (security headers/CSP, CORS, env validation, probes, logging, backup/integrity, graceful shutdown)
- Epic 7: validation audit, Epic 0–7 verification documentation, and a role-based demo runbook
- Authentication email foundation: verification/reset templates and SMTP plumbing implemented, live delivery disabled by `MAIL_DRY_RUN=true` and `LIVE_SEND_IMPLEMENTED=false`

Runbook: [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md)

Current verification:

- **123/123 tests pass, 0 failures** (includes Gmail SMTP mailer mock tests)
- `npm run lint` PASS
- `npm run build` PASS
- `npm run db:integrity` PASS — `integrity_check=ok`, `foreign_key_check=[]`
- 33/33 Telangana districts available
- Historical records remain intact: **2,508**
- Forecast validation and event readiness remain **NOT READY**; no accuracy metrics are claimed

### Data-source integration status

Operational: Open-Meteo (modelled grid rainfall, non-commercial CC BY 4.0; not official station telemetry); SACHET CAP public feeds; IMD CAP public index; local SIMULATED scenarios.

Not integrated / unavailable: IMD AWS API, CWC gauges, Telangana I&CAD reservoirs, ERA5/CDS, NRSC/Bhuvan imagery. They are intentionally shown as unavailable/not configured.

### Staging deployment prerequisites

Staging is **not deployed or approved**. Before staging:

1. Choose a production database target; SQLite is not sufficient for multi-user production. Evaluate managed PostgreSQL with backups, PITR, and credentials.
2. Establish migration rehearsal and rollback plan on staging using copied data; do not migrate production first.
3. Obtain and verify official credentials/approvals for any claimed IMD/CWC/I&CAD feeds; never label them live before integration and validation.
4. Configure TLS/reverse proxy, secure cookies, production domain, and HSTS only when serving HTTPS.
5. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, restrictive `CORS_ALLOWED_ORIGINS`, and verify `npm run db:integrity` and readiness probes after deployment.
6. Configure secret management, least-privilege service accounts, and no default/admin credentials.
7. Set up centralized logging, monitoring, alerting, and an incident runbook; do not expose logs containing secrets or PII.
8. Complete DLT/SMS/WhatsApp/email compliance and enable live notifications only under separate approval and tested rollback; current build cannot send live messages.
9. Complete licence verification for historical data and obtain permission before any redistribution or production claim.
10. Obtain human sign-off from operations, security, and emergency-management stakeholders; do not present the system as an official warning or replacement for government channels.

## 📈 Forecast Reliability & Backtesting (Phase 7)

**No backtest has been performed, and no forecast accuracy is claimed.** The repository contains no multi-year, district-level, labeled rainfall→flood time series (see `npx tsx scripts/forecast_validation_report.ts` for the full audit). Consequently:

- All forecast outputs are `SIMULATED_FORECAST` decision-support projections built on transparent persistence heuristics.
- `SIMULATED`, `HISTORICAL` and unverified inputs are never promoted to `LIVE` evidence; confidence levels are capped for simulated inputs, and `LIVE_FORECAST` is not emitted by the app.
- The 132 rows in `forecast_snapshots` were generated by a since-fixed field-contract bug (`current_risk_score = 0` for every row) and are preserved for audit but **unusable as evidence of accuracy**.
- Genuine validation requires: multi-year district-wise daily rainfall (e.g. IMD district-wise CSV openly downloadable at the National Water Data Portal, updated 2026-10-31) plus a labeled Telangana flood-event catalog. Until both are imported, `MAE/RMSE/precision/recall/false-alarm rate` cannot be computed.
- Run offline audit anytime: `npm run report:validation`. Run reliability tests: `npm run test:forecast`.

