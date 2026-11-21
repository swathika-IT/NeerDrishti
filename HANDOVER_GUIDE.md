# NeerDrishti — Final Handover Guide

**Status:** Handover-ready source package; **not production-ready** and not an official flood-warning system. NeerDrishti is a local integrated prototype and decision-support tool. It does not issue evacuation orders, emergency alerts, or official government warnings.

**Package date:** 2026-11-06

## 1. Project purpose and architecture

NeerDrishti (నీర్ దృష్టి) provides district-level flood-risk decision support for Telangana, India. It combines:

- A React + Vite frontend (`src/`)
- An Express/TypeScript backend (`server.ts`)
- SQLite-based local persistence (`src/db/`)
- A deterministic 0–100 risk formula:
  `(R × 0.35) + (H × 0.25) + (L × 0.15) + (C × 0.15) + (D × 0.10)`
- Citizen reports, official moderation, and verified-only contribution to risk scoring
- Open-Meteo modelled grid rainfall, historical NWDP/IMD rainfall, and IMD/SACHET CAP official-warning feeds
- SIMULATED local scenarios clearly labelled as synthetic
- Authentication, RBAC, official jurisdictions, audit logs, and a DRY_RUN-only notification pipeline

Primary runtime path:

```text
React UI → Express API → SQLite → ingestion/provenance services → risk projection → map/dashboard/alerts
```

## 2. Prerequisites and supported versions

Verified environment:

- Node.js **v24.14.0**
- npm **11.9.0**

Recommended compatibility:

- Use Node.js **22.5+** or newer because the project uses `node:sqlite`.
- Windows PowerShell commands below are the reference commands.
- No Python installation is required for the Node application or Node test suite.
- No database server is required for local development; SQLite is used.

Not included and not required:

- Docker
- PostgreSQL server
- Cloud credentials

## 3. Installation commands

From the project root:

```powershell
npm ci
```

If `npm ci` is unavailable because the lockfile changed locally, use:

```powershell
npm install
```

Do not install global packages globally without review. The app intentionally uses no external notification provider package for live delivery.

## 4. Environment setup using `.env.example`

Create a local environment file:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` locally. Do not commit it. Important keys:

| Key | Safe default / instruction |
|---|---|
| `NODE_ENV` | `development` for local use; `production` only on an approved deployment target |
| `PORT` | `3000` by default; another port is allowed |
| `DATABASE_PATH` | `data/neerdrishti.db` |
| `APP_BASE_URL` | Must match the public origin, e.g. `http://localhost:3000` locally or your approved HTTPS origin in deployment |
| `MAIL_DRY_RUN` | Keep `true` in this release |
| `NOTIFICATION_LIVE_SEND_ENABLED` | Keep `false` |
| `SMS_ENABLED`, `WHATSAPP_ENABLED` | Keep `false` |
| `AUTH_DEV_EXPOSE_TOKENS` | Keep `false`; production refuses `true` |
| `CORS_ALLOWED_ORIGINS` | Empty = same-origin only; otherwise exact HTTPS origins |
| `SECURITY_HSTS_ENABLED` | Enable only behind HTTPS/TLS |
| `IMD_API_KEY` | Required only for IMD AWS integration; app works without it |
| `OPEN_METEO_*` | Safe public defaults; Open-Meteo is not official telemetry |

The supplied `.env.example` contains placeholders only. No recipient, token, password, API key, or real mailbox is included by this package.

## 5. Database initialization

No database file is included. You must create one locally.

The project initializes the base schema and seed data through `initDatabase()` and applies incremental migrations through `npm run migrate`. The order matters: create the base schema first, then migrate.

### New local database

```powershell
# Load .env safely and create baseline tables + seed data.
npx tsx -e "import 'dotenv/config'; import { initDatabase } from './src/db/sqlite'; initDatabase();"

# Apply identity/access/notification migration files 001-003.
npm run migrate

# Verify the resulting database.
npm run db:integrity
```

Expected verification:

- `integrity_check=ok`
- `foreign_key_check=[]`
- `missing_tables=[]`
- migrations `001_identity_access.sql`, `002_reports_canonicalization.sql`, `003_signals_notifications_integrity.sql`
- 33 districts available
- 2,508 historical signal rows if the import path is used from the bundled seed set; this package does not overwrite that provenance.

### Existing database

Back up before any initialization or migration:

```powershell
npm run db:backup -- --tag pre-handoff
```

Then use the same `initDatabase()` + `npm run migrate` sequence and verify:

```powershell
npm run db:integrity
```

Never restore or overwrite a database without an approved backup and documented rollback.

## 6. Local startup instructions

Start the development server:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

For a clean production-style local check:

```powershell
npm run build
npm start
```

Health endpoints:

```text
GET /api/health/live
GET /api/health/ready
```

Expected: HTTP 200; readiness must report database and migrations as `ok`.

## 7. Test, lint and build commands

```powershell
npm test
npm run test:auth
npm run test:reports
npm run test:forecast
npm run test:open-meteo
npm run test:cap
npm run test:historical
npm run test:notifications
npm run test:hardening
npm run test:email
npm run lint
npm run build
npm run report:validation
npm run validate:events
npm run db:integrity
```

Verified results for this package:

- **124/124 tests pass, 0 fail**
- `npm run lint` PASS
- Build PASS; `dist/server.cjs` **562.0 kB**; existing frontend chunk-size warning only
- Database integrity PASS; foreign-key check clean
- Forecast validation/backtesting: **NOT READY**; no accuracy metrics claimed

## 8. Demo sequence

Use the detailed script in `docs/DEMO_RUNBOOK.md`.

Recommended short sequence:

