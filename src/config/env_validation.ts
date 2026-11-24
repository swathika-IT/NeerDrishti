import {
  buildCorsConfig,
  buildRequestLoggingConfig,
  buildSecurityHeadersConfig,
  parseBooleanValue,
  parseCorsAllowedOrigins,
  type CorsConfig,
  type RequestLoggingConfig,
  type SecurityHeadersConfig,
} from './security';
import { validateMongoConnectionString } from './mongo_uri';

export type RuntimeNodeEnv = 'development' | 'test' | 'production';

export interface EnvValidationIssue {
  key: string;
  message: string;
}

export interface RuntimeConfig {
  nodeEnv: RuntimeNodeEnv;
  port: number;
  mongoUri: string;
  shutdownTimeoutMs: number;
  cors: CorsConfig;
  security: SecurityHeadersConfig;
  requestLogging: RequestLoggingConfig;
}

export interface EnvValidationResult {
  valid: boolean;
  errors: EnvValidationIssue[];
  warnings: EnvValidationIssue[];
  config: RuntimeConfig;
}

const BOOLEAN_KEYS = [
  'DB_ALLOW_MEMORY_FALLBACK',
  'AUTH_DEV_EXPOSE_TOKENS',
  'COOKIE_SECURE',
  'CLASSIFIER_FORCE_RULE_BASED',
  'DISABLE_HMR',
  'NWDP_ENABLED',
  'IMD_CAP_ENABLED',
  'SACHET_CAP_ENABLED',
  'SACHET_CAP_INCLUDE_ALL_INDIA',
  'CAP_TELANGANA_ONLY',
  'MAIL_DRY_RUN',
  'SMS_ENABLED',
  'SMS_DRY_RUN',
  'WHATSAPP_ENABLED',
  'WHATSAPP_DRY_RUN',
  'NOTIFICATION_DRY_RUN',
  'NOTIFICATION_LIVE_SEND_ENABLED',
  'CORS_ALLOW_CREDENTIALS',
  'SECURITY_CSP_ENABLED',
  'SECURITY_HSTS_ENABLED',
  'REQUEST_LOG_ENABLED',
];

const INTEGER_KEYS: Record<string, { min: number; max: number }> = {
  PORT: { min: 1, max: 65535 },
  SMTP_PORT: { min: 1, max: 65535 },
  LIVE_DATA_REFRESH_MINUTES: { min: 1, max: 1440 },
  REPORT_RATE_LIMIT_MAX: { min: 1, max: 100000 },
  REPORT_RATE_LIMIT_USER_MAX: { min: 1, max: 100000 },
  CAP_REFRESH_MINUTES: { min: 1, max: 1440 },
  CAP_TIMEOUT_MS: { min: 100, max: 120000 },
  CAP_RETRIES: { min: 0, max: 10 },
  CAP_RETRY_BACKOFF_MS: { min: 0, max: 60000 },
  CAP_MAX_ITEMS: { min: 1, max: 500 },
  CAP_STALE_AFTER_HOURS: { min: 1, max: 8760 },
  OPEN_METEO_TIMEOUT_MS: { min: 100, max: 120000 },
  OPEN_METEO_RETRIES: { min: 0, max: 10 },
  OPEN_METEO_CACHE_TTL_MS: { min: 0, max: 86400000 },
  DUPLICATE_SUPPRESSION_WINDOW_MS: { min: 0, max: 86400000 },
  NOTIFICATION_MAX_RETRIES: { min: 0, max: 5 },
  NOTIFICATION_RETRY_BACKOFF_MS: { min: 0, max: 5000 },
  NOTIFICATION_RATE_LIMIT_PER_HOUR: { min: 1, max: 1000 },
  CORS_MAX_AGE_SECONDS: { min: 0, max: 86400 },
  SHUTDOWN_TIMEOUT_MS: { min: 100, max: 60000 },
};

const URL_KEYS = [
  'APP_BASE_URL',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPEN_METEO_BASE_URL',
  'OPEN_METEO_ARCHIVE_URL',
  'IMD_CAP_RSS_URL',
  'SACHET_CAP_RSS_URL',
  'SACHET_CAP_ALL_INDIA_RSS_URL',
  'SMS_API_URL',
  'WHATSAPP_API_URL',
];

