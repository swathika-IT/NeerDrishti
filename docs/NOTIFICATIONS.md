# Notification System (Phase 8 / Epic 5, DRY_RUN only)

## Scope

This release implements the notification pipeline in **DRY_RUN mode only**.

- No SMTP connection is opened.
- No SMS provider is contacted.
- No WhatsApp API is contacted.
- No live sending is enabled.
- `NOTIFICATION_LIVE_SEND_ENABLED=false` is the default and live delivery is not implemented in this release.
- SMS and WhatsApp provider flags remain disabled by default.
- Every eligible delivery is simulated and recorded as `DRY_RUN`, never `SENT` or `DELIVERED`.

Live delivery requires a later approved implementation and provider credentials.

## Components

| Path | Purpose |
|---|---|
| `src/services/notifications/types.ts` | Channel, request, provider, result, and status types |
| `src/services/notifications/config.ts` | Environment-backed configuration and safe status view |
| `src/services/notifications/providers.ts` | SMTP, SMS, and WhatsApp dry-run provider adapters |
| `src/services/notifications/rate_limiter.ts` | In-memory per-user/per-channel rate limiter |
| `src/services/notifications/delivery_service.ts` | Subscriber lookup, consent checks, retries, rate limits, payload rendering, persistence |
| `tests/notification_dry_run.test.ts` | Mocked-provider and safety tests |
| `server.ts` | Admin-only dry-run and configuration endpoints |

## Environment

Copy the relevant values from `.env.example`. Defaults are intentionally safe.

```dotenv
NOTIFICATION_DRY_RUN=true
NOTIFICATION_LIVE_SEND_ENABLED=false
NOTIFICATION_MAX_RETRIES=2
NOTIFICATION_RETRY_BACKOFF_MS=200
NOTIFICATION_RATE_LIMIT_PER_HOUR=10

MAIL_DRY_RUN=true
MAIL_FROM=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=

SMS_ENABLED=false
SMS_DRY_RUN=true
SMS_PROVIDER=generic_http
SMS_API_URL=
SMS_API_KEY=
SMS_SENDER_ID=

WHATSAPP_ENABLED=false
WHATSAPP_DRY_RUN=true
WHATSAPP_PROVIDER=generic_http
WHATSAPP_API_URL=
WHATSAPP_API_KEY=
WHATSAPP_PHONE_NUMBER_ID=
```

Safety rules in code:

