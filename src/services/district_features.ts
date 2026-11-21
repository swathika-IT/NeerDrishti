/**
 * District static-feature store (flood history, terrain, drainage).
 *
 * Single source of truth for the three static risk factors. Every value
 * carries a provenance label so the UI/API never presents a prototype prior
 * or a proxy-derived number as an observed measurement.
 *
 * Provenance:
 *   DATASET       value came from an ingested, documented dataset
 *   EXPERT_PRIOR  hand-set prototype estimate (no dataset behind it yet)
 *   PROXY_DERIVED computed from a single proxy score (prototype_vulnerability_score)
 *   MISSING       no value available
 */
import fs from 'fs';
import path from 'path';

export type FeatureProvenance = 'DATASET' | 'EXPERT_PRIOR' | 'PROXY_DERIVED' | 'MISSING';
export type FeatureKey = 'flood_history' | 'terrain' | 'drainage';

export interface FeatureValue {
  score: number | null;
  provenance: FeatureProvenance;
  source: string;
  note?: string;
}

export interface DistrictFeatureRecord {
  district_id: string;
  district_name: string;
  flood_history: FeatureValue;
  terrain: FeatureValue;
  drainage: FeatureValue;
}

export interface DistrictFeatureFile {
  schema_version: 1;
  generated_at: string;
  notes: string;
  districts: Record<string, DistrictFeatureRecord>;
}

const FEATURE_PATH = path.join(process.cwd(), 'data', 'district_features.json');
let cache: DistrictFeatureFile | null = null;

export function loadDistrictFeatures(force = false): DistrictFeatureFile | null {
  if (cache && !force) return cache;
  try {
    if (!fs.existsSync(FEATURE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(FEATURE_PATH, 'utf-8')) as DistrictFeatureFile;
    if (parsed?.schema_version !== 1 || !parsed.districts) return null;
    cache = parsed;
    return cache;
  } catch (err) {
    console.warn('[district_features] could not load data/district_features.json:', err);
    return null;
  }
}

export function getDistrictFeatures(districtId: string): DistrictFeatureRecord | null {
  return loadDistrictFeatures()?.districts[districtId] ?? null;
}

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  flood_history: 'Historical flood frequency',
  terrain: 'Terrain vulnerability',
  drainage: 'Drainage vulnerability',
};

export interface CompletenessCell {
  status: 'OBSERVED' | 'ESTIMATED' | 'IMPUTED' | 'MISSING';
  provenance: FeatureProvenance;
  source: string;
  score: number | null;
}

/** Map provenance -> user-facing status. Never reports prior/proxy as OBSERVED. */
export function provenanceToStatus(p: FeatureProvenance): CompletenessCell['status'] {
  switch (p) {
    case 'DATASET': return 'OBSERVED';
    case 'EXPERT_PRIOR': return 'ESTIMATED';
    case 'PROXY_DERIVED': return 'IMPUTED';
    default: return 'MISSING';
  }
}
