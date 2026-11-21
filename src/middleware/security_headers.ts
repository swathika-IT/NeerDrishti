import type { RequestHandler } from 'express';
import { buildContentSecurityPolicy, type SecurityHeadersConfig } from '../config/security';

export function createSecurityHeadersMiddleware(config: SecurityHeadersConfig): RequestHandler {
  const csp = buildContentSecurityPolicy(config.isDevelopment);

  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-XSS-Protection', '0');

    if (config.cspEnabled) {
      res.setHeader('Content-Security-Policy', csp);
    }
    if (config.hstsEnabled) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  };
}
