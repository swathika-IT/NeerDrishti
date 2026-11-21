# NeerDrishti — Demo Runbook

## Purpose

This runbook is for local, controlled demonstrations of the Phase 8 build. It is not a deployment guide and does not certify the system for real emergency response.

Use it to demonstrate:

- Public flood-intelligence views across all 33 Telangana districts
- Clearly labelled SIMULATED scenarios
- Citizen reporting and role-based moderation
- Official and Admin workspaces
- Data provenance, source limitations, and unavailable integrations
- Forecast honesty and the absence of verified accuracy claims

## Safety and scope

- Do **not** deploy or expose the demo on the public internet.
- Do not use live email, SMS, or WhatsApp. Notification features are DRY_RUN only and must remain disabled.
- Do not enter real emergency reports or personal data during rehearsal.
- Prefer an isolated copy of the database for any demo that creates accounts, reports, or test actions.
- Before any demo that writes to the development database, run:

```bash
npm run db:backup
```

- The demo does not verify forecast accuracy. All scenario outputs are SIMULATED_FORECAST decision-support projections.
- CAP warnings are official forecast warnings only when fresh and relevant; they are not measured rainfall and do not change risk weights or thresholds.
- The historical NWDP/IMD rainfall records remain licence **UNVERIFIED**.

## Local startup

### 1. Use safe defaults

Copy `.env.example` to `.env` if needed. Keep:

```env
MAIL_DRY_RUN=true
SMS_ENABLED=false
WHATSAPP_ENABLED=false
NOTIFICATION_LIVE_SEND_ENABLED=false
```

Do not add live provider credentials for the demo.

### 2. Install and verify

```bash
npm install
npm run lint
npm run build
npm run db:integrity
```

Do not run a database migration merely because the app changed. Migrations 001–003 are already applied and tracked in `schema_migrations`.

### 3. Start locally

Development mode:

```bash
npm run dev
```

Local production-asset smoke mode:

```bash
npm run build
npm start
```

Open the local URL printed by the server, normally `http://localhost:3000`.

### 4. Isolated demo database (recommended for destructive-looking steps)

Use a separate database path when the demo will create accounts, submit reports, or exercise moderation:

PowerShell:

```powershell
$env:DATABASE_PATH='data/demo-neerdrishti.db'
npm run dev
```

Then unset it when finished:

```powershell
Remove-Item Env:DATABASE_PATH
```

The application initializes the demo database schema and seed data. Never commit the demo database or credentials.

### 5. Pre-demo health checks

Check:

```text
GET /api/health/live
GET /api/health/ready
npm run db:integrity
```

Expected:

- Liveness: HTTP 200 with `status: ok`
- Readiness: HTTP 200 with `database: ok` and `migrations: ok`
- Integrity: `integrity_check=ok`, `foreign_key_check=[]`

## Recommended demo order

### Segment A — Public view (5 minutes)

1. Open **Home** and point out the PROTOTYPE SIMULATION banner.
2. Show the 33-district overview and explain monitoring tiers:
   - 5 Priority districts
   - 15 Standard districts
   - 13 Limited Data districts
3. Use the **Scenario** selector or **Demo Mode**:
   - Normal Conditions
   - Heavy Rainfall
   - Flood Warning
   - Critical Flood Event
4. Open **Risk Map** and explain that risk scores are heuristic decision support.
5. Open **Situation Fusion** and **Alert Center**; identify LIVE/HISTORICAL/FORECAST/BASELINE/SIMULATED provenance.
6. Open **Data & IoT** and show the source registry honestly:
   - Open-Meteo: connected, modelled grid rainfall, NOT official station telemetry
   - IMD AWS: unavailable/not configured
   - CWC and Telangana I&CAD: unavailable/not configured
   - CAP feeds: public feeds, health shown separately from ingestion success
7. Open **AI Assistant** if the configured LLM endpoint is available; keep expectations modest.

### Segment B — Citizen flow (3 minutes)

1. Sign in / create a citizen account using reserved example-domain addresses such as `demo.citizen@example.com`.
2. Use a non-reusable demo password entered locally. Do not write passwords in slides, docs, screenshots, or chat.
3. Open **Citizen Reports**.
4. Submit a harmless demo report, for example:
   - District: Hyderabad
   - Type: Waterlogging
   - Severity: Moderate or High
   - Description: clearly labelled local demo content
5. Expected result: report is stored as `PENDING`; it does **not** affect risk scoring until verified.
6. Open **My Account** and show **My Reports**.

Important: no email delivery is configured, so verification emails cannot be received. Demonstration accounts remain usable according to the application's auth rules, but do not claim email delivery works.

### Segment C — Official flow (3 minutes)

Prerequisite: an approved OFFICIAL account with at least one assigned district, or use the Admin flow below to create one first.

1. Sign in as the Official.
2. Open **Official Workspace**.
3. Show jurisdiction-scoped district visibility.
4. Review the demo report submitted above.
5. Change status from `PENDING` to `UNDER_REVIEW` and then `VERIFIED`.
6. Show **Report history** / audit information.
7. Verify the report now contributes to the citizen term; unverified reports remain zero.
8. Try an out-of-jurisdiction action and expect rejection.

### Segment D — Admin flow (3 minutes)