1. Open the Home dashboard and state the SIMULATED/prototype limitation.
2. Switch to **Heavy Rainfall**, then **Flood Warning**, then **Critical Flood Event** using the demo mode.
3. Open **Situation Fusion** and **Alert Center**; show LIVE/HISTORICAL/FORECAST/BASELINE/SIMULATED distinctions.
4. Open **Risk Map** and the 33-district overview.
5. Open **Data & IoT** and show honest source status:
   - Open-Meteo connected but modelled grid rainfall
   - IMD/CWC/I&CAD not integrated
   - CAP feeds as FORECAST data
6. Submit a demo citizen report and show it is `PENDING` and does not affect risk scoring.
7. Approve an Official and show jurisdiction-limited moderation.
8. Change the report to `VERIFIED` and show the VERIFIED-only scoring effect.
9. Show Admin console/audit logs and notification DRY_RUN configuration.
10. Close with security, licensing and validation limitations.

## 9. Roles and access permissions

| Role | Access |
|---|---|
| PUBLIC | Dashboard, map, public alerts and source-status views; no account |
| CITIZEN | Registration/login, submit/manage own reports, request official role |
| OFFICIAL | Requires admin approval and assigned Telangana district; can moderate in-jurisdiction reports |
| ADMIN | User management, role approvals, jurisdiction assignment, audit logs, notification configuration/dry-run |

Important:

- Public users cannot read notification history or statistics.
- Official access requires both role approval and district jurisdiction.
- Admins cannot suspend their own account.
- Administrative setup is token-gated and console-only when no admin exists.

## 10. Data provenance and risk-score limitations

- Risk outputs are **SIMULATED_FORECAST decision support**, not measured predictions or official warnings.
- Forecasts are heuristic persistence projections; no MAE/RMSE/precision/recall or false-alarm rate is claimed.
- The archived 132 forecast snapshots were generated by a previously fixed field-contract defect and are unusable as accuracy evidence.
- Open-Meteo is modelled grid rainfall under CC BY 4.0 and is **not** official IMD station telemetry.
- Historical NWDP records are 2,508 rows and remain **licence UNVERIFIED** pending permission.
- CAP feeds provide official-warning messages only when available; an empty feed is reported honestly and not fabricated.
- Unverified citizen reports contribute zero to the citizen term; only `VERIFIED` reports score.
- The 33 districts include Priority, Standard and Limited Data tiers; limited-data districts carry explicit provenance warnings.

## 11. Notification DRY_RUN restrictions

This package cannot send live email, SMS or WhatsApp messages.

- `MAIL_DRY_RUN=true` is respected.
- `LIVE_SEND_IMPLEMENTED=false` remains in source.
- `NOTIFICATION_LIVE_SEND_ENABLED=true` is rejected by environment validation.
- SMS/WhatsApp are disabled.
- No notification message reaches a real provider.
- Delivery results are recorded as `DRY_RUN`, never as delivered.

Do not uncheck these gates for demos. Any live delivery requires separate provider approval, compliance review, staging verification, monitoring and rollback.

## 12. Known security and production limitations

- Not deployed or approved for public/emergency use.
- No managed PostgreSQL production configuration or backup strategy has been executed.
- Rate limiting and sessions are per-process; no shared Redis/PostgreSQL store.
- No MFA, account lockout, CAPTCHA or breached-password screening.
- CSRF defense is SameSite + origin checking, not token-based.
- `APP_BASE_URL` must be set before email links are useful outside localhost.
- Public operational district alert-history endpoint remains deliberately public; policy review is required before any production claim.
- Notification history/stat endpoints are ADMIN-only.
- No centralized logging, metrics, uptime monitoring or incident response.
- No production email queue, bounce handling or unsubscribe management.
- No official IMD/CWC/I&CAD telemetry integration.
- Historical licence remains UNVERIFIED.
- The frontend bundle exceeds the 500 kB warning threshold.

## 13. Exact verified test results

| Suite | Result |
|---|---:|
| Regression | 13/13 PASS |
| Authentication | 14/14 PASS |
| Reports | 12/12 PASS |
| Forecast | 12/12 PASS |
| Open-Meteo | 9/9 PASS |
| CAP | 11/11 PASS |
| Notifications | 14/14 PASS |
| Historical | 10/10 PASS |
| Hardening | 19/19 PASS |
| Email | 10/10 PASS |
| **Total** | **124/124 PASS** |

Lint: PASS.  Build: PASS.  Database integrity: PASS.

## 14. Production-readiness checklist

Before any deployment or public/emergency claim:

1. Set `APP_BASE_URL` to the real HTTPS origin; configure TLS/HSTS and secure cookies.
2. Use a managed production database with backup, PITR and tested restore/rollback.
3. Rehearse migrations on a staging copy; never run them first on production.
4. Restrict public endpoints according to an approved security policy.
5. Configure secret management; rotate any previously shared development credentials.
6. Set up centralized logs, metrics, uptime monitoring and incident response.
7. Provide official-source credentials/approvals for IMD/CWC/I&CAD or keep them clearly unavailable.
8. Complete historical-data licence verification before redistribution.
9. Complete DLT/WhatsApp/email compliance and opt-in/unsubscribe flows.
10. Approve a notification provider and staging canary; keep live sending disabled until explicit sign-off.
11. Perform penetration testing, restore drill and rollback drill.
12. Obtain operations, security, legal and emergency-management sign-off.
13. Publish explicit user-facing limitations and official-warning disclaimers.

## Handover package contents

Includes source, tests, migrations, seed/reference data, documentation, build configuration and safe placeholders. Excludes all databases, backups, local environment files, credentials, `node_modules`, `dist`, and machine-specific files.
