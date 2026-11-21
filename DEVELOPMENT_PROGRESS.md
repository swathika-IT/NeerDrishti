# NeerDrishti — Development Progress

## Phase 8 — Notification history authorization fix (awaiting review)

### Scope
Closed the final security-audit finding that notification history and notification statistics were publicly accessible. The fix does not enable any delivery channel and does not alter notification delivery, risk scoring, thresholds, or data.

### Change
- `GET /api/notifications` now requires an authenticated **ADMIN** session via `requireAuth, requireRole('ADMIN')`.
- `GET /api/notifications/stats` now requires an authenticated **ADMIN** session via `requireAuth, requireRole('ADMIN')`.
- Added an integration regression test covering:
  - anonymous request → HTTP 401
  - authenticated non-admin request → HTTP 403
  - ADMIN request → HTTP 200 and valid response payload for both endpoints
- No other notification delivery endpoints were changed; `/api/notifications/dispatch`, `/api/notifications/delivery-config`, and `/api/notifications/dry-run` were already ADMIN-only.

### Verification
- `npm run lint` PASS.
- `npm run build` PASS; `dist/server.cjs` **562.0 kB**; frontend chunk unchanged at **1,731.52 kB** raw / **391.98 kB** gzip.
- All ten suites: **124/124 PASS, 0 fail** — regression 13, auth **14**, reports 12, forecast 12, Open-Meteo 9, CAP 11, notifications 14, hardening 19, historical 10, email 10.
- `npm run db:integrity` PASS: integrity ok, foreign keys clean; districts 33, reports 5, external signals 2,879 (historical 2,508), snapshots 132, users 0, notification_history 0.

### Safety and remaining concerns
- `MAIL_DRY_RUN=true`, `LIVE_SEND_IMPLEMENTED=false`, SMS/WhatsApp disabled, and live notification delivery remain disabled.
- No migration, database modification, deployment, Git push, or process termination occurred.
- The anonymous/non-admin tests use dedicated fresh jars; earlier global test-jar state was corrected so the authorization assertions test the intended cases rather than expired sessions.
- No other notification-history endpoint was found. The public district alert-history endpoint (`/api/alerts/district/:districtId/history`) is outside this fix’s scope and remains publicly readable; if operational alert visibility is also considered sensitive, changing it requires an explicit access-policy decision and approval.

## Phase 8 — Gmail SMTP Email Delivery: verification and password reset (awaiting review)

### Scope
Implemented the first real-mail foundation for authentication emails while keeping delivery disabled in this environment. No emails were sent, no Gmail login was attempted, no SMS/WhatsApp behavior changed, no database migration ran, and the risk formula was not modified.

### Implemented
- Added `nodemailer` and `@types/nodemailer`; no unrelated dependencies changed.
- Added `src/services/email/mail_service.ts`:
  - reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`;
  - validates host/port/TLS settings and applies SMTP timeouts;
  - provides explicit `verify()` and send isolation behind mocks;
  - sanitizes failures and never logs SMTP passwords or transport errors;
  - uses `APP_BASE_URL` to build verification/reset links and falls back to local `PORT` when unset.
- Added `src/services/email/templates.ts`: NeerDrishti-branded verification and password-reset templates, escaped recipient content, expiry and single-use wording, and plain-text alternatives.
- Integrated email delivery with registration, resend-verification, and forgot-password workflows:
  - verification tokens are hashed in SQLite, single-use, and expire after 24 hours;
  - reset tokens are hashed in SQLite, single-use, and expire after 30 minutes;
  - tokens are never logged or returned in production responses.
- Added `?verify_email=` and `?reset_password=` handling in `AuthView`; links open the auth screen directly and the query string is cleared after loading.
- Changed `NODE_ENV` handling so Vite development middleware is loaded only when `NODE_ENV=development`; test mode uses the static build path.
- `AUTH_DEV_EXPOSE_TOKENS=true` is now a hard startup error in production, not a warning.

### Delivery gate
Live delivery remains impossible in this build:
- `MAIL_DRY_RUN=true` is respected.
- `LIVE_SEND_IMPLEMENTED` remains `false`.
- `NOTIFICATION_LIVE_SEND_ENABLED` remains rejected in environment validation.
- No provider credentials are printed, stored in source, or committed.

### Verification
- `npm run test:email` **10/10 PASS**: base URL parsing, action URLs, SMTP config validation, dry-run, disabled live gate, mocked transport verify/send/failure paths, sanitized errors, template escaping.
- `npm run test:auth` **13/13 PASS**; `npm run test:reports` **12/12 PASS** after switching tests to `NODE_ENV=test`; all ten suites **123/123 PASS, 0 fail**.
- `npm run lint` PASS.
- `npm run build` PASS; frontend chunk increased to **1,731.52 kB** raw / **391.98 kB** gzip (existing >500 kB chunk warning); `dist/server.cjs` **561.9 kB**.
- No migration was run and the development database was not altered by this implementation.

### Remaining work / limitations
- The current `.env.example` was absent from the workspace at the start of this task; it was not recreated automatically. `APP_BASE_URL` is not present in the local environment observed, so email links fall back to localhost. It must be configured to the deployed public HTTPS origin before mail is enabled.
- No real Gmail handshake or inbox delivery was verified. Do so only in an approved staging/test flow using a dedicated test mailbox and explicit sign-off.
- Live sending remains disabled and must stay disabled until provider credentials, SPF/DKIM/DMARC, bounce/complaint handling, monitoring, rollback, and staging evidence are approved.
- Email delivery is synchronous in the request path; a queue/outbox is required for scale and retries.
- The application still has no production email unsubscribe/suppression or webhook processing; those belong to notification work, not this auth-email increment.
- `.env.example` needs to be recreated with safe placeholders (including `APP_BASE_URL`) before the next deployment handoff.

## Phase 8 — Epic 7: Validation & Demo Readiness — 2026-11-05 (awaiting review)

### Scope
Epic 7 verified the complete Phase 8 build, documented forecast and backtesting readiness honestly, prepared a role-based demo runbook, and consolidated status across Epics 0–7. No application behavior, risk formula/weights/thresholds, production data, migrations, snapshots, or live notification paths were changed. No deployment or Git push occurred.

### Regression and build verification
- All nine suites executed after documentation changes: **113/113 PASS, 0 fail** — regression 13, auth 13, reports 12, forecast 12, Open-Meteo 9, CAP 11, notifications 14, hardening 19, historical 10.
- `npm run lint` PASS (`tsc --noEmit`).
- `npm run build` PASS; `dist/server.cjs` 552.1 kB; only existing main-chunk >500 kB warning.
- `npm run db:integrity` PASS: `integrity_check=ok`, `foreign_key_check=[]`, `missing_tables=[]`; districts 33, citizen_reports 5, external_signals 2,879, historical external_signals **2,508**, forecast_snapshots 132, users 0, notification_history 0.
- Migrations verified and tracked: `001_identity_access.sql`, `002_reports_canonicalization.sql`, `003_signals_notifications_integrity.sql`; no migration was run.
- All **33/33** Telangana districts are present; historical records remain intact at **2,508**. The 132 existing forecast snapshots were preserved and not rewritten. They remain bug-derived (`generatedWithFieldBug=132`, valid=0) and are not evidence of accuracy.

### Forecast validation status
`npm run report:validation` returned **backtestPossible: false** and these material reasons:
- `flood_history.csv` covers only five priority districts, with event years and scores but no dates, magnitudes, or outcomes.
- `sample_rainfall.csv` is a single 2026-08-26 snapshot, not a time series.
- `external_signals` contains rainfall-only data for 33 districts from 2026-10-30 to 2026-11-04, with no flood outcomes.
- `hydrological_stations` is a reference/seeded registry, not observed river-stage history.
- No labeled outcome variable exists anywhere in the repository.

Required for future backtesting:
1. Multi-year (>=10 years) district-wise daily rainfall for all 33 districts (NWDP/IMD daily CSV or equivalent verified open/permissioned source).
2. A labeled district-level flood-event catalog with dates, affected districts, and severity (Telangana SDMA/IMD/local authority releases).
3. Matched inputs for rainfall and antecedent wetness over the same period, plus an explicit outcome definition.

`npm run validate:events` returned valid template with **0 events**, **backtest_readiness: NOT READY** for all five priority districts (**0/3** verified events each). No events or metrics were fabricated.

### Data source health checked
Live read-only checks on 2026-11-05:
- IMD CAP RSS mirror: HTTP 200, **0 items**, `lastBuildDate: Sun, 27 Sep 2026 07:56:07 +0000`; empty feeds are reported honestly as STALE, never as fabricated warnings.
- SACHET Telangana RSS: HTTP 200, **10 items**; no `lastBuildDate` was present in the feed.
- SACHET all-India RSS: HTTP 200, **100 items**; no `lastBuildDate` was present; Telangana relevance/dedup is applied in code.

Registered status remains:
- Open-Meteo: connected/enabled; modelled NWP grid rainfall, **not official station telemetry**, not an official flood warning, non-commercial CC BY 4.0 attribution retained.
- IMD AWS API, CWC gauges, Telangana I&CAD reservoirs: unavailable / not configured; never displayed as live.
- CAP feeds: FORECAST only; CAP warnings do not alter risk weights/thresholds and do not mean measured rainfall.
- Historical NWDP records: **2,508**, `HISTORICAL` mode, licence **UNVERIFIED**; permission is required before redistribution or production use.
- SIMULATED scenario outputs are clearly labelled and never promoted to LIVE evidence.
- Unverified reports do not affect risk calculations (`VERIFIED_ONLY` basis); PENDING/UNDER_REVIEW/REJECTED reports contribute zero.

### Demo readiness delivered
- Added `docs/DEMO_RUNBOOK.md`.
- Includes public, citizen, official and admin role flows; reserved-example account setup; no real passwords or secrets; isolated demo database path guidance; safe pre/post-demo checks; scenario explanations and expected limitations; feature readiness matrix; timed talk track and non-claims.
- Demo scenarios are all clearly SIMULATED_FORECAST and cannot send alerts, sirens, emails, SMS, or WhatsApp messages.
- Staging deployment prerequisites were added to README.md and include production database selection, migration rehearsal/rollback, official source approval, TLS/cookies/CORS/HSTS, secret management, centralized observability, notification compliance, historical licence verification, and stakeholder sign-off.

### Documentation
- README updated with Epics 0–7, actual verification results, source integration status, forecast validation status, known limitations, staging prerequisites, and historical UNVERIFIED status.
- DEVELOPMENT_PROGRESS records this Epic and the evidence above.

### Limitations / exit criteria
- Epic 7 is documentation and verification only; no manual demo was executed, and no staging/production deployment occurred.
- No accuracy metrics are available or claimed.
- CAP feed health reflects feed availability at check time and may change; empty feed is not a system failure.
- Historical validation remains blocked on multi-year labelled data and licence permission.
- Staging is not configured and must not be represented as ready for public/emergency use.

## Phase 8 — Epic 6: Production Hardening — 2026-11-05 (awaiting review)

### Scope
Epic 6 added security, startup, observability, backup/integrity, and shutdown hardening without changing the public UI, existing application behavior, risk weights, or thresholds. It did not migrate the database, modify historical data, enable live notifications, deploy, or push.

### Implemented
- Security headers and CSP: `src/middleware/security_headers.ts`; production CSP is strict, requires external scripts and inline styles for current React/Leaflet behavior, allows Carto Voyager tiles, disables object/frame embedding, and keeps `frame-ancestors 'none'`. HSTS only when explicitly enabled and `NODE_ENV=production`.
- CORS allowlist: `src/middleware/cors.ts`; same-origin and no-Origin pass, wildcard/pathful/credentialed origins rejected, disallowed origins receive 403 without reflection, exact allowlisted origins receive `Access-Control-Allow-Origin` and credentials only when enabled.
- Environment validation: `src/config/env_validation.ts`; checked before database initialization; invalid booleans/numbers/URLs/CORS refuse startup with key-only error messages; production warnings for exposed tokens, insecure cookies, memory fallback, and disabled CSP. `NOTIFICATION_LIVE_SEND_ENABLED=true` is invalid and cannot enable live sending.
- Separate probes: `GET /api/health/live` (minimal liveness) and `GET /api/health/ready` (SQLite + `schema_migrations`; 503 when unready; no probe errors exposed). Existing `/api/health` preserved.
- Structured request logging: `src/middleware/request_logging.ts`; logs method, path, status, duration, request ID only; no query strings, bodies, cookies, authorization headers, tokens, IP addresses, user agents, or submitted PII. Client `X-Request-ID` accepted only for safe 8-64 character tokens.
- Database scripts: `npm run db:backup` (VACUUM INTO + integrity check + sha256) and `npm run db:integrity` (read-only integrity, foreign keys, required tables, row counts, historical count, migrations).
- Graceful shutdown: `src/services/graceful_shutdown.ts`; SIGINT/SIGTERM/SIGBREAK stop CAP/Open-Meteo jobs, close idle connections, close the HTTP server, close SQLite, exit 0; bounded timeout force-closes connections and exits 1. Uncaught exceptions/rejections log redacted structured errors and initiate shutdown.

### Backups / database verification
- Backup before any Epic 6 database work: `backups/neerdrishti-pre-epic6-2026-11-05T06-00-23-296Z.db`, 2,945,024 bytes, sha256 `e261312ee1a4bfbcf69684a15459b0183c0e1cb34c1c2a2c462b3dc97b6b2bab`; `integrity_check` ok. This matches the pre-Epic5 backup hash, confirming the development database was not modified by Epic 6.
- `npm run db:integrity` PASS: `integrity_check=ok`, `foreign_key_check=[]`, `missing_tables=[]`, districts 33, citizen_reports 5, external_signals 2,879, historical external_signals **2,508**, forecast_snapshots 132, users 0, schema_migrations 3, notification_history 0.
- Migrations applied remain `001_identity_access.sql`, `002_reports_canonicalization.sql`, `003_signals_notifications_integrity.sql`. No migration or database write was performed.
- Backup restore status: an earlier restore drill was executed on a **temporary copied database** with byte-identical reports/districts verified via sha256. Epic 6 did not overwrite `data/neerdrishti.db`; the new backup/integrity scripts were verified for backup creation and integrity checking, not for overwriting the real development database.

### Tests / lint / build
- All nine suites: **113/113 PASS, 0 fail** — regression 13, auth 13, reports 12, forecast 12, Open-Meteo 9, CAP 11, historical 10, notifications 14, hardening **19**.
- `npm run lint` PASS (`tsc --noEmit`).
- `npm run build` PASS; `dist/server.cjs` 552.1 kB (existing chunk-size warning only).
- Production smoke on a temporary copied database: `/api/health/live` 200, `/api/health/ready` 200 with database/migrations `ok`; disallowed origin 403 with no `Access-Control-Allow-Origin`; same-origin 200; separately configured allowlisted origin 200 with exact `Access-Control-Allow-Origin: https://client.example`, credentials mode, request ID, and no reflection of other origins. Security headers and production CSP were present. No development database was overwritten.
- `npm run db:backup` and `npm run db:integrity` both PASS and output retention/restore guidance.

