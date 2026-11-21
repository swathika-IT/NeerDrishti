import { tileImgSrcOrigins } from './map_config';
export interface CorsConfig {
  allowedOrigins: string[];
  allowCredentials: boolean;
  maxAgeSeconds: number;
}

export interface SecurityHeadersConfig {
  cspEnabled: boolean;
  hstsEnabled: boolean;
  isDevelopment: boolean;
}

export interface RequestLoggingConfig {
  enabled: boolean;
}

export interface CorsOriginParseResult {
  origins: string[];
  errors: string[];
}

export function parseBooleanValue(value: string | undefined | null): boolean | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  return parseBooleanValue(env[key]) ?? fallback;
}

function readInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const parsed = Number(env[key]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function parseCorsAllowedOrigins(raw: string | undefined): CorsOriginParseResult {
  const origins: string[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { origins, errors };
  }

  for (const entry of String(raw).split(',')) {
    const candidate = entry.trim();
    if (!candidate) continue;
    if (candidate === '*') {
      errors.push('CORS_ALLOWED_ORIGINS cannot contain a wildcard.');
      continue;
    }
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push('CORS_ALLOWED_ORIGINS entries must use http or https.');
        continue;
      }
      if (url.username || url.password) {
        errors.push('CORS_ALLOWED_ORIGINS entries must not contain credentials.');
        continue;
      }
      if (url.pathname !== '/' || url.search || url.hash) {
        errors.push('CORS_ALLOWED_ORIGINS entries must be exact origins without a path, query, or fragment.');
        continue;
      }
      const origin = url.origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      errors.push('CORS_ALLOWED_ORIGINS contains an invalid origin.');
    }
  }

  return { origins, errors };
}

export function buildCorsConfig(env: NodeJS.ProcessEnv = process.env): CorsConfig {
  const parsed = parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  return {
    allowedOrigins: parsed.origins,
    allowCredentials: readBoolean(env, 'CORS_ALLOW_CREDENTIALS', true),
    maxAgeSeconds: readInteger(env, 'CORS_MAX_AGE_SECONDS', 600, 0, 86400),
  };
}

export function buildSecurityHeadersConfig(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv: 'development' | 'test' | 'production' = 'development'
): SecurityHeadersConfig {
  return {
    cspEnabled: readBoolean(env, 'SECURITY_CSP_ENABLED', true),
    hstsEnabled: readBoolean(env, 'SECURITY_HSTS_ENABLED', false) && nodeEnv === 'production',
    isDevelopment: nodeEnv !== 'production',
  };
}

export function buildRequestLoggingConfig(env: NodeJS.ProcessEnv = process.env): RequestLoggingConfig {
  return {
    enabled: readBoolean(env, 'REQUEST_LOG_ENABLED', true),
  };
}

export function buildContentSecurityPolicy(isDevelopment: boolean): string {
  const scriptSources = isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self'";
  const connectSources = isDevelopment
    ? "connect-src 'self' ws: wss:"
    : "connect-src 'self'";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    scriptSources,
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob:", ...tileImgSrcOrigins()].join(' '),
    "font-src 'self' data:",
    connectSources,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');
}
