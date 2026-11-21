import {
  UniversalSignal,
  SignalSelectionResult,
  SignalDataMode,
  SignalFreshness,
} from '../types/signals';
import { DATA_SOURCES, FRESHNESS_THRESHOLDS } from '../config/data_sources';
import { normalizeDistrict } from './district_normalizer';
import { validateSignal, evaluateFreshness } from './signal_validator';
import {
  getRegistryEntryForSource,
  isSourceVerifiedLive,
} from './data/provenance';
import {
  insertExternalSignal,
  getLatestRainfallSignal,
  detectDuplicateSignal,
} from '../db/sqlite';

export interface RawRainfallObservation {
  rawDistrict: string;
  rainfall_mm: number;
  burst_3h_mm?: number;
  unit?: string;
  sourceName?: string;
  sourceType?: string;
  dataMode?: SignalDataMode;
  timestamp?: string;
  metadata?: Record<string, any>;
}

export interface DistrictRainfallContext {
  districtId: string;
  districtName: string;
  rainfall_mm_24h: number;
  rainfall_mm_3h: number;
  sourceName: string;
  sourceType: string;
  dataMode: SignalDataMode;
  freshness: SignalFreshness;
  confidence: number;
  recordedAt: string;
  isSimulated: boolean;
  selectionReason: string;
  fallbackReason?: string;
}

export class RainfallService {
  /**
   * Ingests a raw external rainfall observation, normalizes the district,
   * validates bounds, computes freshness, avoids duplicate writes, and persists to SQLite.
   */
  public ingestObservation(raw: RawRainfallObservation): { success: boolean; signal?: UniversalSignal; error?: string } {
    // 1. District Normalization
    const norm = normalizeDistrict(raw.rawDistrict);
    if (!norm.resolved || !norm.districtId) {
      return { success: false, error: `Unresolved Telangana district: '${raw.rawDistrict}'` };
    }

    const recordedAt = raw.timestamp || new Date().toISOString();
    const requestedSourceName = (raw.sourceName || '').trim();
    const sourceName = requestedSourceName || 'Unspecified external source';
    const sourceType = (raw.sourceType || 'official_api') as any;
    const dataMode = raw.dataMode || 'LIVE';
    const unit = raw.unit || 'mm';
    const registryEntry = getRegistryEntryForSource(sourceName);
    const sourceVerifiedLive = isSourceVerifiedLive(sourceName);
    const sourceBaseConfidence = sourceVerifiedLive
      ? (registryEntry?.baseConfidence ?? 0.9)
      : 0.4;

    // 2. Freshness calculation
    const freshnessRes = evaluateFreshness(recordedAt);

    // 3. Validation
    const candidateSignal: UniversalSignal = {
      districtId: norm.districtId,
      sourceName,
      sourceType,
      signalType: 'rainfall',
      value: raw.rainfall_mm,
      unit,
      dataMode,
      freshness: freshnessRes.status,
      confidence: Math.round(freshnessRes.factor * sourceBaseConfidence * 100) / 100,
      isValid: true,
      recordedAt,
      ingestedAt: new Date().toISOString(),
      metadata: {
        rawDistrict: raw.rawDistrict,
        burst_3h_mm: raw.burst_3h_mm,
        matchType: norm.matchType,
        ...raw.metadata,
        source_verified: sourceVerifiedLive,
        source_known_in_registry: Boolean(registryEntry),
      },
    };

    const valRes = validateSignal(candidateSignal);
    candidateSignal.isValid = valRes.isValid;

    if (!valRes.isValid) {
      // Store invalid signal for audit trace if possible, but flag isValid=false
      try {
        insertExternalSignal({
          district_id: norm.districtId,
          source_name: sourceName,
          source_type: sourceType,
          signal_type: 'rainfall',
          value: raw.rainfall_mm,
          unit,
          data_mode: dataMode,
          freshness: freshnessRes.status,
          confidence: 0.0,
          is_valid: 0,
          recorded_at: recordedAt,
          metadata: { errors: valRes.errors, rawDistrict: raw.rawDistrict },
        });
      } catch (err) {
        // Safe fail
      }
      return { success: false, error: `Signal validation failed: ${valRes.errors.join(', ')}` };
    }

    // 4. Duplicate Check
    const isDup = detectDuplicateSignal(norm.districtId, sourceName, 'rainfall', recordedAt);
    if (!isDup) {
      insertExternalSignal({
        district_id: norm.districtId,
        source_name: sourceName,
        source_type: sourceType,
        signal_type: 'rainfall',
        value: candidateSignal.value,
        unit,
        data_mode: dataMode,
        freshness: candidateSignal.freshness,
        confidence: candidateSignal.confidence,
        is_valid: 1,
        recorded_at: recordedAt,
        metadata: candidateSignal.metadata,
      });
    }

    return { success: true, signal: candidateSignal };
  }