### Notification safety
Live notifications remain disabled. Config check returned `dry_run=true`, `live_send_enabled=false`, EMAIL dry-run, SMS disabled, WHATSAPP disabled. `.env.example` keeps `MAIL_DRY_RUN=true`, `SMS_ENABLED=false`, `WHATSAPP_ENABLED=false`, `NOTIFICATION_LIVE_SEND_ENABLED=false`; implementation has no live-send path.

### Documentation / README
- Added `docs/PRODUCTION_HARDENING.md` with CSP/CORS, environment validation, probes, logging, backup retention and restore, shutdown, and limitations.
- README duplicate restore instruction was removed and replaced with a precise temporary-copy restore-drill statement; no unsupported "tested on development DB" claim remains.

### Limitations
- No production deployment or runtime promotion was performed.
- Live email/SMS/WhatsApp remain disabled; no provider credentials or DLT/WhatsApp compliance work was done.
- CAP remains forecast-only; Epic 4 limitations still apply.
- CSP development mode must permit Vite HMR; production CSP is stricter but the current inline React/Leaflet `style` attributes require `style-src 'unsafe-inline'`.
- Rate limits remain per-process; no centralized log aggregation, metrics, uptime monitoring, or incident alerting exists.
- These checks prove the hardened behavior under the current test suite; they do not prove production readiness by themselves.

## Phase 4 (verification, 2026-11-04): drill on a TEMP COPY — original DB untouched
- Verified: sqlite 3.51.2, integrity_check ok, foreign_key_check clean. Counts: alerts_history 0, citizen_reports 5, districts 33, external_signals 166 (165 Open-Meteo LIVE + 1 "IMD AWS Test" LIVE flagged unverified), forecast_snapshots 132, hydrological_stations 33 (2 rows with district_id='rangareddy', canonical id is 'ranga_reddy' — NOT rewritten pending approval), notification_history 0, report_classification 5.
- forecast_snapshots discrepancy explained: all 132 rows created 2026-11-04T06:41 (Phase 2/3-era production smoke tests, 66 per /api/districts ×2 calls via the pre-fix read path; all horizon 6). Phase 1 count of 0 was correct then; rows are redundant test artifacts (kept, not deleted — pruning needs approval).
- District mapping (all exact, no guesses): Hyderabad→hyderabad, Warangal→warangal, Bhadradri Kothagudem→bhadradri_kothagudem, Nirmal→nirmal. No ambiguity; no unmatched values.
- New tables 001–003 apply in transactions on the temp copy; integrity_check ok; FK check clean; row counts preserved; reports canonicalised (PENDING×2, UNDER_REVIEW×1, VERIFIED×2); 5 moderation backfill rows; "IMD AWS Test" flagged via new flagged_unverified column (values unchanged); failure-migration rollback verified; restore-from-backup verified byte-identical via sha256 of reports+districts.
- Proposed migration files written to migrations/ (001_identity_access.sql, 002_reports_canonicalization.sql, 003_signals_notifications_integrity.sql) — NOT executed against the original DB.
- SQLite vs PostgreSQL: NOT drop-in compatible (types, autoincrement, PRAGMAs, boolean-as-int, driver node:sqlite vs pg). Migrations are SQLite-dialect; Postgres requires per-file review, a test instance, and a pg adapter — no claim made without testing.

## Phase 8 — Epic 5: Notification System - DRY_RUN only - 2026-11-05 (awaiting live-delivery approval)

