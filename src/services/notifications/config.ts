import type { NotificationConfig } from './types';

const LIVE_SEND_IMPLEMENTED = false;

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function readString(value: string | undefined): string {
  return String(value || '').trim();
}

export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const smtpHost = readString(env.SMTP_HOST);
  const smtpUser = readString(env.SMTP_USER);
  const smtpPass = readString(env.SMTP_PASS);
  const mailFrom = readString(env.MAIL_FROM);
  const smtpConfigured = Boolean(smtpHost && smtpUser && smtpPass && mailFrom);

  const smsApiUrl = readString(env.SMS_API_URL);
  const smsApiKey = readString(env.SMS_API_KEY);
  const smsSenderId = readString(env.SMS_SENDER_ID);
  const smsConfigured = Boolean(smsApiUrl && smsApiKey && smsSenderId);

  const whatsappApiUrl = readString(env.WHATSAPP_API_URL);
  const whatsappApiKey = readString(env.WHATSAPP_API_KEY);
  const whatsappPhoneNumberId = readString(env.WHATSAPP_PHONE_NUMBER_ID);
  const whatsappConfigured = Boolean(whatsappApiUrl && whatsappApiKey && whatsappPhoneNumberId);

  const liveSendRequested = readBool(env.NOTIFICATION_LIVE_SEND_ENABLED, false);
  const liveSendEnabled = liveSendRequested && LIVE_SEND_IMPLEMENTED;
  const masterDryRun = readBool(env.NOTIFICATION_DRY_RUN, true) || !liveSendEnabled;

  return {
    masterDryRun,
    liveSendEnabled,
    maxRetries: readInt(env.NOTIFICATION_MAX_RETRIES, 2, 0, 5),
    retryBackoffMs: readInt(env.NOTIFICATION_RETRY_BACKOFF_MS, 200, 0, 5000),
    rateLimitPerHour: readInt(env.NOTIFICATION_RATE_LIMIT_PER_HOUR, 10, 1, 1000),
    email: {
      enabled: true,
      dryRun: masterDryRun || readBool(env.MAIL_DRY_RUN, true) || !smtpConfigured,
      configured: smtpConfigured,
      provider: 'smtp',
      from: mailFrom,
      host: smtpHost,
    },
    sms: {
      enabled: readBool(env.SMS_ENABLED, false),
      dryRun: masterDryRun || readBool(env.SMS_DRY_RUN, true),
      configured: smsConfigured,
      provider: readString(env.SMS_PROVIDER) || 'generic_http',
    },
    whatsapp: {
      enabled: readBool(env.WHATSAPP_ENABLED, false),
      dryRun: masterDryRun || readBool(env.WHATSAPP_DRY_RUN, true),
      configured: whatsappConfigured,
      provider: readString(env.WHATSAPP_PROVIDER) || 'generic_http',
    },
  };
}

export function getNotificationDeliveryConfig() {
  const config = loadNotificationConfig();
  return {
    dry_run: config.masterDryRun,
    live_send_enabled: config.liveSendEnabled,
    max_retries: config.maxRetries,
    retry_backoff_ms: config.retryBackoffMs,
    rate_limit_per_hour: config.rateLimitPerHour,
    channels: {
      EMAIL: {
        enabled: config.email.enabled,
        dry_run: config.email.dryRun,
        configured: config.email.configured,
        provider: config.email.provider,
      },
      SMS: {
        enabled: config.sms.enabled,
        dry_run: config.sms.dryRun,
        configured: config.sms.configured,
        provider: config.sms.provider,
      },
      WHATSAPP: {
        enabled: config.whatsapp.enabled,
        dry_run: config.whatsapp.dryRun,
        configured: config.whatsapp.configured,
        provider: config.whatsapp.provider,
      },
    },
  };
}
