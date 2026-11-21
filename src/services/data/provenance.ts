import { DATA_SOURCES, FRESHNESS_THRESHOLDS } from '../../config/data_sources';
import { evaluateFreshness } from '../signal_validator';

export type DataOrigin = 'LIVE' | 'HISTORICAL' | 'FORECAST' | 'BASELINE' | 'SIMULATED';

export const DATA_ORIGIN_LABELS: Record<DataOrigin, string> = {
  LIVE: 'LIVE',
  HISTORICAL: 'HISTORICAL',
  FORECAST: 'FORECAST',
  BASELINE: 'BASELINE',
  SIMULATED: 'SIMULATED',
};

export type IntegrationStatus = 'CONNECTED' | 'NOT_CONFIGURED' | 'MANUAL_VERIFICATION' | 'LOCAL_ENGINE';

export interface FreshnessAssessment {
  status: 'FRESH' | 'AGING' | 'STALE' | 'EXPIRED' | 'INVALID';
  ageHours: number | null;
  factor: number;
  recordedAt: string | null;
}

export function assessFreshness(recordedAtIso: string | null | undefined): FreshnessAssessment {
  if (!recordedAtIso) {
    return { status: 'INVALID', ageHours: null, factor: 0, recordedAt: null };
  }
  const time = new Date(recordedAtIso).getTime();
  if (Number.isNaN(time)) {
    return { status: 'INVALID', ageHours: null, factor: 0, recordedAt: recordedAtIso };
  }
  const result = evaluateFreshness(recordedAtIso);
  return {
    status: result.status,
    ageHours: result.ageHours,
    factor: result.factor,
    recordedAt: new Date(time).toISOString(),
  };
}

export function freshnessForMode(recordedAtIso: string | null | undefined, mode: DataOrigin): FreshnessAssessment {
  const base = assessFreshness(recordedAtIso);
  if (mode === 'SIMULATED') {
    return { ...base, status: base.status === 'INVALID' ? 'INVALID' : 'FRESH', factor: base.factor };
  }
  if (mode === 'HISTORICAL' || mode === 'BASELINE' || mode === 'FORECAST') {
    return { ...base, factor: Math.min(base.factor, mode === 'FORECAST' ? 0.8 : 0.75) };
  }
  return base;
}

export function getRegistryEntryForSource(sourceName: string | null | undefined) {
  if (!sourceName) return undefined;
  const needle = sourceName.trim().toLowerCase();
  for (const entry of Object.values(DATA_SOURCES)) {
    if (entry.sourceName.trim().toLowerCase() === needle) return entry;
  }
  return undefined;
}

export function isSourceVerifiedLive(sourceName: string | null | undefined): boolean {
  const entry = getRegistryEntryForSource(sourceName);
  return Boolean(
    entry &&
    entry.enabled &&
    entry.integrationStatus === 'CONNECTED' &&
    entry.currentMode === 'LIVE'
  );
}

export function integrationStatusForSource(sourceName: string | null | undefined): IntegrationStatus {
  const entry = getRegistryEntryForSource(sourceName);
  if (!entry) return 'NOT_CONFIGURED';
  if (entry.integrationStatus) return entry.integrationStatus;
  return entry.currentMode === 'SIMULATED' ? 'LOCAL_ENGINE' : 'NOT_CONFIGURED';
}

export function attributionFor(sourceName: string | null | undefined, recordedAtIso: string | null | undefined): string {
  const name = sourceName?.trim() || 'Unspecified source';
  const entry = getRegistryEntryForSource(name);
  if (!entry) return `${name} (unregistered source — not verified)`;
  if (entry.integrationStatus === 'CONNECTED') return `${entry.sourceName} (integrated)`;
  if (entry.integrationStatus === 'MANUAL_VERIFICATION') return `${entry.sourceName} (manual verification required — not auto-integrated)`;
  if (entry.integrationStatus === 'LOCAL_ENGINE') return `${entry.sourceName} (local simulation engine)`;
  return `${entry.sourceName} (not connected)`;
}