### Scope and safety
- Implemented **DRY_RUN only**. No SMTP connection, SMS provider call, WhatsApp API call, live email, or live message was made.
- `MAIL_DRY_RUN=true`, `SMS_ENABLED=false`, `WHATSAPP_ENABLED=false`, `NOTIFICATION_LIVE_SEND_ENABLED=false` remain the safe defaults. Live sending is not implemented in this release.
- Missing SMTP credentials keep email in DRY_RUN. SMS/WhatsApp require `consent_given_at`; `unsubscribed_all_at` blocks all channels; missing preference rows are skipped.
- Eligible dry-run deliveries are recorded as `DRY_RUN` with `provider_message_id=NULL`; no `SENT` or `DELIVERED` is claimed. Provider `SENT` claims are rejected/downgraded in DRY_RUN or when unconfirmed.
- Existing risk weights and thresholds were not changed.

### Implementation
- Added `src/services/notifications/types.ts`, `config.ts`, `providers.ts`, `rate_limiter.ts`, and `delivery_service.ts`.
- Provider adapters: SMTP, SMS, and WhatsApp dry-run interfaces; no network client or live-send path is present.
- Delivery pipeline: subscriber lookup from `alert_subscriptions`, preference/consent checks, subscription minimum-severity filtering, per-user/per-channel rate limits, bounded exponential retries, payload generation, masked-recipient metadata, and persistence in the existing `notification_history`.
- Added admin-only `GET /api/notifications/delivery-config` and `POST /api/notifications/dry-run`; existing admin dispatch now records `DRY_RUN` rather than claiming delivery.
- Reused existing migrated columns (`user_id`, `subscription_id`, `delivery_status`, `provider_message_id`, `retry_count`, `last_attempt_at`). No migration or schema change was required.
- Added `package.json` script `test:notifications`, `tests/notification_dry_run.test.ts`, `docs/NOTIFICATIONS.md`, and `.env.example` notification settings.

### Verification
- `npm run test:notifications` **14/14 PASS**: defaults; mocked SMTP/SMS/WhatsApp; zero network calls; missing credentials; consent; unsubscribe; disabled providers; missing preferences; severity suppression; rate limit; retry exhaustion/recovery; unconfirmed provider success; SENT rejected during master DRY_RUN.
- Full suites: **94/94 PASS** (regression 13, auth 13, reports 12, forecast 12, Open-Meteo 9, CAP 11, historical 10, notifications 14). `npm run lint` PASS. `npm run build` PASS (`dist/server.cjs` 532.7 kB; existing chunk-size warning only).
- Server smoke on a temporary DB copy: admin delivery-config 200 (`dry_run=true`, `live_send_enabled=false`, SMS/WhatsApp disabled); dry-run POST 201 with EMAIL `DRY_RUN`, SMS/WHATSAPP `SKIPPED`; one history row `DRY_RUN`, `provider_message_id=NULL`, zero network delivery.
- Dev DB untouched: `integrity_check ok`, `foreign_key_check []`, notification_history **0**, notification_preferences 0, alert_subscriptions 0, users 0, districts 33, citizen_reports 5, external_signals 2,879 (historical 2,508), forecast_snapshots 132, alerts_history 0.
- Fresh pre-change backup: `backups/neerdrishti-pre-epic5-2026-11-05T05-28-45-382Z.db`, 2,945,024 bytes, integrity ok, sha256 `E261312EE1A4BFBCF69684A15459B0183C0E1CB34C1C2A2C462B3DC97B6B2BAB`.

### Limitations
- No live SMTP/SMS/WhatsApp delivery; no provider message IDs or delivery receipts; `DELIVERED` is never claimed.
- Rate limiting is in-memory and resets on restart; it is not shared across instances.
- No subscription/preference management API or UI in this epic.
- Phone verification is not enforced by the DRY_RUN pipeline; require it before live SMS/WhatsApp.
- Auth verification/password-reset emails remain token-only and are not wired to this provider.
- Live work requires separate approval, real provider credentials, DLT/WhatsApp compliance, persistent rate limits/idempotency, monitoring, and rollback planning.

## Phase 8 — Epic 4: Official IMD/SACHET CAP Warnings - 2026-11-05 (approved by user)

### Sources verified
- IMD default: `https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml` - HTTP 200, public domain, **0 items**, `lastBuildDate` Sun 27 Sep 2026. The user-supplied `https://mausam.imd.gov.in/imd_latest/contents/cap_rss.xml` returned **HTTP 404** and is documented but not used.
- NDMA SACHET Telangana: `https://sachet.ndma.gov.in/cap_public_website/rss/rss_telangana.xml` - HTTP 200, 10 items. All-India: `rss_india.xml` - HTTP 200, 100 items. Both feeds are integrated; all-India items are prefiltered for Telangana relevance and deduplicated against the state feed.
- SACHET is a relay: publisher (NDMA SACHET) and sender (for example Telangana-SDMA/TGiCCC/IMD Hyderabad) are stored separately. No claim that SACHET equals IMD-only.

### Implementation
- `src/services/cap/cap_parser.ts`: fixed parse-result typing; tolerant namespaced CAP 1.2 parsing remains non-fabricating.
- `src/services/cap/imd_cap_service.ts`: dual-feed ingestion, bounded retries/backoff/timeouts, district/abbreviation/state-wide matching, one row per matched district or `STATE_TELANGANA`, `Actual`-only operational filtering, Alert/Update/Cancel lifecycle, latest-update-wins views, expiry filtering, cross-feed dedupe, honest per-feed health (`UNKNOWN/HEALTHY/STALE/DEGRADED/OFFLINE`), registry sync, bounded scheduler.
- `src/types/signals.ts`, `src/db/sqlite.ts`, `src/types.ts`, `src/services/signal_validator.ts`: additive `official_alert` signal type and `FORECAST` mode; registry health widened for honest states. No schema migration required.
- `src/config/data_sources.ts`: added `IMD_CAP_FEED` and `SACHET_CAP_FEED` registry entries with access notes.
- `server.ts`: added `GET /api/cap/status`, `GET /api/cap/summary`, `GET /api/cap/alerts`, admin-only `POST /api/cap/refresh`, scheduler startup, and shutdown cleanup.
- `src/components/CapWarningsPanel.tsx` + `AlertCenterView.tsx`: official CAP warnings panel with feed health, severity/sender/publisher, sent/expiry, scope, source link, and non-endorsement/forecast disclaimer.
- `.env.example`, `docs/IMD_CAP_FEED.md`, `package.json` (`test:cap`), `tests/cap_feed.test.ts`.

### Storage / lifecycle decision
- CAP warnings are stored in `external_signals` as `signal_type='official_alert'`, `data_mode='FORECAST'`, `unit='severity_code'` (0-4 severity rank, not a measurement). They are **not** stored as `hydrological_alert` and do not alter risk weights/thresholds.
- `Test`/`Exercise`/`System`/`Draft` are rejected. `Cancel` is stored but excluded from active views. Expired warnings remain for audit but are excluded from active views. Replays do not duplicate rows.

### Verification
- `npm run test:cap` **11/11 PASS**: malformed/non-CAP rejection, namespaced parsing, district/abbreviation/state-wide matching, IMD+SACHET ingest, all-India prefilter, duplicate suppression, Update/Cancel supersession, expiry, Test/Exercise rejection, empty -> `STALE`, outage/retry -> `OFFLINE` with no fabricated rows.
- Full suites: **80/80 PASS** (regression 13, auth 13, reports 12, forecast 12, Open-Meteo 9, historical 10, CAP 11). `npm run lint` PASS. `npm run build` PASS (`dist/server.cjs` 513.0 kB; existing chunk-size warning only).
- Live smoke on a **temporary DB copy**: SACHET state HEALTHY, all-India HEALTHY, IMD STALE (empty), 33 official-alert rows stored from SACHET, 0 active because the currently listed SACHET warnings had expired; no parse/fetch errors. Server smoke: `/api/health` ok, `/api/cap/status` 200, `/api/cap/alerts` 200, registry states exposed; no stderr errors besides the SQLite experimental warning.
- DEV DB untouched: `integrity_check ok`, `foreign_key_check []`, CAP rows **0**, historical NWDP rows **2,508**, external_signals **2,879**, districts 33, citizen_reports 5, forecast_snapshots 132, users 0. No migrations, no deletions, no notification dispatch.

### Limitations
- IMD CAP feed currently has zero items, so no live IMD CAP document was observed; parser coverage is mocked, not a claim of live format verification.
- SACHET all-India feed's latest 100 items contained no Telangana items during smoke; the state feed provided Telangana coverage.
- District matching is text/alias-based, not polygon/geocode intersection; generic `N districts of Telangana` with N<33 is stored as state scope rather than guessed.
- CAP warnings are informational only: no notifications, no risk-score changes, no Epic 5 work.
- Historical rainfall licence remains **UNVERIFIED**; no GODL/NDSAP claim is made.

## Phase 8 - Epic 3: Historical Data Integration — 2026-11-04 (approved by user)

