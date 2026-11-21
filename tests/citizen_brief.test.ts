import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCitizenContext, deterministicCitizenBrief, generateCitizenBrief, validateBrief, type CitizenContext } from '../src/services/ai_citizen_brief';
import { classifyRainfall24h, RISK_WEIGHTS } from '../src/config/risk_model';

const ctx: CitizenContext = {
  district: 'Bhadradri Kothagudem', rainfall_24h_mm: 130.5, rainfall_class: 'Very Heavy',
  risk_score: 76.9, risk_level: 'CRITICAL', main_risk_drivers: ['Rainfall', 'Flood history'],
  citizen_reports_24h: 3, verified_reports_scored: true, data_mode: 'SIMULATED', data_timestamp: null, data_quality: 'High',
};
const good = 'Bhadradri Kothagudem: HIGH FLOOD RISK\n1. About 130.5 mm rain in 24 hours.\n2. Roads may be waterlogged.\n3. Avoid flooded roads.\nContact district authorities or call 112.';

test('weights sum to exactly 1 and match the documented 35/25/15/15/10 split', () => {
  assert.equal(Math.round(Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0) * 1e6) / 1e6, 1);
  assert.deepEqual(RISK_WEIGHTS, { rainfall: 0.35, flood_history: 0.25, terrain: 0.15, citizen_reports: 0.15, drainage: 0.10 });
});

test('IMD classes: boundaries at 64.5 / 115.6 / 204.5 mm', () => {
  assert.equal(classifyRainfall24h(64.4), 'Moderate');
  assert.equal(classifyRainfall24h(64.5), 'Heavy');
  assert.equal(classifyRainfall24h(115.5), 'Heavy');
  assert.equal(classifyRainfall24h(115.6), 'Very Heavy');
  assert.equal(classifyRainfall24h(204.4), 'Very Heavy');
  assert.equal(classifyRainfall24h(204.5), 'Extremely Heavy');
  assert.equal(classifyRainfall24h(0), 'No Rain');
});

test('validator accepts a grounded answer', () => {
  assert.equal(validateBrief(good, ctx).ok, true);
});

test('validator rejects invented numbers, fake orders, missing 112 and overlong text', () => {
  assert.ok(validateBrief(good.replace('130.5', '250'), ctx).reasons.some(r => r.startsWith('unsupported_number')));
  assert.ok(validateBrief(good + ' Evacuate immediately.', ctx).reasons.some(r => r.startsWith('banned')));
  assert.ok(validateBrief('The government has ordered everyone out. 112', ctx).reasons.some(r => r.startsWith('banned')));
  assert.ok(validateBrief(good.replace('112', 'help'), ctx).reasons.includes('missing_112'));
  assert.ok(validateBrief(('word '.repeat(100)) + ' 112', ctx).reasons.some(r => r.startsWith('too_long')));
});

test('deterministic fallback passes its own validator in en/te/hi for every risk level', () => {
  for (const lang of ['en', 'te', 'hi'] as const)
    for (const lv of ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const) {
      const c = { ...ctx, risk_level: lv };
      const v = validateBrief(deterministicCitizenBrief(c, lang), c);
      assert.equal(v.ok, true, `${lang}/${lv}: ${v.reasons.join(',')}`);
    }
});

test('unavailable rainfall is stated, never fabricated', () => {
  const c = { ...ctx, rainfall_24h_mm: null, rainfall_class: 'Unavailable', data_mode: 'UNAVAILABLE' };
  const t = deterministicCitizenBrief(c, 'en');
  assert.match(t, /unavailable/i);
  assert.doesNotMatch(t, /\d+(\.\d+)? mm/);
});

test('LLM output that passes validation is used', async () => {
  const r = await generateCitizenBrief(ctx, 'en', undefined, async () => ({ text: good, model: 'mock', provider: 'mock', latencyMs: 1 }));
  assert.equal(r.source, 'llm');
});

test('hallucinated LLM output is rejected and falls back to deterministic', async () => {
  let calls = 0;
  const r = await generateCitizenBrief(ctx, 'en', undefined, async () => { calls++; return { text: good.replace('130.5', '999') , model: 'mock', provider: 'mock', latencyMs: 1 }; });
  assert.equal(r.source, 'deterministic');
  assert.equal(calls, 2, 'retried once');
  assert.match(r.fallback_reason || '', /unsupported_number/);
});

test('LLM down / throwing falls back without error', async () => {
  const a = await generateCitizenBrief(ctx, 'hi', undefined, async () => null);
  assert.equal(a.source, 'deterministic');
  const b = await generateCitizenBrief(ctx, 'te', undefined, async () => { throw new Error('boom'); });
  assert.equal(b.source, 'deterministic');
  assert.match(b.fallback_reason || '', /llm_error/);
});

test('buildCitizenContext picks top contributing drivers from real contributions', () => {
  const c = buildCitizenContext({ district: 'X', flood_risk_score: 50, risk_category: 'HIGH', rainfall_mm_24h: 70, contributions: { rainfall: 10, flood_history: 20, location_risk: 5, citizen_reports: 0, drainage_vulnerability: 1 } });
  assert.deepEqual(c.main_risk_drivers, ['Flood history', 'Rainfall']);
  assert.equal(c.rainfall_class, 'Heavy');
});