function parseNodeEnv(value: string | undefined): RuntimeNodeEnv {
  if (value === 'production' || value === 'test' || value === 'development') return value;
  return 'development';
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const errors: EnvValidationIssue[] = [];
  const warnings: EnvValidationIssue[] = [];

  const rawNodeEnv = env.NODE_ENV;
  const nodeEnv = parseNodeEnv(rawNodeEnv);
  if (hasValue(rawNodeEnv) && rawNodeEnv !== nodeEnv) {
    errors.push({ key: 'NODE_ENV', message: 'NODE_ENV must be development, test, or production.' });
  }

  for (const key of BOOLEAN_KEYS) {
    if (hasValue(env[key]) && parseBooleanValue(env[key]) === null) {
      errors.push({ key, message: `${key} must be a boolean value.` });
    }
  }

  for (const [key, range] of Object.entries(INTEGER_KEYS)) {
    if (!hasValue(env[key])) continue;
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      errors.push({ key, message: `${key} must be an integer between ${range.min} and ${range.max}.` });
    }
  }

  for (const key of URL_KEYS) {
    if (!hasValue(env[key])) continue;
    try {
      const url = new URL(String(env[key]));
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push({ key, message: `${key} must use http or https.` });
      }
      if (url.username || url.password) {
        errors.push({ key, message: `${key} must not contain embedded credentials.` });
      }
    } catch {
      errors.push({ key, message: `${key} must be a valid absolute URL.` });
    }
  }

  const corsParsed = parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  for (const message of corsParsed.errors) {
    errors.push({ key: 'CORS_ALLOWED_ORIGINS', message });
  }

  if (!hasValue(env.MONGODB_URI)) {
    errors.push({
      key: 'MONGODB_URI',
      message: 'MONGODB_URI (MongoDB staging database connection string) is required.',
    });
  } else {
    const mongoCheck = validateMongoConnectionString(String(env.MONGODB_URI));
    if (!mongoCheck.ok) {
      errors.push({ key: 'MONGODB_URI', message: mongoCheck.reason || 'MONGODB_URI is invalid.' });
    }
  }

  if (parseBooleanValue(env.NOTIFICATION_LIVE_SEND_ENABLED) === true) {
    errors.push({
      key: 'NOTIFICATION_LIVE_SEND_ENABLED',
      message: 'Live notification sending is not implemented in this release and must remain false.',
    });
  }

  if (nodeEnv === 'production') {
    if (parseBooleanValue(env.AUTH_DEV_EXPOSE_TOKENS) === true) {
      errors.push({
        key: 'AUTH_DEV_EXPOSE_TOKENS',
        message: 'AUTH_DEV_EXPOSE_TOKENS must not be enabled in production; verification and reset tokens would be exposed in API responses.',
      });
    }
    if (!hasValue(env.APP_BASE_URL)) {
      warnings.push({
        key: 'APP_BASE_URL',
        message: 'APP_BASE_URL is not set in production; email links will fall back to localhost.',
      });
    }
    if (parseBooleanValue(env.COOKIE_SECURE) === false) {
      warnings.push({
        key: 'COOKIE_SECURE',
        message: 'COOKIE_SECURE is disabled in production; session cookies will not require HTTPS.',
      });
    }
    if (parseBooleanValue(env.DB_ALLOW_MEMORY_FALLBACK) === true) {
      warnings.push({
        key: 'DB_ALLOW_MEMORY_FALLBACK',
        message: 'DB_ALLOW_MEMORY_FALLBACK is enabled in production; data may become non-persistent.',
      });
    }
    if (parseBooleanValue(env.SECURITY_CSP_ENABLED) === false) {
      warnings.push({
        key: 'SECURITY_CSP_ENABLED',
        message: 'Content Security Policy is disabled in production.',
      });
    }
  }

  if (parseBooleanValue(env.SECURITY_HSTS_ENABLED) === true && nodeEnv !== 'production') {
    warnings.push({
      key: 'SECURITY_HSTS_ENABLED',
      message: 'HSTS is only emitted when NODE_ENV=production.',
    });
  }

  const port = hasValue(env.PORT) ? Number(env.PORT) : 3000;
  const shutdownTimeoutMs = hasValue(env.SHUTDOWN_TIMEOUT_MS) ? Number(env.SHUTDOWN_TIMEOUT_MS) : 5000;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    config: {
      nodeEnv,
      port: Number.isInteger(port) ? port : 3000,
      mongoUri: hasValue(env.MONGODB_URI) ? String(env.MONGODB_URI) : '',
      shutdownTimeoutMs: Number.isInteger(shutdownTimeoutMs) ? shutdownTimeoutMs : 5000,
      cors: buildCorsConfig(env),
      security: buildSecurityHeadersConfig(env, nodeEnv),
      requestLogging: buildRequestLoggingConfig(env),
    },
  };
}
