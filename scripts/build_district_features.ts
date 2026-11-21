/**
 * Build data/district_features.json for all 33 districts.
 *
 * Baseline: reproduces the prototype values the risk engine already used
 * (5 priority districts = EXPERT_PRIOR; the other 28 = PROXY_DERIVED from
 * prototype_vulnerability_score), so building this file changes no scores.
 *
 * Real data: drop a CSV at data/raw/district_features_override.csv with
 *   district_id,flood_history_score,terrain_score,drainage_score,source,license
 * Any non-empty score replaces the prior and is marked DATASET.
 *
 * Usage: npx tsx scripts/build_district_features.ts
 */
import fs from 'fs';
import path from 'path';
import type { DistrictFeatureFile, DistrictFeatureRecord, FeatureValue } from '../src/services/district_features';

const root = process.cwd();
const meta: any[] = JSON.parse(fs.readFileSync(path.join(root, 'data/telangana_districts.json'), 'utf-8'));

const PRIORITY_PRIORS: Record<string, [number, number, number]> = {
  Hyderabad: [88, 75, 92],
  Warangal: [80, 70, 78],
  Nirmal: [85, 82, 65],
  Mancherial: [78, 80, 70],
  'Bhadradri Kothagudem': [92, 88, 74],
};
const PRIOR_SRC = 'NeerDrishti prototype expert prior (no dataset)';
const PROXY_SRC = 'Derived from prototype_vulnerability_score (single proxy)';

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',').map(s => s.trim());
  return lines.slice(1).filter(Boolean).map(l => {
    const c = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
}

const overridePath = path.join(root, 'data/raw/district_features_override.csv');
const overrides = new Map<string, Record<string, string>>();
if (fs.existsSync(overridePath)) {
  for (const r of parseCsv(fs.readFileSync(overridePath, 'utf-8'))) overrides.set(r.district_id, r);
  console.log(`[features] loaded ${overrides.size} override rows`);
}

const num = (s?: string) => (s !== undefined && s !== '' && Number.isFinite(Number(s)) ? Math.min(100, Math.max(0, Number(s))) : null);

const districts: Record<string, DistrictFeatureRecord> = {};
for (const m of meta) {
  const prior = PRIORITY_PRIORS[m.district_name];
  const vuln = m.prototype_vulnerability_score ?? 45;
  const base = (i: number, mult: number): FeatureValue =>
    m.monitoring_category === 'Priority Flood Monitoring' && prior
      ? { score: prior[i], provenance: 'EXPERT_PRIOR', source: PRIOR_SRC }
      : { score: Math.round(vuln * mult), provenance: 'PROXY_DERIVED', source: PROXY_SRC };
  const rec: DistrictFeatureRecord = {
    district_id: m.district_id,
    district_name: m.district_name,
    flood_history: base(0, 0.95),
    terrain: base(1, 0.90),
    drainage: base(2, 0.85),
  };
  const o = overrides.get(m.district_id);
  if (o) {
    const apply = (key: 'flood_history' | 'terrain' | 'drainage', col: string) => {
      const v = num(o[col]);
      if (v !== null) rec[key] = { score: v, provenance: 'DATASET', source: o.source || 'override CSV', note: o.license ? `licence: ${o.license}` : undefined };
    };
    apply('flood_history', 'flood_history_score');
    apply('terrain', 'terrain_score');
    apply('drainage', 'drainage_score');
  }
  districts[m.district_id] = rec;
}

const out: DistrictFeatureFile = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  notes: 'Static risk-factor inputs with per-value provenance. EXPERT_PRIOR/PROXY_DERIVED values are prototype estimates, not measurements.',
  districts,
};
fs.writeFileSync(path.join(root, 'data/district_features.json'), JSON.stringify(out, null, 2));
const counts: Record<string, number> = {};
Object.values(districts).forEach(d => ['flood_history', 'terrain', 'drainage'].forEach(k => { const p = (d as any)[k].provenance; counts[p] = (counts[p] || 0) + 1; }));
console.log('[features] wrote data/district_features.json', counts);