### Dataset actually obtained
- **IMD District-wise Daily Rainfall via NWDP** (NWIC / Ministry of Jal Shakti / IMD), `https://nwdp.nwic.gov.in/dataset/rainfall-daily-imd`. Downloaded 2026-11-04, 8.68 MB, sha256 `05f43a430d4c12eb634976aa984b7a104493fbbf2d03f6f9ac2c9bbb0a2022b3`. **Licence UNVERIFIED (corrected 2026-11-04 — see licence verification below): the resource page states "No License Provided".** Units mm/day. **Rolling window 2026-08-19 → 2026-11-03 (76 days), all-India file; Telangana slice imported.**

### Licence verification (2026-11-04, post-import — records untouched)
- Inspected the exact resource page `…/resource/8752174f-1d17-4aaf-8058-2eb396f50157`: metadata block reads **`License: No License Provided`**. Dataset page shows only a Last Update Date (no licence). Footer: `© 2025 NWIC All Rights Reserved.` Copyright Policy page is a generic site reproduction notice (prominent source acknowledgement; excludes third-party copyright) and does **not** name GODL/NDSAP.
- Conclusion: **GODL/NDSAP-India is NOT explicitly applicable; status = UNVERIFIED.** The Epic 3 claim of "GODL / NDSAP" was an incorrect inference from the portal being government-run and is hereby corrected.
- Actions: added `docs/NWDP_LICENCE_VERIFICATION.md` (evidence + what would change the verdict); import script now records `licence_status: 'UNVERIFIED'` with a loud console warning and corrected licence string; docs (`HISTORICAL_COVERAGE.md`, `PHASE8_BASELINE_AND_EVENT_LABELS.md`) updated; test fixture updated. The **2,508 imported rows are preserved unmodified** (their metadata retains the pre-verification licence string as a legacy value; `source_name` legacy `(GODL-India)` token kept stable only for duplicate-detection and does not assert a licence). Import re-run: inserted 0 (idempotent), DB unchanged at 2,879 signals.
- Evidence artefacts: `docs/NWDP_LICENCE_VERIFICATION.md`; refreshed `reports/nwdp_telangana_import_2026-11-04.json` (licence_status UNVERIFIED).
- No fabricated data; missing values (`ND`/`NA`) preserved as missing and skipped.

### Import result (offline pipeline, dry-run then apply)
- 2,508 Telangana rows accepted, **0 rejections**, 33/33 districts × 76 days, `external_signals` 371 → 2879 (+2,508 HISTORICAL). Re-import dry-run = 0 ready / 2,508 duplicates skipped (idempotent).
- All rows `data_mode='HISTORICAL'` (verified: 2,508 / 2,508), `source_name='NWDP IMD District-wise Daily Rainfall (GODL-India)'` (legacy token — not a licence assertion), source attribution + licence (legacy string) + daily_normal + daily_category in metadata.
- 6 publisher abbreviations resolved via an **explicit auditable alias table** (B. KOTHAGUDEM, J. BHUPALPALLY, KUMARAM BHEEM, M. MALKAJGIRI, PEDDAPALLE, Y. BHUVANAGIRI = 76 rows each); unresolved names are rejected, never guessed.

### Event labels
- `data/flood_events_telangana.json` — **0 events** (honest template; provenance skeleton). Validator `npm run validate:events` → valid, backtest readiness **NOT READY** (0/3 verified events per priority district). Spec: `docs/PHASE8_BASELINE_AND_EVENT_LABELS.md`.

### Files added/changed
- Added: `src/services/historical/csv.ts` (RFC4180 parser), `historical_import.ts` (mapping/validation/dedupe + alias table), `flood_events.ts` (label validator + readiness), `scripts/import_historical_rainfall.ts`, `scripts/validate_flood_events.ts`, `tests/historical_import.test.ts`, `docs/HISTORICAL_COVERAGE.md`, `data/flood_events_telangana.json`, `reports/nwdp_telangana_import_2026-11-04.json` (gitignored).
- Modified: `src/db/sqlite.ts` (additive `insertHistoricalSignalsBatch`, `getExistingSignalDateKeys`), `package.json` (`test:historical`, `import:historical`, `validate:events`), `.gitignore` (`reports/`, `data/imports/`), this file.

### Tests / checks
- `test:historical` **10/10 PASS**: CSV quoting/BOM/CRLF; valid parse; unresolved district rejected + alias resolution; missing/invalid values rejected (not zeroed); in-file duplicates rejected; attribution/licence metadata; DB import idempotency; HISTORICAL never used as LIVE; event validator accepts template, rejects bad district/date/evidence/duplicates/missing provenance.
- All suites: regression 13/13, auth 13/13, reports 12/12, forecast 12/12, open-meteo 9/9, historical 10/10 (**69 total, 0 fail**). `lint` PASS, `build` PASS (~474 kB).
- DEV DB verified: `integrity_check ok`, `foreign_key_check []`; citizen_reports 5, forecast_snapshots 132 (preserved), report_moderation_history 5, users 0. No destructive SQL, no migrations, risk formula untouched. Backup: `backups/neerdrishti-pre-migration-2026-11-04T09-38-11-316Z.db`.

### Limitations / gaps
- NWDP daily file is a **rolling ~11-week window — not multi-year**; 10-year daily rainfall still required for backtesting.
- **No curated flood-event labels** yet → accuracy metrics remain impossible and unclaimed.
- Historical rows are district-label granularity, offline-import only; app never fetches historical data at runtime.
- Non-Telangana rows in the all-India file are skipped by state filter (by design, not rejections).

## Phase 8 — Epic 1: Live Data Integration (Open-Meteo hardening) — 2026-11-04 (approved by user)

### Changed files
- `src/services/open_meteo_service.ts` — bounded retries with exponential backoff + jitter (network/timeout/HTTP 429/5xx only; 4xx permanent); per-request timeout via env; in-process cache with TTL; duplicate suppression against recent Open-Meteo LIVE signals (survives restarts); rate-limit awareness (stops early when ≥ half a batch is throttled, records unprocessed districts honestly, sets `last_rate_limited_at`); honest health transitions — all-success HEALTHY, partial DEGRADED, total failure DOWN + `currentMode=UNAVAILABLE`; observation + retrieval timestamps preserved in metadata (`recorded_at`, `matched_time`, `observation_time`, `retrieved_at`); env-overridable base URLs.
- `src/App.tsx` — footer attribution: **"Weather data by Open-Meteo.com (CC BY 4.0, non-commercial). Open-Meteo is not an official government flood warning source."**
- `.env.example` — `OPEN_METEO_BASE_URL`, `OPEN_METEO_ARCHIVE_URL`, `OPEN_METEO_TIMEOUT_MS`, `OPEN_METEO_RETRIES`, `OPEN_METEO_CACHE_TTL_MS`, `DUPLICATE_SUPPRESSION_WINDOW_MS` + attribution note.
- `package.json` — `test:open-meteo` script.
- Added `tests/open_meteo.test.ts`, `docs/OPEN_METEO_COVERAGE.md`.

### Tests (offline, mocked HTTP — no real external requests)
- `npm run test:open-meteo` **9/9 PASS**: success ingest; duplicate suppression (no re-ingest within window); no non-mocked URLs escape; 5xx retried then succeeds; persistent 429 → rate-limited state + DOWN/UNAVAILABLE health; timeout fails honestly; network failure → 0 fabricated LIVE rows, DOWN; stale observation stored EXPIRED (never FRESH); unconfigured sources remain NOT_CONFIGURED/UNAVAILABLE.
- Regression suites unchanged: `npm test` 13/13, `test:auth` 13/13, `test:reports` 12/12, `test:forecast` 12/12. `lint` PASS, `build` PASS (~474 kB).

### API behaviour verified (real single cycle on a TEMP DB copy — DEV DB untouched)
- `/api/rainfall/live-status`: 33/33 districts updated, 0 failures, cache 33, no rate-limit event.
- `/api/sources`: Open-Meteo `LIVE / HEALTHY / CONNECTED`, `last_successful_update` populated.
- `/api/data/health`: system `DEGRADED` (2 official sources offline — honest); IMD/CWC/I&CAD remain UNAVAILABLE/NOT_CONFIGURED.

### Database
- DEV DB unchanged & verified: `integrity_check ok`, `foreign_key_check []`, citizen_reports 5, districts 33, external_signals 371, forecast_snapshots 132 (preserved), report_moderation_history 5, users 0. No migrations, no deletions, risk formula/weights/thresholds untouched.
- Backup for this epic: `backups/neerdrishti-pre-migration-2026-11-04T09-11-48-266Z.db`.

### Limitations
- Open-Meteo remains **modelled grid rainfall**, not station telemetry, and not an official government warning; attribution required, non-commercial free tier.
- Duplicate suppression/dedup state is checked against the DB each call (cheap, exact); cache is in-process only (not shared across instances).
- No IMD/CWC integration (Epic 2+, credential-gated). Python suite still unrunnable here.

## Phase 8 — Epic 0: Baseline & Event Label Specification — 2026-11-04 (approved by user; Epic 0 ONLY)

