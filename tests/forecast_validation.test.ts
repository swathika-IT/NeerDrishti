import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectDistrictRisk,
  projectDistrictTimeline,
  evaluateForecastConfidence,
  classifyForecastRainfall,
} from '../src/services/forecast_service';

function makeStatus(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    district: 'Hyderabad',
    district_id: 'hyderabad',
    flood_risk_score: 45.0,
    risk_category: 'MODERATE',
    rainfall_mm_24h: 60.0,
    rainfall_mm_3h: 20.0,
    flood_history_score: 60.0,
    location_risk_score: 55.0,
    citizen_report_score: 20.0,
    drainage_vulnerability_score: 70.0,
    rainfall_freshness: 'FRESH',
    rainfall_data_mode: 'SIMULATED',
    ...overrides,
  };
}

test('missing hydrological_summary falls back to NORMAL without crashing', () => {
  const status = makeStatus({ hydrological_summary: undefined });
  const point = projectDistrictRisk(status, 6, undefined, 'SIMULATED_FORECAST', {});
  assert.ok(Number.isFinite(point.projectedRiskScore));
  assert.notEqual(point.outlookCategory, 'CRITICAL_PROJECTION');
  assert.equal(point.metadata?.hydroStatus, 'NORMAL');
});

test('missing rainfall freshness/mode still yields a bounded forecast', () => {
  const status = makeStatus({ rainfall_freshness: undefined, rainfall_data_mode: undefined });
  const point = projectDistrictRisk(status, 6, undefined, 'SIMULATED_FORECAST', {});
  assert.ok(point.projectedRiskScore >= 0 && point.projectedRiskScore <= 100);
  assert.ok(Number.isFinite(point.projectedRainfall_mm));
});

test('extreme rainfall is clamped, never NaN or above 100', () => {
  const status = makeStatus({ rainfall_mm_24h: 9999.0, rainfall_mm_3h: 999.0 });
  const point = projectDistrictRisk(status, 24, 9999.0, 'SIMULATED_FORECAST', {});
  assert.ok(point.projectedRiskScore <= 100);
  assert.ok(Number.isFinite(point.projectedRiskScore));
  assert.equal(point.projectedRainfallIntensity, 'EXTREME');
});

test('zero rainfall and zero risk yields a finite low projection', () => {
  const status = makeStatus({ flood_risk_score: 0, risk_category: 'LOW', rainfall_mm_24h: 0, rainfall_mm_3h: 0 });
  const point = projectDistrictRisk(status, 24, 0, 'SIMULATED_FORECAST', {});
  assert.ok(point.projectedRiskScore >= 0);
  assert.ok(Number.isFinite(point.projectedRiskScore));
});

test('forecast confidence ordering: FRESH >= AGING >= EXPIRED', () => {
  const fresh = evaluateForecastConfidence('LIVE', 'FRESH', 'FRESH', 'LIVE_FORECAST', 6);
  const aging = evaluateForecastConfidence('LIVE', 'AGING', 'AGING', 'LIVE_FORECAST', 6);
  const expired = evaluateForecastConfidence('LIVE', 'EXPIRED', 'EXPIRED', 'LIVE_FORECAST', 6);
  assert.ok(fresh.score >= aging.score);
  assert.ok(aging.score >= expired.score);
  for (const r of [fresh, aging, expired]) {
    assert.ok(r.score >= 0.10 && r.score <= 0.98);
  }
});

test('simulated forecasts cannot claim HIGH confidence; UNAVAILABLE is limited', () => {
  const sim = evaluateForecastConfidence('SIMULATED', 'FRESH', 'FRESH', 'SIMULATED_FORECAST', 24);
  assert.notEqual(sim.level, 'HIGH');
  const unavailable = evaluateForecastConfidence('UNAVAILABLE', 'EXPIRED', 'EXPIRED', 'UNAVAILABLE', 24);
  assert.ok(['LOW', 'LIMITED'].includes(unavailable.level));
});

test('forecast timestamps are ISO and validUntil honours the horizon', async () => {
  const status = makeStatus();
  const timeline = await projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST');
  for (const horizon of ['h3', 'h6', 'h12', 'h24'] as const) {
    const point = timeline.timeline[horizon];
    const gen = new Date(point.generatedAt).getTime();
    const until = new Date(point.validUntil).getTime();
    assert.ok(!Number.isNaN(gen) && !Number.isNaN(until));
    assert.equal(Math.round((until - gen) / 3600000), point.forecastHorizonHours);
  }
  assert.ok(!Number.isNaN(new Date(timeline.timeline.now.timestamp).getTime()));
  assert.ok(!Number.isNaN(new Date(timeline.generatedAt).getTime()));
});

test('default forecast data mode is SIMULATED_FORECAST, never silently LIVE', async () => {
  const status = makeStatus({ rainfall_data_mode: 'LIVE', rainfall_freshness: 'FRESH', rainfall_confidence: 0.9 });
  const timeline = await projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST');
  assert.equal(timeline.dataMode, 'SIMULATED_FORECAST');
  for (const horizon of ['h3', 'h6', 'h12', 'h24'] as const) {
    assert.equal(timeline.timeline[horizon].forecastDataMode, 'SIMULATED_FORECAST');
  }
});

test('timeline h6 point is consistent with direct projection', async () => {
  const status = makeStatus();
  const timeline = await projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST');
  const direct = projectDistrictRisk(status, 6, undefined, 'SIMULATED_FORECAST', {});
  assert.equal(timeline.timeline.h6.projectedRiskScore, direct.projectedRiskScore);
  assert.equal(timeline.timeline.h6.currentRiskScore, direct.currentRiskScore);
});

test('basin influence contribution is capped and non-negative', () => {
  const status = makeStatus();
  const point = projectDistrictRisk(status, 6, undefined, 'SIMULATED_FORECAST', {
    'TEL-NIR': { district_id: 'TEL-NIR', flood_risk_score: 99, rainfall_mm_24h: 500, hydrological_summary: { dominant_status: 'CRITICAL', dominant_trend: 'RISING' } },
  });
  assert.ok(point.basinInfluenceContribution <= 25.0);
  assert.ok(point.basinInfluenceContribution >= 0);
});

test('forecast disclaimer is present and states not an official warning', async () => {
  const status = makeStatus();
  const timeline = await projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST');
  assert.match(timeline.disclaimer, /not an official/i);
});

test('rainfall intensity classifier covers all bands including boundaries', () => {
  assert.equal(classifyForecastRainfall(-1), 'LIGHT');
  assert.equal(classifyForecastRainfall(15.5), 'MODERATE');
  assert.equal(classifyForecastRainfall(35.5), 'HEAVY');
  assert.equal(classifyForecastRainfall(64.5), 'VERY_HEAVY');
  assert.equal(classifyForecastRainfall(115.5), 'EXTREME');
});
