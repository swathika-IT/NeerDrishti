# NeerDrishti — Production Hardening (Phase 8 / Epic 6)

Epic 6 adds operational hardening without changing the public UI, existing application behavior, risk weights, or thresholds. It does not enable live notifications, change history, or perform a migration.

## 1. Security headers and CSP

Implemented in:

- `src/config/security.ts`
- `src/middleware/security_headers.ts`

Headers include:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy` disabling camera, microphone, geolocation, payment, and USB
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`
- `X-XSS-Protection: 0`
- `Content-Security-Policy` by default
- `Strict-Transport-Security` only when `NODE_ENV=production` and `SECURITY_HSTS_ENABLED=true`

CSP is deliberately compatible with the current application:

- External `/src/main.tsx` and production build assets remain allowed.
- Leaflet Carto Voyager tiles are allowed via `https://basemaps.cartocdn.com` and `https://*.basemaps.cartocdn.com`.
- React and Leaflet inline `style` attributes require `style-src 'self' 'unsafe-inline'`.
- Production scripts do not allow `unsafe-inline` or `unsafe-eval`.
- Development allows `ws:`/`wss:` for Vite HMR.
- `object-src 'none'`, `frame-ancestors 'none'`, and `base-uri 'self'` remain set.

Set `SECURITY_CSP_ENABLED=false` only when temporarily diagnosing a known CSP compatibility issue. A production warning is emitted when CSP is disabled.

## 2. CORS allowlist

Implemented in `src/middleware/cors.ts`.

Environment:

```env
CORS_ALLOWED_ORIGINS=https://client.example.com,http://localhost:5173
CORS_ALLOW_CREDENTIALS=true
CORS_MAX_AGE_SECONDS=600
```

Rules:

- Empty `CORS_ALLOWED_ORIGINS` means same-origin only.
- Same-origin and no-`Origin` requests pass without CORS response headers.
- A cross-origin request is accepted only when `Origin` exactly matches one allowlisted origin.
- Disallowed origins receive `403` and are not reflected.
- `*`, paths, queries, fragments, and embedded credentials are rejected during startup validation.
- Credential mode is controlled by `CORS_ALLOW_CREDENTIALS`.
- Allowed browser headers are `Content-Type`, `Authorization`, and `X-Request-ID`.
- Only `Access-Control-Expose-Headers: X-Request-ID` is exposed.

## 3. Environment validation

Environment is validated before database initialization in `server.ts`. The validator is in:

- `src/config/env_validation.ts`
- `src/config/security.ts`

The validator checks:

- `NODE_ENV` values
- boolean flags
- integer ranges for ports, timeouts, retries, rate limits, CAP settings, Open-Meteo settings, notification settings, CORS cache duration, and shutdown timeout
- HTTP(S) URL settings and embedded credentials in URLs
- CORS exact-origin values
- notification live-send flag

Invalid required configuration causes startup to refuse and calls `process.exit(1)`. Error messages identify the configuration key but do not print supplied values, reducing the risk of accidental secret exposure.

`NOTIFICATION_LIVE_SEND_ENABLED=true` is treated as invalid in this release because live sending is not implemented. Keep it `false`.

Production warnings are emitted for:

- `AUTH_DEV_EXPOSE_TOKENS=true`
- `COOKIE_SECURE=false`
- `DB_ALLOW_MEMORY_FALLBACK=true`
- `SECURITY_CSP_ENABLED=false`

Warnings do not stop startup. HSTS requested outside production also produces a warning and is not emitted.

## 4. Health endpoints

Health logic is in `src/services/health_service.ts`.

### Liveness

`GET /api/health/live`

```json
{
  "status": "ok",
  "check": "liveness",
  "timestamp": "2026-11-05T00:00:00.000Z",
  "uptime_seconds": 12
}
```

Liveness returns HTTP `200` and does not depend on database state or reveal configuration.

### Readiness

`GET /api/health/ready`

```json
{
  "status": "ready",
  "check": "readiness",
  "timestamp": "2026-11-05T00:00:00.000Z",
  "uptime_seconds": 42,
  "checks": {
    "database": "ok",
    "migrations": "ok"
  }
}
```

Readiness probes:

1. SQLite `SELECT 1`
2. `schema_migrations` count greater than zero

A successful readiness response uses HTTP `200`; a failed readiness response uses HTTP `503`. Probe errors are not returned in the response body.

