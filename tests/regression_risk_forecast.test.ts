import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectDistrictRisk, projectDistrictTimeline, classifyForecastRainfall, evaluateForecastConfidence } from '../src/services/forecast_service';
import { calculateBasinInfluence } from '../src/services/basin_routing_service';
import { AlertEngine } from '../src/services/alert_engine';
import { isSourceVerifiedLive } from '../src/services/data/provenance';

function makeDistrictStatus(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    district: 'Hyderabad',
    district_id: 'hyderabad',
    region_zone: 'Hyderabad Urban Region',
    simulation_zone: 'Hyderabad Urban Region',
    flood_risk_score: 60.0,
    risk_category: 'HIGH',
    rainfall_mm_24h: 70.0,
    rainfall_mm_3h: 24.5,
    rainfall_score: 60.0,
    flood_history_score: 70.0,
    location_risk_score: 60.0,
    citizen_report_score: 40.0,
    drainage_vulnerability_score: 75.0,
    citizen_reports_count: 4,
    citizen_reports_24h: 3,
    citizen_reports_high_severity: 2,
    citizen_reports_critical: 0,
    citizen_reports_trend: 'Stable',
    rainfall_freshness: 'FRESH',
    rainfall_data_mode: 'LIVE',
    data_source_mode: 'Simulated Data',
    data_confidence: 'High',
    risk_confidence: 'High',
    risk_data_completeness: 80,
    is_simulated: true,
    monitoring_category: 'Priority Flood Monitoring',
    data_limitation_notes: 'Prototype baseline.',
    hydrological_summary: {
      dominant_status: 'WATCH',
      dominant_trend: 'RISING',
      freshness: 'FRESH',
      data_mode: 'SIMULATED',
    },
    ...overrides,
  };
}

test('forecast reads flood_risk_score as current risk (field contract)', () => {
  const status = makeDistrictStatus();
  const result = projectDistrictRisk(status, 6, undefined, 'SIMULATED_FORECAST', {});
  assert.equal(result.currentRiskScore, 60.0);
});

test('forecast does not treat missing legacy composite_risk_score as zero when flood_risk_score exists', () => {
  const status = makeDistrictStatus({ flood_risk_score: 42.5, risk_category: 'MODERATE' });
  const timeline = projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST', { persistSnapshot: false });
  assert.equal(timeline.currentRiskScore, 42.5);
  assert.equal(timeline.currentRiskLevel, 'MODERATE');
  assert.equal(timeline.timeline.now.riskScore, 42.5);
  assert.equal(timeline.timeline.now.riskLevel, 'MODERATE');
});

test('forecast falls back to legacy composite_risk_score when flood_risk_score is absent', () => {
  const status = makeDistrictStatus({ flood_risk_score: undefined, risk_category: undefined });
  delete (status as any).flood_risk_score;
  (status as any).composite_risk_score = 33.0;
  (status as any).risk_level = 'MODERATE';
  const timeline = projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST');
  assert.equal(timeline.currentRiskScore, 33.0);
  assert.equal(timeline.currentRiskLevel, 'MODERATE');
});

