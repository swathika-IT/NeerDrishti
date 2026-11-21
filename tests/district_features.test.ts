import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadDistrictFeatures, provenanceToStatus } from '../src/services/district_features';

const meta: any[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/telangana_districts.json'), 'utf-8'));

test('feature store covers exactly the 33 districts with consistent ids', () => {
  const f = loadDistrictFeatures(true);
  assert.ok(f, 'data/district_features.json must exist (npm run build:features)');
  assert.equal(meta.length, 33);
  assert.deepEqual(Object.keys(f!.districts).sort(), meta.map(m => m.district_id).sort());
});

test('every factor has a 0-100 score and a valid provenance label', () => {
  const f = loadDistrictFeatures()!;
  for (const rec of Object.values(f.districts))
    for (const k of ['flood_history', 'terrain', 'drainage'] as const) {
      const v = rec[k];
      assert.ok(['DATASET', 'EXPERT_PRIOR', 'PROXY_DERIVED', 'MISSING'].includes(v.provenance));
      if (v.provenance !== 'MISSING') assert.ok(v.score! >= 0 && v.score! <= 100, `${rec.district_name}.${k}`);
      assert.ok(v.source.length > 0);
    }
});

test('estimates and proxies are never reported as OBSERVED', () => {
  assert.equal(provenanceToStatus('EXPERT_PRIOR'), 'ESTIMATED');
  assert.equal(provenanceToStatus('PROXY_DERIVED'), 'IMPUTED');
  assert.equal(provenanceToStatus('MISSING'), 'MISSING');
  assert.equal(provenanceToStatus('DATASET'), 'OBSERVED');
});