### Baseline captured (DEV DB, unchanged by this epic)
- Fresh backup: `backups/neerdrishti-pre-migration-2026-11-04T09-11-48-266Z.db` (VACUUM INTO, integrity_check ok). Original sha256 `187860E2851E57353965EB95804CB0673B087B8544C3AC20D8ECA0F17C518B04`; backup `CDD62D650D4340BC73263C3B9C0834DB7F558ADF86CAE2FC23AC4026B55A4452`.
- Tests: regression 13/13, auth 13/13, reports 12/12, forecast 12/12 — all PASS. Lint PASS. Build PASS (~469 kB). Python suite NOT RUNNABLE (no interpreter).
- Counts: districts 33, citizen_reports 5, external_signals 338 → 371 after one smoke start (server auto-refresh, additive), forecast_snapshots 132 (preserved), report_moderation_history 5, users 0, integrity ok, FK clean, WAL enabled.
- Health snapshot: system DEGRADED (IMD/CWC/I&CAD offline as honestly reported), Open-Meteo CONNECTED/HEALTHY, 17 virtual devices online.
- Port 3000 free pre-smoke; `.env` holds demo LLM config only; no auth/IMD credentials present.

### Files added
- `docs/PHASE8_BASELINE_AND_EVENT_LABELS.md` — baseline metrics, event label-file format spec (`data/flood_events_telangana.json`, to be curated in Epic 3), provenance/attribution rules, and the Epic 0 external-credentials checklist (IMD gov.in/nic.in + static IP + nodal letter; NWDP CSV (open); CDS; SMTP; DLT SMS; WhatsApp).

### Not done (by design)
- No code, config, migrations or data changes. No credentials fetched. No Epic 1 started. Python environment absence already documented.

## Phase 7: Forecast Validation, Historical Backtesting & Prediction Reliability — 2026-11-04 (approved by user)

### Backups (before inspection/no DB writes performed)
- `backups/neerdrishti-pre-migration-2026-11-04T08-56-20-554Z.db` (VACUUM INTO, integrity_check ok). Original sha256 `7A5B14B9EB1BEBC673852DDC9124E3FF8F452826415A39ED89BB78F8A2DF5AFC`.
- No database changes, no migration, no DELETE/DROP/TRUNCATE; dev DB re-verified after work (integrity ok, FK clean; citizen_reports 5, districts 33, forecast_snapshots 132 (untouched), users 0).

### Datasets examined (all under `data/`)
- flood_history.csv — 5 priority districts only; event years, no dates/rainfall/outcomes.
- districts.csv / drainage_risk.csv — 5 districts, static vulnerability scores.
- sample_rainfall.csv — single 2026-08-26 snapshot for 5 districts; baseline values.
- telangana_districts.json/.csv — 33 districts metadata, `historical_flood_context` prose, no series.
- external_signals — 338 rows, rainfall-only, 2026-10-30→2026-11-04 (~5 days), 33 districts, no flood outcomes.
- forecast_snapshots — 132 rows, ALL `current_risk_score = 0` (Phase 3 field-contract bug artifacts), all horizon 6, min/max proj 6.3–12.4. Preserved but explicitly invalid evidence.
- hydrological_stations — 33 seeded reference stations (no real observations).

### Feasibility verdict (honest)
- **Backtesting is NOT possible.** No labeled, district-level, time-indexed flood outcomes exist anywhere in the repository. MAE/RMSE/precision/recall/false-alarm rate therefore cannot be computed and are deliberately not reported.
- Required: multi-year district-wise daily rainfall (verified open: NWDP, IMD district-wise daily CSV, last updated 2026-10-31) + labeled Telangana flood-event catalog (SDMA/IMD bulletins).
- Tool added: `scripts/forecast_validation_report.ts` (read-only; `npm run report:validation`) — prints dataset inventory, span/coverage, reasons backtesting is impossible, and the exact requirements. It fabricates nothing.

### Forecast audit (33 districts, production build, SIMULATED_FORECAST)
- All 33 forecast `SIMULATED_FORECAST`, all `MEDIUM` confidence, `validUntil` = generatedAt + horizon; no `LIVE_FORECAST` is emitted anywhere in the app.
- Highest current risk: Bhadradri Kothagudem 52.7, Hyderabad 44.25, Khammam 41.04; outlook mix: WATCH 19, ELEVATING_RISK 13, HIGH_PROJECTION 1; trend RISING 30 / STABLE 3. Basin propagation adds plausible upstream surges (Mancherial +3.2, Bhadradri +3.2).
- LIVE/HISTORICAL/FORECAST/BASELINE/SIMULATED separation intact: Open-Meteo = only connected LIVE source (rainfall model output), historical archives inert (NOT_CONFIGURED), simulation explicitly SIMULATED; situation fusion surfaces SIMULATED; confidence capped for simulated inputs; projections stamped with `forecastDataMode` + disclaimer ("not an official flood warning").

### Regression tests — `tests/forecast_validation.test.ts` (12/12 PASS)
Missing hydrological_summary (NORMAL fallback), missing freshness/mode, extreme rainfall clamped to ≤100/no NaN, zero rainfall finite output, confidence ordering FRESH ≥ AGING ≥ EXPIRED with 0.10–0.98 bounds, SIMULATED never claims HIGH, stale/UNAVAILABLE stays LOW/LIMITED, ISO timestamps + validUntil horizon math per horizon, default mode never LIVE, timeline h6 == direct projection, basin surge capped ≤25, disclaimer present, rainfall band boundaries.
- `npm test` 13/13, `test:auth` 13/13, `test:reports` 12/12, `test:forecast` 12/12 (50 total, 0 failures). `lint` PASS, `build` PASS.

### Files added/changed
- Added: `scripts/forecast_validation_report.ts`, `tests/forecast_validation.test.ts`.
- Modified: `package.json` (`test:forecast`, `report:validation`), `README.md` (reliability/backtesting honesty section), this file.
- Unchanged: risk formula/weights/thresholds, provenance, auth, all DB data.

### Limitations & remaining risks
- Forecasts remain heuristic persistence models — zero measured accuracy; treat as decision support only.
- The 132 archived snapshots are bug-derived artefacts and must not be cited as validation (preserved per no-delete rule).
- No hydrological observation history exists; hydrology is still simulated-fallback.
- IMD/CWC/NWDP historical imports remain blocked on credentials/manual ETL; until done, accuracy claims stay impossible.
- Python tests still unrunnable on this machine; Python risk-engine parity verified by inspection only.

## Phase 6: Citizen Reporting Security, Validation & Moderation — 2026-11-04 (approved by user)

### Pre-change safety
- DEV DB backed up before any change: `backups/neerdrishti-pre-migration-2026-11-04T08-41-53-029Z.db` (VACUUM INTO, integrity_check ok). Original sha256 `3D481CC9827B0AF6D9226D5DFB9E9432FC1774EB3872A2E43724A896F2AA1036`.
- **No migration was required** — Phase 4 already added `reporter_user_id/locality/lat/lng/updated_at`, `report_moderation_history`, `report_attachments`. No DELETE/DROP/TRUNCATE performed.

### Implemented
- **Server-side validation module** `src/services/reports/report_validation.ts`: canonical 7 categories (+legacy synonyms), severities, Telangana-bounded optional coordinates, recent-ISO timestamp validation, attachment structural validation, privileged-field detection, text sanitisation.
- **POST /api/reports hardened**: canonical district resolution; privileged fields (`id`/`status`/`reporter_user_id`/`approved`/…) rejected 400; category/severity/description/coordinate/timestamp validation; attachment validation (PNG/JPEG/WEBP data URI ≤2 MB or https URL; SVG/javascript/data:text/html/traversal rejected); status always server-set to **PENDING**; `reporter_user_id` from session only; IP limit (default 10/h, `REPORT_RATE_LIMIT_MAX`) + per-account limit (default 20/h, `REPORT_RATE_LIMIT_USER_MAX`); validated attachment metadata written to `report_attachments`; locality/coords persisted. Anonymous submission preserved (documented in README).
- **Attachment honesty**: classifier no longer claims "Verified Flood Visual"; presence of an image yields `Uncertain Visual` and never raises confidence; `CLASSIFIER_FORCE_RULE_BASED=true` enables deterministic offline classification.
- **Moderation**: PATCH `/api/reports/:id/status` now validates the target status and lifecycle transitions (officials restricted; admins flexible), writes `report_moderation_history` (actor, timestamp, from→to, reason) and audit log; new `GET /api/reports/:id/history` (jurisdiction-scoped for officials).
- **Risk integrity (formula unchanged)**: `getDistrictAggregation` now scores **VERIFIED-only** (legacy 'Validated' accepted); PENDING/UNDER_REVIEW/REJECTED excluded from the citizen term. Added `verified_reports`, `unverified_reports`, `scoring_basis: VERIFIED_ONLY` and verified-basis explainability. Weights (0.35/0.25/0.15/0.15/0.10) and thresholds untouched.
- **Vocabulary**: `updateReportStatus` accepts the unified PENDING/UNDER_REVIEW/VERIFIED/RESOLVED/REJECTED set (legacy mapped) and writes `updated_at`; report inserts default to PENDING.
- **Frontend (minimal)**: incident-type grid updated to the 7 canonical categories; status badges render the new lifecycle; public reports listing unchanged.

### Security tests — `npm run test:reports` (12/12 PASS, integration on temp DB copy)
Anonymous submit → PENDING, no reporter link; authenticated submit → reporter_user_id from session; forged `reporter_user_id`/`status`/`id`/`approved` → 400; invalid district/category/severity/short description/out-of-bounds coords/lat-without-lng/future timestamp → 400; attachment SVG/javascript/data:text/html/path → 400, valid PNG → 201; unauthorized moderation (anon 401, citizen 403, history 403); official jurisdiction (out-of-scope 403, in-scope 200, history records actor/reason); invalid transition 400; admin moderation recorded in history with actor/timestamp; unverified excluded from scoring (verified report contributes, after rejecting the verified Hyderabad reports score = 0, `/api/districts` citizen_report_score drops to 0); per-account rate limit 429; seed reports #1–#5 preserved.