  /**
   * Transparently selects the authoritative rainfall signal for a district
   * using the rigorous priority hierarchy:
   * 1. Fresh Live Official Telemetry
   * 2. Aging Live Official Telemetry
   * 3. Verified Historical Baseline
   * 4. Simulated Scenario Telemetry
   */
  public selectRainfallForDistrict(
    districtId: string,
    districtName: string,
    simulatedRainfall24h: number,
    simulatedRainfall3h: number,
    scenarioName: string = 'Normal Conditions'
  ): DistrictRainfallContext {
    const norm = normalizeDistrict(districtId || districtName);
    const resolvedId = norm.resolved ? norm.districtId : districtId.toLowerCase();
    const resolvedName = norm.resolved ? norm.canonicalName : districtName;

    // Check latest valid signal stored in SQLite
    const latestDbSignal = getLatestRainfallSignal(resolvedId);
    let unverifiedSkipReason: string | undefined;
    const latestSourceVerifiedLive = latestDbSignal ? isSourceVerifiedLive(latestDbSignal.source_name) : false;

    if (latestDbSignal) {
      const freshnessRes = evaluateFreshness(latestDbSignal.recorded_at);

      // 1. Fresh Live Signal (0 - 3h) — only from a verified, integrated live source
      if (latestDbSignal.data_mode === 'LIVE' && !latestSourceVerifiedLive) {
        unverifiedSkipReason = `Latest LIVE signal from unverified source "${latestDbSignal.source_name}" was not trusted for live display.`;
      } else if (latestDbSignal.data_mode === 'LIVE' && freshnessRes.status === 'FRESH') {
        let burst = 0;
        try {
          if (latestDbSignal.metadata) {
            const meta = typeof latestDbSignal.metadata === 'string' ? JSON.parse(latestDbSignal.metadata) : latestDbSignal.metadata;
            burst = meta.burst_3h_mm || 0;
          }
        } catch (e) {}

        return {
          districtId: resolvedId,
          districtName: resolvedName,
          rainfall_mm_24h: latestDbSignal.value,
          rainfall_mm_3h: burst,
          sourceName: latestDbSignal.source_name,
          sourceType: latestDbSignal.source_type,
          dataMode: 'LIVE',
          freshness: 'FRESH',
          confidence: Math.round(latestDbSignal.confidence * 100) / 100,
          recordedAt: latestDbSignal.recorded_at,
          isSimulated: false,
          selectionReason: 'Authoritative fresh live meteorological telemetry stream.',
        };
      }

      // 2. Aging Live Signal (3 - 12h) — only from a verified, integrated live source
      if (latestDbSignal.data_mode === 'LIVE' && latestSourceVerifiedLive && freshnessRes.status === 'AGING') {
        let burst = 0;
        try {
          if (latestDbSignal.metadata) {
            const meta = typeof latestDbSignal.metadata === 'string' ? JSON.parse(latestDbSignal.metadata) : latestDbSignal.metadata;
            burst = meta.burst_3h_mm || 0;
          }
        } catch (e) {}

        return {
          districtId: resolvedId,
          districtName: resolvedName,
          rainfall_mm_24h: latestDbSignal.value,
          rainfall_mm_3h: burst,
          sourceName: latestDbSignal.source_name,
          sourceType: latestDbSignal.source_type,
          dataMode: 'LIVE',
          freshness: 'AGING',
          confidence: Math.round(latestDbSignal.confidence * freshnessRes.factor * 100) / 100,
          recordedAt: latestDbSignal.recorded_at,
          isSimulated: false,
          selectionReason: `Live observation from ${freshnessRes.ageHours} hours ago. Confidence attenuated by ${freshnessRes.factor}x.`,
        };
      }
      // 3. Verified Historical Baseline (any age, always labelled HISTORICAL)
      if (latestDbSignal.data_mode === 'HISTORICAL') {
        return {
          districtId: resolvedId,
          districtName: resolvedName,
          rainfall_mm_24h: latestDbSignal.value,
          rainfall_mm_3h: 0,
          sourceName: latestDbSignal.source_name,
          sourceType: latestDbSignal.source_type,
          dataMode: 'HISTORICAL',
          freshness: freshnessRes.status,
          confidence: Math.min(0.75, Math.round(latestDbSignal.confidence * 100) / 100),
          recordedAt: latestDbSignal.recorded_at,
          isSimulated: false,
          selectionReason: 'Historical baseline observation selected. Labelled HISTORICAL — not live telemetry.',
        };
      }
    }

    // 4. Transparent Simulation Fallback
    return {
      districtId: resolvedId,
      districtName: resolvedName,
      rainfall_mm_24h: simulatedRainfall24h,
      rainfall_mm_3h: simulatedRainfall3h,
      sourceName: DATA_SOURCES.NEERDRISHTI_SIMULATION_ENGINE.sourceName,
      sourceType: 'simulation_engine',
      dataMode: 'SIMULATED',
      freshness: 'FRESH',
      confidence: 0.60,
      recordedAt: new Date().toISOString(),
      isSimulated: true,
      selectionReason: `Simulation scenario '${scenarioName}' active. Live AWS telemetry stream currently unattached for this zone.`,
      fallbackReason: unverifiedSkipReason || 'No fresh verified live telemetry detected in external signals ledger.',
    };
  }
}

export const rainfallService = new RainfallService();
