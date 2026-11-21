import crypto from 'crypto';
import type { RequestHandler } from 'express';

export interface RequestLogEntry {
  type: 'http_request';
  request_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

export interface RequestLoggingOptions {
  enabled?: boolean;
  output?: (line: string) => void;
  now?: () => number;
  idFactory?: () => string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

function safePath(req: any): string {
  const raw = String(req.path || req.url || '/');
  const pathOnly = raw.split('?')[0].split('#')[0];
  return pathOnly.slice(0, 300) || '/';
}

export function createRequestLogger(options: RequestLoggingOptions = {}): RequestHandler {
  const enabled = options.enabled !== false;
  const output = options.output || ((line: string) => console.log(line));
  const now = options.now || Date.now;
  const idFactory = options.idFactory || (() => crypto.randomUUID());

  return (req, res, next) => {
    if (!enabled) {
      next();
      return;
    }

    const startedAt = now();
    const suppliedId = String(req.headers['x-request-id'] || '');
    const requestId = REQUEST_ID_PATTERN.test(suppliedId) ? suppliedId : idFactory();
    res.setHeader('X-Request-ID', requestId);

    let logged = false;
    const writeLog = () => {
      if (logged) return;
      logged = true;
      const entry: RequestLogEntry = {
        type: 'http_request',
        request_id: requestId,
        method: String(req.method || 'UNKNOWN').toUpperCase().slice(0, 16),
        path: safePath(req),
        status: Number(res.statusCode) || 0,
        duration_ms: Math.max(0, now() - startedAt),
      };
      output(JSON.stringify(entry));
    };

    res.once('finish', writeLog);
    res.once('close', writeLog);
    next();
  };
}