### All suites / checks
- `npm test` 13/13, `npm run test:auth` 13/13, `npm run test:reports` 12/12 (38 total, 0 failures).
- `npm run lint` PASS; `npm run build` PASS (469 kB).
- DEV DB: `integrity_check ok`, `foreign_key_check []`, counts unchanged (citizen_reports 5, districts 33, report_classification 5, forecast_snapshots 132, hydrological_stations 33, report_moderation_history 5, report_attachments 0, users 0). Dev smoke: health ok, districts 33, reports 5, hyderabad summary total 2 / verified 1 / unverified 1 / score 12 / basis VERIFIED_ONLY.

### Files changed/added
- Added: `src/services/reports/report_validation.ts`, `tests/report_security.test.ts`.
- Modified: `src/db/sqlite.ts` (verified-only aggregation, attachment/moderation helpers, status vocabulary), `src/classifier.ts` (image honesty, force-rule env, extended categories), `server.ts` (POST validation/limits, PATCH transitions+history, GET history endpoint, imports), `src/components/CitizenReportView.tsx` (categories + status badges), `package.json` (`test:reports`), `.env.example`, `README.md`, this file.
- Unchanged: risk formula/thresholds, provenance rules, auth design, Phase 4 migrations.

### Known limitations & remaining risks
- Anonymous submissions still accepted (by design/compat) and can add PENDING noise; they cannot influence risk until verified.
- Attachments are stored inline as data URIs in `image_reference` (existing behavior); `report_attachments` holds metadata only, no object storage, no malware scanning, no EXIF stripping.
- No image analysis (by design) — `image_plausibility` is informational only.
- Rate limits are in-memory per-process.
- `seeded` legacy reports had statuses migrated to PENDING/VERIFIED; their DEMO origin is unchanged (Phase 6 does not fabricate or delete them).
- Python path/tests still unrunnable on this machine.

## Phase 5: Authentication & Role-Based Access Control — 2026-11-04 (approved by user)

### Implemented
- **Password security**: bcrypt (bcryptjs, cost 12, pure JS — no native build), policy (≥10 chars, upper+lower+digit).
- **Sessions**: server-side rows in existing `sessions` table; opaque 32-byte token; sha256 hash stored (raw token never persisted); 7-day expiry; `nd_session` cookie `HttpOnly`/`SameSite=Lax`/`Secure` when `NODE_ENV=production` or `COOKIE_SECURE=true`; logout/revocation; password change & reset revoke other/all sessions.
- **Registration/login/logout**, email-verification token workflow, forgot/reset-password with single-use tokens and generic responses (no account enumeration), same-origin check on cookie-authenticated mutations.
- **Four access levels**: PUBLIC (open dashboards/maps), CITIZEN, OFFICIAL (requires admin approval + district jurisdiction), ADMIN. Central `attachAuth` + `requireAuth`/`requireRole`/`requireApprovedOfficial`/`hasJurisdiction` middleware; server-side only, never trusting client-supplied role/ids.
- **Protected endpoints** (previously open, per Phase 1 audit): scenario set, signals ingest, hydrology ingest, rainfall refresh (×2), data mode, IoT reading, data ingest, alerts recalculate, notifications dispatch → ADMIN. Report status PATCH → approved OFFICIAL/ADMIN + jurisdiction check. AI chat/reasoning remain public (dashboard) but rate limited (30/min/IP). POST /api/reports remains public for backward compatibility, is IP rate limited, and links `reporter_user_id` when authenticated (Phase 6 will require login).
- **Admin endpoints** (`/api/admin/*`): users list, status change, role-request list/approve/reject, jurisdiction update, audit logs, overview. **Official endpoints**: `/api/official/me`, `/api/official/reports` (jurisdiction-scoped). `/api/citizen/reports` returns only the caller's reports.
- **First-admin bootstrap**: one-time token generated in memory at startup while zero admins exist, printed **only to the console**, 60-min TTL, timing-safe compare, single-use, rotates on restart. No default/hardcoded admin.
- **Audit logging**: `audit_logs` for register, login success/failure, logout, verification, password change/reset, role requests/approvals, user status changes, jurisdiction changes, report status changes.
- **Rate limiting**: in-memory sliding window (per-process) for login/register/forgot/reset/change/verify/role-request/setup/admin actions/report submission/AI.
- **Safe errors**: auth endpoints return generic messages; removed internal `error.message` leak from report submission.
- **Frontend**: `AuthView` (login/register/forgot/reset/admin-setup), `AccountView` (profile, password change, official request, my reports), `OfficialWorkspaceView`, `AdminConsoleView`; role-aware Navbar with sign-in/out; public dashboard unchanged and no longer mutates global scenario state (scenario/custom-rainfall are now read-only query overrides via `/api/districts?scenario=&rain_override=`).
- **Phase 4 status vocabulary integrated**: `updateReportStatus` now accepts the unified PENDING/UNDER_REVIEW/VERIFIED/RESOLVED/REJECTED set (legacy values mapped); rejected reports excluded from district aggregation case-insensitively.
- No new migration required (Phase 4 tables already covered users/sessions/roles/audit). `PORT` env added. `bcryptjs` + `@types/bcryptjs` added (only new dependencies).

### Security test results — `npm run test:auth` (integration, temp DB copy, production build)
13/13 PASS: unauthenticated rejection (6 endpoints); public reads still open (33 districts); one-time admin setup (wrong token 403, valid 201, reuse 403); admin login + cookie flags (HttpOnly/SameSite=Lax) + admin access; citizen register/login/verify + wrong password 401; citizen blocked from admin/official (403); citizen data isolation (0 own reports, no cross-user leak); official approval + jurisdiction (in-scope PATCH 200, out-of-scope PATCH 403, scoped read only hyderabad); unapproved official blocked (403); logout invalidates session (me null, citizen reports 401); account recovery (own token works; unknown email returns no token); login rate limiting (429); admin cannot suspend self.
- Also re-ran Phase 3 suite `npm test` 13/13 PASS; `npm run lint` PASS; `npm run build` PASS (455 kB).
- Real DEV DB smoke: /api/health ok, /api/districts 33, /api/reports 5, setup_available=true (no admin yet), integrity_check ok, users/sessions/audit_logs still 0 (server only reads until setup). Note: server start ran the scheduled Open-Meteo refresh (166→265 `external_signals`, real attributed LIVE rows) — additive real data, nothing deleted.

### Files changed/added
- Added: `src/services/auth/password.ts`, `tokens.ts`, `session_store.ts`, `auth_service.ts`, `audit.ts`, `rate_limit.ts`, `setup.ts`, `middleware.ts`; `src/routes/auth_routes.ts`, `src/routes/admin_routes.ts`; `src/components/AuthView.tsx`, `AccountView.tsx`, `OfficialWorkspaceView.tsx`, `AdminConsoleView.tsx`; `tests/auth_security.test.ts`.
- Modified: `server.ts` (PORT env, attachAuth, auth+admin route registration, ~14 protected endpoints, rate limits, report ownership, safe error), `src/db/sqlite.ts` (reporter_user_id insert, unified status vocabulary), `src/App.tsx` (view-only scenario overrides, auth state, new tabs), `src/components/Navbar.tsx` (auth UI + role tabs), `package.json` (`test:auth`), `.env.example`, `README.md`, this file.
- Not changed: DB schema/migrations (Phase 4 intact), risk formula, provenance controls, Phase 6 reporting UI behavior.

### Known limitations & remaining risks
- Email delivery NOT configured — verification/reset emails are not sent; only server-side tokens exist. Do not claim email works.
- Rate limiting is per-process in-memory (resets on restart; not shared across instances).
- POST /api/reports stays public until Phase 6; unverified/anonymous reports still influence risk aggregation as before.
- No CSRF token mechanism (relies on SameSite=Lax + same-origin check).
- Sessions are not auto-purged (helper exists but unused); no "remember me"/2FA.
- First-admin token is console-only; if the operator loses it before setup, restart the server to rotate.
- `AUTH_DEV_EXPOSE_TOKENS=true` returns tokens in responses by explicit opt-in; must never be enabled in production.
- Frontend auth views are functional but minimal (not a redesign).

## Phase 4 IMPLEMENTATION — 2026-11-04 (migrated real DEV database, approved by user)

### Pre-migration
- Running application: none (port 3000 verified free before migration).
- Fresh verified backup (manual, VACUUM INTO): `backups/neerdrishti-pre-migration-2026-11-04T07-19-41-080Z.db` (516 KB, integrity_check ok, counts 5 reports / 33 districts / 166 signals / 132 snapshots / 5 classifications / 33 stations). sha256 original `FE7AF6844B4F386615368530AC3D1ED5825E19F0A9D4CF3A1C6ECD46C8A96CBF`; backup `5DEB9379D7FB75F3B0A03DE7ADAE4B1455E3E4A49E224F0EF358FF3F6BD69C76` (checksums differ because VACUUM INTO rebuilds the file; logical content verified identical by counts + integrity).
- Rehearsal on a separate copy with the real migrator (`DATABASE_PATH=…\rehearsal.db`): applied 001–003, re-run = 0 applied (idempotent), no duplicates in `report_moderation_history` (5 rows), integrity ok.

