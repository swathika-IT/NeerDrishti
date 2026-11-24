import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { validateEnvironment } from '../src/config/env_validation';
import {
  buildContentSecurityPolicy,
  buildCorsConfig,
  buildSecurityHeadersConfig,
  parseCorsAllowedOrigins,
} from '../src/config/security';
import { createSecurityHeadersMiddleware } from '../src/middleware/security_headers';
import { createCorsMiddleware } from '../src/middleware/cors';
import { createRequestLogger } from '../src/middleware/request_logging';
import { buildLivenessPayload, buildReadinessPayload } from '../src/services/health_service';
import { createGracefulShutdown } from '../src/services/graceful_shutdown';

function mockResponse() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    setHeader(name: string, value: any) {
      headers[name.toLowerCase()] = String(value);
      return this;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    vary(value: string) {
      headers.vary = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    body: undefined as any,
  };
}

function mockCorsRequest(method: string, origin: string | undefined, host = 'localhost:3000') {
  return {
    method,
    headers: {
      host,
      ...(origin ? { origin } : {}),
      ...(method === 'OPTIONS' ? { 'access-control-request-method': 'GET' } : {}),
    },
  } as any;
}

class MockLogResponse extends EventEmitter {
  headers: Record<string, string> = {};
  statusCode = 200;

  setHeader(name: string, value: any) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }
}

test('environment defaults fail fast without MONGODB_URI', () => {
  const result = validateEnvironment({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.key === 'MONGODB_URI'));
  assert.equal(result.config.port, 3000);
  assert.equal(result.config.requestLogging.enabled, true);
  assert.equal(result.config.security.cspEnabled, true);
  assert.equal(result.config.security.hstsEnabled, false);
  assert.deepEqual(result.config.cors.allowedOrigins, []);
});

test('MONGODB_URI accepts Atlas credentials', () => {
  const result = validateEnvironment({ MONGODB_URI: 'mongodb+srv://app_user:p%40ss@cluster.example.mongodb.net/neerdrishti_staging?retryWrites=true&w=majority' });
  assert.equal(result.valid, true);
});

test('MONGODB_URI accepts encoded special characters', () => {
  const result = validateEnvironment({ MONGODB_URI: 'mongodb://user:p%2Fss@localhost:27017/neerdrishti_staging' });
  assert.equal(result.valid, true);
});

test('MONGODB_URI rejects missing database name', () => {
  const result = validateEnvironment({ MONGODB_URI: 'mongodb+srv://app_user:secret@cluster.example.mongodb.net/' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.key === 'MONGODB_URI'));
});

test('MONGODB_URI rejects malformed URI', () => {
  const result = validateEnvironment({ MONGODB_URI: 'not-a-uri' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.key === 'MONGODB_URI'));
});

