import type { RequestHandler } from 'express';
import type { CorsConfig } from '../config/security';

const ALLOWED_METHODS = 'GET,HEAD,POST,PATCH,DELETE,OPTIONS';
const ALLOWED_REQUEST_HEADERS = 'Content-Type,Authorization,X-Request-ID';

function appendVary(res: any, value: string): void {
  if (typeof res.vary === 'function') {
    res.vary(value);
    return;
  }
  const current = String(res.getHeader?.('Vary') || '');
  if (!current) {
    res.setHeader('Vary', value);
  } else if (!current.toLowerCase().split(',').map(item => item.trim()).includes(value.toLowerCase())) {
    res.setHeader('Vary', `${current}, ${value}`);
  }
}

function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function setCorsHeaders(res: any, origin: string, config: CorsConfig): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
  res.setHeader('Access-Control-Max-Age', String(config.maxAgeSeconds));
  if (config.allowCredentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  appendVary(res, 'Origin');
}

export function createCorsMiddleware(config: CorsConfig): RequestHandler {
  return (req, res, next) => {
    const originHeader = req.headers.origin;
    if (!originHeader) {
      next();
      return;
    }

    const origin = String(originHeader);
    if (isSameOrigin(origin, req.headers.host)) {
      next();
      return;
    }

    if (!config.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
      return;
    }

    setCorsHeaders(res, origin, config);
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.status(204).end();
      return;
    }
    next();
  };
}