### Migration run (real DB)
- Migrator auto-backup: `backups/neerdrishti-pre-migration-2026-11-04T07-19-47-253Z.db`.
- Applied in order, each in its own transaction: `001_identity_access.sql` → `002_reports_canonicalization.sql` → `003_signals_notifications_integrity.sql`. Both migration runs recorded in `schema_migrations` with sha256 checksums (001 `be4b5a61…`, 002 `021b631e…`, 003 `160393ae…`).
- Post-run sha256 of `data/neerdrishti.db`: `778B379A5F59780E0605C829F0A2250F1BA17FA6029486036D2110F2BD8E7AC3`.
- Re-run: "No pending migrations" (0 applied) — verified idempotent.

### Post-migration verification
- `PRAGMA integrity_check` = ok; `foreign_key_check` = clean; `journal_mode = wal` persisted (busy_timeout 5000 and foreign_keys ON set on every app connection).
- Counts preserved exactly: citizen_reports 5, districts 33, external_signals 166, forecast_snapshots 132 (NOT pruned), report_classification 5, hydrological_stations 33, alerts_history 0, notification_history 0. New tables: users 0, sessions 0, password_resets 0, email_verifications 0, role_requests 0, official_profiles 0, official_jurisdictions 0, user_districts 0, alert_subscriptions 0, notification_preferences 0, audit_logs 0, report_attachments 0, report_moderation_history 5, schema_migrations 3.
- Reports: ids 1,2→`hyderabad`; 3→`warangal`; 4→`bhadradri_kothagudem`; 5→`nirmal`; statuses New→PENDING (×2), Reviewed→UNDER_REVIEW, Validated→VERIFIED (×2). Moderation backfill: 5 SYSTEM rows, no duplicates.
- Rangareddy: both `hydrological_stations` rows untouched (`district_id='rangareddy'`) per instruction.
- Unverified source flagged: `external_signals` id 2 ("IMD AWS Test") `flagged_unverified=1`; values unchanged.
- No DELETE/DROP/TRUNCATE executed; all changes additive/mapped.
- API smoke tests (production build): /api/health ok (33 districts); /api/districts 33; /api/reports 5 (canonical district_id + PENDING status visible); /api/hydrology/stations 33; /api/forecast/districts 33 forecasts (Hyderabad currentRiskScore 46.83, operational HIGH_CONCERN — confirms Phase 3 field-contract fix); /api/alerts/summary 33 active alerts (basin_threat_count 6); /api/sources 7.
- `npm test` 13/13 PASS; `npm run lint` PASS; `npm run build` PASS (411.7 kB).

### Files changed
- Added: `src/db/path.ts`, `src/db/migrate.ts`, `migrations/001_identity_access.sql`, `migrations/002_reports_canonicalization.sql`, `migrations/003_signals_notifications_integrity.sql`.
- Modified: `src/db/sqlite.ts` (DATABASE_PATH, WAL, busy_timeout, fail-fast, no silent :memory: fallback), `src/database.py` (DDL frozen; verifies schema_migrations, raises if unmigrated), `package.json` (`migrate` script), `.gitignore` (`backups/`, `*.db-wal`, `*.db-shm`), `README.md` (migrations/backup/restore docs), `.env.example` (DATABASE_PATH, DB_ALLOW_MEMORY_FALLBACK, NEERDRISHTI_BACKUP_DIR).
- Not changed: frontend, risk formula, forecasts, existing API field names.

### Restore procedure (tested)
Stop server → copy chosen backup over `data/neerdrishti.db` → `PRAGMA integrity_check` → restart → verify counts + `/api/health`. Restore drill on temp copy reproduced byte-identical reports+districts (sha256 match).

### Remaining risks
- Python `init_database()` now raises on unmigrated DBs (intended) — run `npm run migrate` first; Python suite still unrunnable on this machine.
- `rangareddy` (2 station rows) and 132 legacy snapshots intentionally left as-is; `external_signals` mixed timestamp formats unchanged.
- Migration checksums guard against editing applied files; future migrations must be new files.
- No auth/PostgreSQL/deployment performed.

## Phase 4: Database and Multi-User Architecture — 2026-11-04 (assessment; originally no schema changes)

### Existing DB assessment (data/neerdrishti.db, 516 KB, SQLite via node:sqlite, gitignored)
Tables (row counts): districts 33 (clean, canonical ids) · citizen_reports 5 (legacy seeds; district_id stores DISPLAY NAMES, no FK) · report_classification 5 (FK to citizen_reports, OK) · external_signals 166 (ALL labelled LIVE incl. "IMD AWS Test" 65.5 mm unverified row dated 2026-10-30 — unverified-source LIVE mislabel, stale) · hydrological_stations 33 (seeded reference stations, metadata.reference_type marks them UNVERIFIED/SIMULATION references) · forecast_snapshots 132 (accumulated by pre-fix read-path bug; redundant, stale) · alerts_history 0 · notification_history 0 · report_classification orphans: none.
Indexes exist on alerts/signals/forecast/stations/notification — good baseline. Missing: FKs on citizen_reports.district_id, hydrological_stations.district_id, alerts_history.district_id; citizen_reports(status, district_id, reported_at); no users/roles/sessions/audit/subscriptions tables at all; Python database.py duplicates the TS schema (drift risk); silent :memory: fallback masks persistence failure; TS has no DATABASE_PATH env support (Python does); no migrations/backups/schema_migrations; *.db gitignored (correct).

### Proposed design (NOT implemented — awaiting approval)
- New tables: users, roles seed (CITIZEN/OFFICIAL/ADMIN; PUBLIC stays unauthenticated), user_sessions, password_resets, email_verifications, user_districts (saved districts), role_requests (official applications), official_profiles + official_jurisdictions (district-scoped grants, approved by ADMIN), alert_subscriptions, notification_preferences (+consent/unsubscribe), report_attachments, report_moderation_history (append-only), audit_logs (append-only), schema_migrations. Extend: citizen_reports (reporter_user_id, canonical district_id FK, locality, lat/lng, unified status PENDING/UNDER_REVIEW/VERIFIED/REJECTED/RESOLVED), notification_history (user_id, delivery status, provider_message_id, retry_count) — name preserved for compatibility.
- SQLite OK for dev/demo with WAL + busy_timeout + backups; PostgreSQL (managed: Neon/Supabase/RDS) recommended for production multi-user (concurrency, PITR, managed backups). Schema kept Postgres-compatible; migrator selects dialect by DATABASE_URL kind. Migration path documented; NOT executed.
- Migrator: `migrations/NNN_name.sql` + tiny TS migrator (no new deps), transactional, tracked in schema_migrations, optional backup copy before apply, fail-fast on error; Python legacy path to be retired or made read-only.

### Rules honoured
No deletions, no migrations run, no auth code, no frontend rebuild, no new deps, existing API shapes preserved (additive columns). Awaiting approval to implement.

## Phase 3: Flood-Risk Engine Validation — 2026-11-04 (approved by user)

### Bugs fixed (correctness, formula unchanged)
- `src/services/forecast_service.ts`: `projectDistrictRisk` and `projectDistrictTimeline` now read `flood_risk_score ?? composite_risk_score ?? current_risk_score ?? 0` (was: `composite_risk_score` only → current risk silently 0). Level read: `risk_category ?? risk_level`. Operational category read: `situation_summary.operationalSituation` (was nonexistent `operationalCategory` → always NORMAL).
- `src/services/basin_routing_service.ts`: upstream risk lookup tries `flood_risk_score ?? composite_risk_score ?? current_risk_score ?? 20.0`; status-map lookup now tries the raw connection id (TEL-NIR) AND normalized forms (nirmal / canonical_id / lowercase name) — previously the map was keyed by `district_id` (`nirmal`) while connections use `TEL-NIR`, so upstream lookups silently missed and basin propagation never fired. Verified live: Mancherial +3.2 surge (1 threat), Jayashankar Bhupalpally +2.3, Bhadradri Kothagudem +3.2 (HIGH_PROJECTION).
- Forecast snapshot persistence is now explicit-only (`options.persistSnapshot`, default false). Previously every read inserted rows into `forecast_snapshots`; reads no longer write. `insertForecastSnapshot` remains available for a future explicit/scheduled job.
- No change to weights (0.35/0.25/0.15/0.15/0.10), clamps, or LOW/MODERATE/HIGH/CRITICAL thresholds in TS (server.ts:320-331) or Python (risk_engine.py). TS and Python tiers match README semantics (≤25 LOW, ≤50 MODERATE, ≤75 HIGH, >75 CRITICAL).
- `src/test_alert_engine.ts` legacy standalone script left untouched; `npm test` now runs the real regression suite.

### New regression tests — `tests/regression_risk_forecast.test.ts` (node:test + tsx, 13/13 PASS)
Covers: current-risk field contract (both canonical and legacy fields), timeline carries risk level, snapshot not written on read, basin routing (verified upstream threat with flood_risk_score; legacy composite_risk_score fallback; calm upstream → no surge), alert engine current risk + level bounds + critical escalation path, rainfall intensity classifier bands, stale+simulated confidence cannot claim HIGH, fresh verified-live LIVE_FORECAST reaches HIGH, simulation/IMD sources never eligible as verified live.
- `package.json`: added `"test": "tsx --test tests/regression_risk_forecast.test.ts"` (no new dependencies).