Prerequisite: one Admin account. When no admin exists, the server prints a one-time setup token to its console on startup. Use it once through the Admin Setup flow in the UI or `POST /api/auth/setup-admin`, then rotate/restart if needed. Do not commit or display the token.

1. Sign in as Admin.
2. Open **Admin Console**.
3. Show:
   - Overview / users
   - Role requests
   - Jurisdiction assignment
   - Audit logs
4. Approve the demo citizen's official role request and assign a district.
5. Show `GET /api/notifications/delivery-config` or the UI equivalent if available:
   - `dry_run: true`
   - `live_send_enabled: false`
   - SMS/WhatsApp disabled
6. Optionally demonstrate CAP status in an isolated demo database:
   - `GET /api/cap/status`
   - Empty IMD feed should read STALE/empty, never fabricated
   - SACHET state/all-India feeds may report items when available
7. Do not dispatch notifications or mutate production data.

## Scenario expectations and limitations

| Scenario | Expected demo behavior | Important caveat |
|---|---|---|
| Normal Conditions | Most districts low/moderate; rainfall and forecast inputs appear calm; Alert Center shows no invented event | Output is SIMULATED, not a forecast of actual weather |
| Heavy Rainfall | Rainfall scores rise; WATCH/ELEVATING_RISK appears in projections; demo mode advances automatically if running | Not measured rainfall and not an official warning |
| Flood Warning | Some districts project higher risk; basin propagation can amplify upstream influence; CAP feed may appear separately | CAP warnings and simulated projections remain separate evidence sources |
| Critical Flood Event | CRITICAL projections may appear; risk map and situation views intensify | No automatic siren, evacuation order, SMS, or notification is sent |

## Features by readiness

### Operational

- 33-district monitoring and map views
- Deterministic risk scoring with unchanged weights and thresholds
- SIMULATED scenario/demo mode
- Citizen registration/login and protected roles
- Citizen report validation and PENDING default
- Official jurisdiction-scoped moderation
- Admin console, audit logs, and role-request approval
- VERIFIED-only citizen report contribution to risk
- CAP warning ingestion/monitoring panel when feeds are reachable
- Open-Meteo modelled-grid rainfall ingestion and honest source registry
- Health probes, structured request logging, security headers/CORS
- Database backup and integrity scripts
- Notification DRY_RUN pipeline (no live delivery)

### Partially operational

- Open-Meteo: connected modelled output, non-commercial licence, not official station telemetry
- CAP feeds: public feeds can be queried; IMD feed currently legitimately reports empty/STALE when no warnings are published; SACHET health depends on feed availability
- AI Assistant: depends on the configured OpenAI-compatible/Ollama endpoint; unavailable or low-quality responses must not be treated as authoritative
- Forecasts: heuristic and unvalidated; no accuracy is claimed
- Historical rainfall: 2,508 records imported, but they cover a rolling window and remain licence UNVERIFIED
- Email verification/password reset: tokens exist server-side; delivery is not configured

### Unavailable / not integrated

- IMD AWS official rainfall API (credentials required)
- CWC river/gauge telemetry (registered access required)
- Telangana I&CAD reservoir telemetry (departmental approval required)
- ERA5/CDS and NRSC/Bhuvan official imagery/inundation layers
- Live email, SMS, WhatsApp notification delivery
- Verified backtesting, MAE/RMSE, precision/recall, false-alarm metrics
- Automatic official warning issuance or emergency dispatch
- Managed PostgreSQL migration / production deployment
- Centralized observability, uptime monitoring, incident response

## Demo account setup checklist

Use fresh, non-reused credentials and do not record them:

- Demo citizen account
- Demo Admin account (once, using console token)
- Demo Official account (Citizen account + admin approval + jurisdiction)

Recommended email format: `demo.citizen@example.com`, `demo.official@example.com`, `demo.admin@example.com`.

Password policy: at least 10 characters with uppercase, lowercase, and a digit. Use a password manager or enter directly; never paste into docs or slides.

## Talk track for honesty

Use these statements verbatim when asked about accuracy or official status:

- “The forecast is a SIMULATED_FORECAST decision-support projection, not a measured or validated prediction.”
- “Open-Meteo is modelled grid rainfall, not official IMD station telemetry or an official flood warning.”
- “No backtesting has been performed because no multi-year labelled flood-event dataset is available.”
- “The historical dataset remains licence UNVERIFIED until permission is established.”
- “Unavailable IMD/CWC/I&CAD feeds are shown as unavailable, not as live sources.”
- “No live email, SMS, or WhatsApp notifications are sent.”

## Pre-demo verification

```bash
npm run test
npm run test:auth
npm run test:reports
npm run test:forecast
npm run test:open-meteo
npm run test:cap
npm run test:notifications
npm run test:hardening
npm run test:historical
npm run lint
npm run build
npm run report:validation
npm run validate:events
npm run db:integrity
```

All suites are expected to pass for the current Epic 7 build.

## Post-demo cleanup

- Sign out all demo accounts.
- If an isolated demo database was used, leave it local and delete it manually when approved.
- If the development database was used, run `npm run db:integrity`; do not delete or rewrite existing records or snapshots.
- Stop the local server.
- Keep this runbook and any screenshots free of passwords, tokens, or secrets.