- `MAIL_DRY_RUN` defaults to `true`.
- Missing `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, or `MAIL_FROM` keeps email in DRY_RUN.
- `SMS_ENABLED` and `WHATSAPP_ENABLED` default to `false`.
- `NOTIFICATION_DRY_RUN=false` and `NOTIFICATION_LIVE_SEND_ENABLED=true` cannot activate live sending in this release.
- A provider that claims `SENT` during master DRY_RUN is downgraded to `FAILED`.
- A provider `SENT` without a real-provider confirmation and a provider message ID is downgraded to `FAILED`.
- `DELIVERED` is never recorded.

## Subscriber selection

A user is eligible only when all applicable checks pass:

1. The user has an `alert_subscriptions` row for the requested district.
2. The alert level meets the subscription's `min_severity`.
3. The user is not deleted, suspended, or deactivated.
4. `notification_preferences.unsubscribed_all_at` is empty.
5. A preference row exists.
6. The channel is enabled in preferences and in configuration.
7. SMS and WhatsApp have `consent_given_at` set.
8. The user has an email address or phone number for the selected channel.

Email does not require `consent_given_at`, but it does require `email_enabled=1`. SMS and WhatsApp require both channel preference and explicit consent.

Missing preference rows are skipped as `NO_PREFERENCES`; they are not treated as implicit consent.

## Delivery statuses

| Status | Meaning |
|---|---|
| `DRY_RUN` | Provider was simulated; payload was recorded; nothing was transmitted |
| `SKIPPED` | Consent, preference, unsubscribe, severity, destination, or enable-flag check prevented an attempt |
| `RATE_LIMITED` | Per-user/per-channel hourly limit blocked the attempt |
| `FAILED` | Provider simulation failed, retries were exhausted, or a success claim was unconfirmed |
| `SENT` | Reserved for future real-provider confirmation with a message ID; not emitted in this release |

Dry-run rows use both `status='DRY_RUN'` and `delivery_status='DRY_RUN'`. `provider_message_id` stays `NULL`. `retry_count` records retries after the first attempt. Metadata includes the rendered payload, provider name, dry-run reason, and a masked recipient.

## Rate limits and retries

- Rate limit key: user ID plus channel.
- Default limit: 10 attempts per channel per user per hour.
- State is in-memory and resets on process restart.
- Retry count is `1 + NOTIFICATION_MAX_RETRIES`, clamped to 0-5 retries.
- Backoff is exponential using `NOTIFICATION_RETRY_BACKOFF_MS`, clamped to 0-5000 ms.
- Retries stop immediately for non-retryable failures.
- Dry-run success does not retry.

## Database

No migration is added in this epic. The existing migrated tables are reused:

- `users`
- `alert_subscriptions`
- `notification_preferences`
- `notification_history`

`notification_history` already has the required additive columns from `003_signals_notifications_integrity.sql`: `user_id`, `subscription_id`, `delivery_status`, `provider_message_id`, `retry_count`, and `last_attempt_at`.

Raw email addresses and phone numbers are not stored in notification metadata; only masked destinations are recorded.

## API

Both endpoints require an authenticated ADMIN session.

### `GET /api/notifications/delivery-config`

Returns safe configuration state without credentials:

```json
{
  "dry_run": true,
  "live_send_enabled": false,
  "max_retries": 2,
  "retry_backoff_ms": 200,
  "rate_limit_per_hour": 10,
  "channels": {
    "EMAIL": { "enabled": true, "dry_run": true, "configured": false, "provider": "smtp" },
    "SMS": { "enabled": false, "dry_run": true, "configured": false, "provider": "generic_http" },
    "WHATSAPP": { "enabled": false, "dry_run": true, "configured": false, "provider": "generic_http" }
  }
}
```

### `POST /api/notifications/dry-run`

Body:

```json
{
  "districtId": "hyderabad",
  "districtName": "Hyderabad",
  "alertLevel": "CRITICAL",
  "title": "Flood warning for Hyderabad",
  "message": "Critical flood risk is projected.",
  "recommendedAction": "Move to higher ground.",
  "signalsTriggered": ["CURRENT_RISK", "FORECAST_PEAK"],
  "source": "manual-test",
  "channels": ["EMAIL", "SMS", "WHATSAPP"]
}
```

`channels` is optional; omitted means all three. The endpoint returns per-candidate results and a summary. It always uses the DRY_RUN pipeline and never enables live sending.

The existing `POST /api/notifications/dispatch` prototype endpoint remains admin-only and now records `DRY_RUN` instead of claiming delivery.

## Tests

Run:

```powershell
npm run test:notifications
```

Coverage includes:

- Default DRY_RUN and disabled SMS/WhatsApp flags
- Mocked SMTP, SMS, and WhatsApp providers
- Zero network calls during DRY_RUN
- Missing SMTP credentials
- Consent required for SMS and WhatsApp
- Unsubscribe-all blocking
- Missing preferences
- Subscription minimum severity
- Rate limiting
- Bounded retries and retry exhaustion
- Retry recovery
- Provider `SENT` claims without confirmation or message ID
- Provider `SENT` claims during master DRY_RUN

## Limitations

- Live SMTP, SMS, and WhatsApp delivery is not implemented.
- There is no preference or subscription management UI/API in this epic.
- Rate limiting is per-process and not shared across instances.
- Phone verification is not required by this DRY_RUN implementation; require it before live SMS/WhatsApp delivery.
- There are no delivery receipts; `DELIVERED` is not claimed.
- Auth verification and password-reset emails still use the existing token-only workflow and are not wired to this provider.
- Provider-specific DLT, WhatsApp Business, and SMTP production requirements are not implemented.

## Future live-delivery gate

Live delivery must not be enabled until a separate approved change adds:

1. A real SMTP client with TLS and bounce/error handling.
2. A real SMS adapter with DLT templates and sender ID compliance.
3. A real WhatsApp Business adapter with approved templates.
4. Persistent rate limiting and idempotency across processes.
5. Provider message IDs and receipt handling.
6. Subscription/preference management and documented consent capture.
7. Explicit production credentials, monitoring, and a rollback plan.