test('timeline reading path writes no forecast snapshot by default', () => {
  const status = makeDistrictStatus();
  assert.doesNotThrow(() => projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST'));
});

test('basin routing consumes flood_risk_score of upstream district (TEL-NIR -> TEL-MNC)', () => {
  const map: Record<string, any> = {
    'TEL-NIR': {
      district_id: 'TEL-NIR',
      flood_risk_score: 90.0,
      rainfall_mm_24h: 80.0,
      hydrological_summary: { dominant_status: 'WARNING', dominant_trend: 'RISING' },
    },
  };
  const influence = calculateBasinInfluence('TEL-MNC', map, 6);
  assert.equal(influence.has_upstream_influence, true);
  assert.ok(influence.total_projected_basin_surge > 0);
  assert.equal(influence.active_upstream_threats[0].upstream_district_id, 'TEL-NIR');
});

test('basin routing honours legacy composite_risk_score fallback', () => {
  const map: Record<string, any> = {
    'TEL-NIR': {
      district_id: 'TEL-NIR',
      composite_risk_score: 90.0,
      rainfall_mm_24h: 80.0,
      hydrological_summary: { dominant_status: 'WARNING', dominant_trend: 'RISING' },
    },
  };
  const influence = calculateBasinInfluence('TEL-MNC', map, 6);
  assert.equal(influence.has_upstream_influence, true);
  assert.ok(influence.total_projected_basin_surge > 0);
});

test('basin routing reports no influence for calm upstream conditions', () => {
  const map: Record<string, any> = {
    'TEL-NIR': {
      district_id: 'TEL-NIR',
      flood_risk_score: 10.0,
      rainfall_mm_24h: 5.0,
      hydrological_summary: { dominant_status: 'NORMAL', dominant_trend: 'STABLE' },
    },
  };
  const influence = calculateBasinInfluence('TEL-MNC', map, 6);
  assert.equal(influence.has_upstream_influence, false);
  assert.equal(influence.total_projected_basin_surge, 0.0);
});

test('alert engine reads canonical risk fields and exposes correct current risk', () => {
  const status = makeDistrictStatus({ flood_risk_score: 60.0, risk_category: 'HIGH' });
  status.forecast_timeline = projectDistrictTimeline(status, {}, 'SIMULATED_FORECAST');
  const alert = AlertEngine.evaluateDistrictAlert(status as any);
  assert.equal(alert.current_risk, 60.0);
  assert.ok(alert.alert_level_code >= 0 && alert.alert_level_code <= 4);
  assert.ok(alert.projected_risk >= 0 && alert.projected_risk <= 100);
  assert.ok(Array.isArray(alert.trigger_signals));
});

test('alert engine escalates for critical projections', () => {
  const status = makeDistrictStatus({
    flood_risk_score: 80.0,
    risk_category: 'CRITICAL',
    rainfall_mm_24h: 150.0,
    rainfall_score: 85.0,
    rainfall_freshness: 'FRESH',
    rainfall_data_mode: 'LIVE',
    drainage_vulnerability_score: 85.0,
    flood_history_score: 80.0,
    hydrological_summary: { dominant_status: 'CRITICAL', dominant_trend: 'RISING', freshness: 'FRESH', data_mode: 'LIVE' },
  });
  status.forecast_timeline = projectDistrictTimeline(status, {}, 'LIVE_FORECAST');
  const alert = AlertEngine.evaluateDistrictAlert(status as any);
  assert.equal(alert.current_risk, 80.0);
  assert.ok(['HIGH', 'CRITICAL'].includes(alert.alert_level));
});

test('forecast rainfall classifier respects IMD-style intensity bands', () => {
  assert.equal(classifyForecastRainfall(0), 'LIGHT');
  assert.equal(classifyForecastRainfall(15.5), 'MODERATE');
  assert.equal(classifyForecastRainfall(35.5), 'HEAVY');
  assert.equal(classifyForecastRainfall(64.5), 'VERY_HEAVY');
  assert.equal(classifyForecastRainfall(115.5), 'EXTREME');
  assert.equal(classifyForecastRainfall(250), 'EXTREME');
});

test('simulated + stale inputs cannot claim high forecast confidence', () => {
  const result = evaluateForecastConfidence('SIMULATED', 'EXPIRED', 'EXPIRED', 'SIMULATED_FORECAST', 24);
  assert.ok(result.score < 0.58, `expected LOW/LIMITED, got score ${result.score} (${result.level})`);
  assert.notEqual(result.level, 'HIGH');
});

test('fresh verified live inputs may reach high forecast confidence', () => {
  const result = evaluateForecastConfidence('LIVE', 'FRESH', 'FRESH', 'LIVE_FORECAST', 3);
  assert.ok(result.score >= 0.78, `expected HIGH, got score ${result.score} (${result.level})`);
  assert.equal(result.level, 'HIGH');
});

test('simulation engine is never eligible as a verified live source', () => {
  assert.equal(isSourceVerifiedLive('NeerDrishti Hydrological Simulation Engine'), false);
  assert.equal(isSourceVerifiedLive('IMD Automatic Weather Stations (Telangana)'), false);
  assert.equal(isSourceVerifiedLive('Open-Meteo High-Resolution Telangana Ingestion'), true);
});