The existing `GET /api/health` response is preserved for compatibility.

## 5. Structured request logging

Implemented in `src/middleware/request_logging.ts`.

Each completed request emits one JSON line in this shape:

```json
{
  "type": "http_request",
  "request_id": "hardening-request-1",
  "method": "POST",
  "path": "/api/auth/login",
  "status": 200,
  "duration_ms": 42
}
```

The logger intentionally does not log:

- query strings
- request or response bodies
- cookies
- authorization headers
- tokens
- IP addresses
- user agents
- submitted field values or other direct PII

A client-supplied `X-Request-ID` is reused only when it is 8–64 characters and contains only letters, numbers, dots, underscores, and hyphens. Otherwise a UUID is generated. The selected ID is returned as `X-Request-ID`.

Set `REQUEST_LOG_ENABLED=false` to disable the middleware. Production shutdown and process errors use structured `type`/`event` JSON lines and redacted safe error messages.

## 6. Database backup and integrity scripts

Backup helper:

- `src/db/migrate.ts` `backupDatabase()` uses SQLite `VACUUM INTO` and verifies `integrity_check`.

Backup CLI:

```bash
npm run db:backup
npm run db:backup -- --tag pre-hardening
npm run db:backup -- --database data/foo.db --tag optional-tag
```

Output includes the backup path, byte size, SHA-256 hash, `integrity: "ok"`, and retention guidance.

Integrity CLI:

```bash
npm run db:integrity
npm run db:integrity -- --database data/foo.db
npm run db:integrity -- --database backups/neerdrishti-pre-hardening-<timestamp>.db
```

The integrity script:

- opens SQLite read-only
- runs `PRAGMA integrity_check`
- runs `PRAGMA foreign_key_check`
- confirms required tables exist
- reports row counts for districts, citizen reports, external signals, forecast snapshots, users, and `schema_migrations`
- reports applied migration names
- exits with a non-zero status when integrity or foreign-key checks fail

### Backup retention

Keep:

- the latest **30** routine backups
- every pre-deployment backup
- every pre-migration backup
- backups needed for an open incident or investigation

Prune older routine backups manually. `backups/` is gitignored. Never commit database copies, backup hashes as replacements for backups, passwords, API keys, session tokens, or provider credentials.

### Restore procedure

1. Stop the server.
2. Copy the chosen backup over `data/neerdrishti.db`.
3. Run `npm run db:integrity`.
4. Start the server.
5. Check `/api/health/live` and `/api/health/ready`.
6. Spot-check `/api/districts` and relevant application data.

## 7. Graceful shutdown and process errors

Implemented in `src/services/graceful_shutdown.ts`.

On `SIGINT`, `SIGTERM`, or Windows `SIGBREAK`:

1. Mark shutdown as in progress.
2. Stop IMD CAP and Open-Meteo scheduled refresh jobs.
3. Close idle HTTP connections.
4. Call `server.close()`.
5. Close the SQLite singleton with `closeDb()`.
6. Exit `0` after the callback completes.

`SHUTDOWN_TIMEOUT_MS` controls force-close behavior, from 100 to 60,000 milliseconds and defaulting to 5,000. On timeout, active connections are force-closed and the process exits `1`.

`uncaughtException` and `unhandledRejection` now emit a structured process-error line and initiate shutdown instead of allowing an unknown state to continue. Shutdown phases are logged as JSON lines. Fatal error messages are truncated and common sensitive patterns are redacted; stack traces are not logged.

## 8. Verification

Run:

```bash
npm run test:hardening
npm run test
npm run test:auth
npm run test:reports
npm run test:forecast
npm run test:open-meteo
npm run test:cap
npm run test:notifications
npm run test:historical
npm run lint
npm run build
npm run db:integrity
```

The hardening suite uses mocked requests and responses and does not make network calls. The existing suite count before Epic 6 was 94 tests; Epic 6 adds 19.

## 9. Limitations

- This epic does not deploy the application.
- It does not enable live email, SMS, or WhatsApp delivery.
- It does not perform a database migration.
- CSP development mode permits Vite HMR websocket/script allowances; production mode is stricter.
- Rate limiting remains per-process.
- No centralized log aggregation, metrics system, or uptime monitoring is configured.
- TLS termination and production reverse-proxy configuration remain deployment responsibilities.
- These changes harden the application but do not by themselves prove production readiness.