### Verification
- `npm test` 13/13 PASS; `npm run lint` PASS; `npm run build` PASS (411.3 kB server bundle).
- Production server smoke test: /api/districts Hyderabad MODERATE 46.83 → forecast h6 currentRisk 46.83, projected 51.8, ELEVATING_RISK; /api/forecast/district/hyderabad/timeline consistent; Mancherial/Jayashankar/Bhadradri basin propagation now active; /api/health OK.
- Data honesty: situation fusion surfaces SIMULATED mode; rainfall selection requires verified live registry source (Phase 2) — SIMULATED/HISTORICAL cannot become LIVE evidence; HYDROLOGY still synthesises fallbacks (SIMULATED-labelled).

### Limitations / honest caveats
- No historical backtesting against recorded flood events yet (needs validated NWDP/IMD historical import — Phase 2 blocked on manual ETL step). Forecast curves remain heuristic; not validated predictive accuracy; disclaimers retained in code/UI.
- Risk formula not validated for accuracy; preserved as-is per scope.
- Double computation of all-district status per request remains (performance, not correctness).
- Python suite unrunnable on this machine; risk formula equivalence verified by code inspection only.
- config.py RISK_CATEGORIES bounds (25.01/50.01/75.01) vs get_risk_category semantics — unused constant, left unchanged; documentation/consistency cleanup deferred.

## Phase 2: Data Reliability and Integration — 2026-11-04 (approved by user)

### External source verification (live checks, 2026-11-04)
- Open-Meteo: reachable from this machine, no key required, returned real Telangana-area data (Hyderabad: current rain 0.10 mm, daily precip sum 1.60 mm, 2026-11-04). It is NWP model output, not IMD station telemetry. Designated the only integrated meteorological source.
- IMD (api.imd.gov.in, e.g. /api/v1/districtrainfall): HTTP 401 without registered credentials. NOT integrated; registry marks it UNAVAILABLE / NOT_CONFIGURED. Approval/registration required from IMD.
- National Water Data Portal (nwdp.nwic.gov.in): district-wise daily IMD rainfall CSV downloads openly (resource ~5 MB, last updated 2026-10-31, HTTP 200). NOT auto-integrated; documented for manual verified import only (needs ETL + verification).
- Copernicus ERA5 / CDS: requires CDS account + API key — not verified, not integrated.
- NRSC/ISRO Bhuvan inundation layers: WMS-based, requires layer-specific handling/licence review before any integration. Not integrated.
- CWC river gauges / Telangana I&CAD reservoir telemetry: no verified self-serve public API; require registered NWDP access or departmental data-sharing approval. Not integrated.

### Changes implemented
- NEW `src/services/data/provenance.ts`: DataOrigin taxonomy (LIVE/HISTORICAL/FORECAST/BASELINE/SIMULATED), freshness assessment (FRESH/AGING/STALE/EXPIRED/INVALID + ageHours + factor), registry-based live-source verification (`isSourceVerifiedLive`), attribution strings.
- `src/types/signals.ts`: `DataSourceRegistryEntry` gained `integrationStatus` and `accessNote`.
- `src/config/data_sources.ts`: IMD/CWC/I&CAD marked enabled=false, mode/health UNAVAILABLE, integrationStatus NOT_CONFIGURED + accessNote; historical archives MANUAL_VERIFICATION; Open-Meteo CONNECTED; simulation LOCAL_ENGINE (SIMULATED).
- `src/services/data/data_connector.ts`: unconnected connectors now report OFFLINE/UNKNOWN with error_message (no more fake HEALTHY@0.95); per-district monitoring fallbacks are OFFLINE/'No connected feed' (no invented 1.8 m water level); offline sources make system health DEGRADED honestly.
- `src/services/rainfall_service.ts`: unnamed sources default to 'Unspecified external source' with capped confidence (0.4) instead of being labelled IMD AWS; signal metadata tags source_verified / source_known_in_registry; unverified LIVE signals are never selected as authoritative live data; verified HISTORICAL signals now selectable (labelled HISTORICAL, not presented as live); unverified-source skip reason surfaces via fallbackReason.
- `server.ts`: `/api/sources` now returns integration_status, access_note and computed freshness per source (additive, non-breaking).
- NEW `.env.example` with placeholders (IMD_API_KEY, NWDP_ENABLED, DATABASE_PATH, LLM_*).

### Tests / verification
- `npm run lint` (tsc --noEmit): PASS. `npm run build`: PASS (410.6 kB server bundle; chunk-size warning only).
- Production server smoke test: /api/health OK; /api/sources shows IMD UNAVAILABLE/NOT_CONFIGURED, Open-Meteo CONNECTED; /api/data/health reports system DEGRADED with 2 OFFLINE sources (honest); /api/districts returns 33 districts with simulation flags.
- Provenance unit smoke check via tsx: Open-Meteo source verifies as live; IMD and unknown sources do not; freshness helper works on null/now timestamps.
- Python tests: still NOT RUNNABLE on this machine (no working interpreter).

### Known limitations / not done (Phase 2 scope boundaries)
- No IMD/CWC/ERA5/NRSC ingestion implemented — blocked on credentials/approvals, not code.
- NWDP historical CSV is documented but not imported (needs offline ETL + manual verification step).
- Stale-data thresholds and completeness scoring are enforced for rainfall/IoT paths; hydrology service still synthesises fallback observations (labelled simulated in metadata but UI badge audit pending).
- Forecast engine field-contract bug (composite_risk_score vs flood_risk_score) NOT fixed yet — flagged for Phase 3.
- No automated test runner for TS yet; verification was manual smoke checks.

## Phase 1: Project Recovery and Audit — 2026-11-04

### Safety backup
- No git repository present (extracted ZIP, no `.git`), so a feature branch was not possible.
- Source-only baseline archive created: `D:\downloadable\neerdrishti-phase1-baseline-20261104-114510.zip` (~449 KB; excludes `node_modules`, `dist`, `__pycache__`).
- No application source files were modified in this phase. `dist/` was regenerated by `npm run build` (gitignored build output).

### Checks performed
| Check | Result |
|---|---|
| `npm install` | OK — 221 packages, up to date, 0 vulnerabilities |
| `npm run lint` (`tsc --noEmit`) | PASS (but TS `strict` is off, so this is weak) |
| `npm run build` (vite + esbuild) | PASS — `dist/server.cjs` 405.8 kB; warning: main JS chunk > 500 kB |
| Python tests | CANNOT RUN — no working Python interpreter on this machine (Windows Store `python.exe`/`py.exe` aliases fail with "file cannot be accessed"; no install found under `%LOCALAPPDATA%\Programs\Python` or `C:\Python*`). `.pyc` files show tests were run with CPython 3.15 elsewhere. |
| SQLite inspection (read-only) | 33 districts, 5 seeded citizen reports, 33 hydrological stations, 68 external signals, 0 alerts/notifications/forecast snapshots |

### Audit summary (full report delivered in chat)
- Architecture: React 19 + Vite 6 SPA, Express 4 API in `server.ts`, `node:sqlite` (experimental) persistence in `src/db/sqlite.ts`, Python engines (`risk_engine.py` etc., largely duplicated by TS services), Leaflet map, Recharts, Llama/Ollama-compatible LLM endpoint.
- Documented formula matches `src/risk_engine.py` (0.35/0.25/0.15/0.15/0.10, clamped, LOW/MODERATE/HIGH/CRITICAL tiers).
- 33 districts present in `data/telangana_districts.json` (5 Priority / 15 Standard / 13 Limited Data).
- CRITICAL: forecast/basin code reads `composite_risk_score`/`risk_level`, but `computeDistrictStatus` produces `flood_risk_score`/`risk_category` — forecasts effectively treat current risk as zero.
- CRITICAL: no authentication/authorization anywhere; every mutating/admin endpoint (scenario change, ingestion, moderation, dispatch) is open; provenance fields (`source_type`, `data_mode`) are client-controlled, so "LIVE" can be forged.
- Simulation/seed data is presented as real telemetry in places (hydrology synthesis, virtual IoT registry, seeded citizen reports, random scenario readings, `Math.random()`).
- GET endpoints insert `forecast_snapshots` rows on every read; district endpoints recompute twice.
- No rate limiting, security headers, CORS policy, password hashing, sessions, or `.env.example`.
- No Node test runner script; Python test suite unrunnable on this machine.
- Hard-coded port 3000, `process.cwd()`-dependent DB path with silent `:memory:` fallback, no migrations framework, no graceful shutdown.

### Remaining issues / blockers
- Python interpreter must be installed (or PATH fixed) before Python tests can run.
- `.env` exists locally (gitignored, not committed); no `.env.example` yet.
- Audit agent for Python/data side hit usage limits; Python/data findings above were verified manually from source.

### Next recommended action
Await user approval of Phase 1 audit. Recommended first fixes (small, surgical): forecast field-contract bug, read-endpoint side effects, then auth/RBAC baseline. Do NOT start Phase 2+ until approved.
