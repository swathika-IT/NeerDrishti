export interface LivenessPayload {
  status: 'ok';
  check: 'liveness';
  timestamp: string;
  uptime_seconds: number;
}

export interface ReadinessChecks {
  database: 'ok' | 'error';
  migrations: 'ok' | 'error' | 'unknown';
}

export interface ReadinessPayload {
  status: 'ready' | 'not_ready';
  check: 'readiness';
  timestamp: string;
  uptime_seconds: number;
  checks: ReadinessChecks;
}

export type ReadinessProbe = () => ReadinessChecks;

export function buildLivenessPayload(now: () => Date = () => new Date(), uptimeSeconds = process.uptime()): LivenessPayload {
  return {
    status: 'ok',
    check: 'liveness',
    timestamp: now().toISOString(),
    uptime_seconds: Math.max(0, Math.floor(uptimeSeconds)),
  };
}

export function buildReadinessPayload(
  probe: ReadinessProbe,
  now: () => Date = () => new Date(),
  uptimeSeconds = process.uptime()
): ReadinessPayload {
  let checks: ReadinessChecks;
  try {
    checks = probe();
  } catch {
    checks = { database: 'error', migrations: 'unknown' };
  }
  const ready = checks.database === 'ok' && checks.migrations === 'ok';
  return {
    status: ready ? 'ready' : 'not_ready',
    check: 'readiness',
    timestamp: now().toISOString(),
    uptime_seconds: Math.max(0, Math.floor(uptimeSeconds)),
    checks,
  };
}