test('MONGODB_URI accepts SRV and replica-set formats', () => {
  assert.equal(validateEnvironment({ MONGODB_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/neerdrishti_staging?retryWrites=true&w=majority' }).valid, true);
  assert.equal(validateEnvironment({ MONGODB_URI: 'mongodb://host1:27017,host2:27017/neerdrishti_staging?replicaSet=rs0' }).valid, true);
});

test('environment validation rejects invalid numbers, booleans, and URLs without exposing values', () => {
  const result = validateEnvironment({
    PORT: 'not-a-port',
    MAIL_DRY_RUN: 'maybe',
    CAP_TIMEOUT_MS: '10',
    SMS_API_URL: 'not a url',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.key === 'PORT'));
  assert.ok(result.errors.some(error => error.key === 'MAIL_DRY_RUN'));
  assert.ok(result.errors.some(error => error.key === 'CAP_TIMEOUT_MS'));
  assert.ok(result.errors.some(error => error.key === 'SMS_API_URL'));
  assert.doesNotMatch(JSON.stringify(result.errors), /not-a-port|not a url/);
});

test('environment validation rejects wildcard, pathful, and credentialed CORS origins', () => {
  assert.ok(parseCorsAllowedOrigins('*').errors.length > 0);
  assert.ok(parseCorsAllowedOrigins('https://client.example/app').errors.length > 0);
  assert.ok(parseCorsAllowedOrigins('https://user:pass@client.example').errors.length > 0);
  assert.deepEqual(parseCorsAllowedOrigins('https://client.example, http://localhost:5173').origins, [
    'https://client.example',
    'http://localhost:5173',
  ]);
});

test('environment validation makes live notification enablement an error', () => {
  const result = validateEnvironment({ NOTIFICATION_LIVE_SEND_ENABLED: 'true' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.key === 'NOTIFICATION_LIVE_SEND_ENABLED'));
});

test('environment validation refuses production AUTH_DEV_EXPOSE_TOKENS', () => {
  const result = validateEnvironment({
    NODE_ENV: 'production',
    AUTH_DEV_EXPOSE_TOKENS: 'true',
    COOKIE_SECURE: 'false',
    DB_ALLOW_MEMORY_FALLBACK: 'true',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.key === 'AUTH_DEV_EXPOSE_TOKENS'));
  assert.ok(result.warnings.some(warning => warning.key === 'COOKIE_SECURE'));
  assert.ok(result.warnings.some(warning => warning.key === 'DB_ALLOW_MEMORY_FALLBACK'));
});

test('production CSP is strict and allows no third-party tile host unless MAP_TILE_URL is configured', () => {
  const prev = process.env.MAP_TILE_URL;
  try {
    delete process.env.MAP_TILE_URL;
    const csp = buildContentSecurityPolicy(false);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.match(csp, /img-src 'self' data: blob:;/);
    assert.doesNotMatch(csp, /cartocdn|openstreetmap/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    process.env.MAP_TILE_URL = 'https://tiles.example-provider.com/{z}/{x}/{y}.png?key=TESTKEY';
    assert.match(buildContentSecurityPolicy(false), /img-src 'self' data: blob: https:\/\/tiles\.example-provider\.com;/);
    process.env.MAP_TILE_URL = 'https://{s}.tiles.example-provider.com/{z}/{x}/{y}.png';
    assert.match(buildContentSecurityPolicy(false), /https:\/\/\*\.tiles\.example-provider\.com/);
  } finally {
    if (prev === undefined) delete process.env.MAP_TILE_URL; else process.env.MAP_TILE_URL = prev;
  }
});

test('map config: no provider by default, rejects http and invalid URLs, flags OSM tile server', async () => {
  const { getMapConfig } = await import('../src/config/map_config');
  assert.equal(getMapConfig({} as any).provider, 'none');
  assert.equal(getMapConfig({ MAP_TILE_URL: 'http://insecure/{z}/{x}/{y}.png' } as any).provider, 'none');
  assert.equal(getMapConfig({ MAP_TILE_URL: 'not a url' } as any).provider, 'none');
  const ok = getMapConfig({ MAP_TILE_URL: 'https://tiles.example.com/{z}/{x}/{y}.png', MAP_TILE_MAX_ZOOM: '99' } as any);
  assert.equal(ok.provider, 'custom'); assert.equal(ok.maxZoom, 19);
  assert.match(getMapConfig({ MAP_TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' } as any).warning || '', /403|restrict/i);
});

test('development CSP allows Vite HMR while keeping framing disabled', () => {
  const csp = buildContentSecurityPolicy(true);
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test('security headers middleware sets safe defaults and production HSTS', () => {
  const production = buildSecurityHeadersConfig({ SECURITY_HSTS_ENABLED: 'true' }, 'production');
  const res = mockResponse();
  let nextCalled = false;
  createSecurityHeadersMiddleware(production)({} as any, res as any, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
});

test('security headers middleware does not emit HSTS outside production', () => {
  const development = buildSecurityHeadersConfig({ SECURITY_HSTS_ENABLED: 'true' }, 'development');
  const res = mockResponse();
  createSecurityHeadersMiddleware(development)({} as any, res as any, () => {});
  assert.equal(res.headers['strict-transport-security'], undefined);
});

test('CORS allows same-origin and no-Origin requests without cross-origin headers', () => {
  const config = buildCorsConfig({ CORS_ALLOWED_ORIGINS: 'https://client.example' });
  const sameOriginRes = mockResponse();
  const sameOriginReq = mockCorsRequest('GET', 'http://localhost:3000');
  let sameNext = false;
  createCorsMiddleware(config)(sameOriginReq, sameOriginRes as any, () => {
    sameNext = true;
  });
  assert.equal(sameNext, true);
  assert.equal(sameOriginRes.headers['access-control-allow-origin'], undefined);

  const noOriginRes = mockResponse();
  let noOriginNext = false;
  createCorsMiddleware(config)(mockCorsRequest('GET', undefined), noOriginRes as any, () => {
    noOriginNext = true;
  });
  assert.equal(noOriginNext, true);
});

test('CORS returns headers and preflight success for an exact allowlisted origin', () => {
  const config = buildCorsConfig({
    CORS_ALLOWED_ORIGINS: 'https://client.example',
    CORS_ALLOW_CREDENTIALS: 'true',
    CORS_MAX_AGE_SECONDS: '600',
  });
  const simpleRes = mockResponse();
  let nextOnly = false;
  const simpleReq = mockCorsRequest('GET', 'https://client.example');
  createCorsMiddleware(config)(simpleReq, simpleRes as any, () => {
    nextOnly = true;
  });
  assert.equal(nextOnly, true);
  assert.equal(simpleRes.headers['access-control-allow-origin'], 'https://client.example');
  assert.equal(simpleRes.headers['access-control-allow-credentials'], 'true');

  const preflightRes = mockResponse();
  let preflightNext = false;
  const preflightReq = mockCorsRequest('OPTIONS', 'https://client.example');
  createCorsMiddleware(config)(preflightReq, preflightRes as any, () => {
    preflightNext = true;
  });
  assert.equal(preflightNext, false);
  assert.equal(preflightRes.statusCode, 204);
  assert.equal(preflightRes.headers['access-control-allow-origin'], 'https://client.example');
});

test('CORS rejects a disallowed origin without reflecting it', () => {
  const config = buildCorsConfig({ CORS_ALLOWED_ORIGINS: 'https://client.example' });
  const res = mockResponse();
  let nextCalled = false;
  createCorsMiddleware(config)(mockCorsRequest('GET', 'https://evil.example'), res as any, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(res.body, { error: 'Origin not allowed by CORS policy.' });
});

test('request logger records only method, path, status, duration, and request ID', () => {
  const lines: string[] = [];
  const res = new MockLogResponse();
  const req = {
    method: 'POST',
    path: '/api/auth/login',
    url: '/api/auth/login?password=secret&token=secret',
    headers: {
      cookie: 'nd_session=secret',
      authorization: 'Bearer secret',
      'x-request-id': 'hardening-request-1',
    },
  } as any;
  const times = [1000, 1042];
  let nextCalled = false;
  const middleware = createRequestLogger({
    output: line => lines.push(line),
    now: () => times.shift() ?? 1042,
  });
  middleware(req, res as any, () => {
    nextCalled = true;
  });
  res.emit('finish');
  assert.equal(nextCalled, true);
  assert.equal(res.headers['x-request-id'], 'hardening-request-1');
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed, {
    type: 'http_request',
    request_id: 'hardening-request-1',
    method: 'POST',
    path: '/api/auth/login',
    status: 200,
    duration_ms: 42,
  });
  assert.doesNotMatch(lines[0], /secret|password=|cookie|authorization/i);
});

test('request logger can be disabled and does not log or set a request ID', () => {
  const lines: string[] = [];
  const res = new MockLogResponse();
  let nextCalled = false;
  createRequestLogger({ enabled: false, output: line => lines.push(line) })(
    { method: 'GET', path: '/api/health', url: '/api/health', headers: {} } as any,
    res as any,
    () => {
      nextCalled = true;
    }
  );
  res.emit('finish');
  assert.equal(nextCalled, true);
  assert.deepEqual(lines, []);
  assert.equal(res.headers['x-request-id'], undefined);
});

test('liveness payload is minimal and contains no configuration data', () => {
  const payload = buildLivenessPayload(() => new Date('2026-11-05T00:00:00.000Z'), 12.9);
  assert.deepEqual(payload, {
    status: 'ok',
    check: 'liveness',
    timestamp: '2026-11-05T00:00:00.000Z',
    uptime_seconds: 12,
  });
});

test('readiness payload reports database and migration checks', () => {
  const payload = buildReadinessPayload(
    () => ({ database: 'ok', migrations: 'ok' }),
    () => new Date('2026-11-05T00:00:00.000Z'),
    10
  );
  assert.equal(payload.status, 'ready');
  assert.deepEqual(payload.checks, { database: 'ok', migrations: 'ok' });
});

test('readiness payload reports not_ready without exposing probe errors', () => {
  const payload = buildReadinessPayload(() => {
    throw new Error('token=secret database exploded');
  });
  assert.equal(payload.status, 'not_ready');
  assert.deepEqual(payload.checks, { database: 'error', migrations: 'unknown' });
  assert.doesNotMatch(JSON.stringify(payload), /secret|exploded/);
});

test('graceful shutdown stops jobs, closes the server and database, and exits zero', async () => {
  const calls: string[] = [];
  const controller = createGracefulShutdown({
    server: {
      close: callback => {
        calls.push('server.close');
        callback();
      },
      closeIdleConnections: () => calls.push('server.idle'),
    },
    stopBackgroundJobs: () => {
      calls.push('jobs.stop');
    },
    closeDatabase: () => calls.push('db.close'),
    logger: { info: () => {}, error: () => {} },
    exit: code => calls.push(`exit:${code}`),
    timeoutMs: 100,
  });
  await controller.shutdown('SIGTERM');
  assert.deepEqual(calls, ['jobs.stop', 'server.idle', 'server.close', 'db.close', 'exit:0']);
  assert.equal(controller.isShuttingDown(), true);
});

test('graceful shutdown forces slow connections and exits nonzero after timeout', async () => {
  const calls: string[] = [];
  const controller = createGracefulShutdown({
    server: {
      close: () => calls.push('server.close'),
      closeIdleConnections: () => calls.push('server.idle'),
      closeAllConnections: () => calls.push('server.force'),
    },
    stopBackgroundJobs: () => {
      calls.push('jobs.stop');
    },
    closeDatabase: () => calls.push('db.close'),
    logger: { info: () => {}, error: () => {} },
    exit: code => calls.push(`exit:${code}`),
    timeoutMs: 10,
  });
  await controller.shutdown('SIGINT');
  assert.deepEqual(calls, ['jobs.stop', 'server.idle', 'server.close', 'server.force', 'db.close', 'exit:1']);
});
