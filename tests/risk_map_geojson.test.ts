import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DistrictSummary } from '../src/types';
import {
  buildTelanganaTelemetryGeoJson,
  getRiskColor,
  isValidGeoJsonFeatureCollection,
  matchGeoJsonFeatureToDistrict,
  validateTelanganaBoundaries,
} from '../src/lib/geojsonBuilder';
import { STRINGS } from '../src/i18n';

const metadata = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data/telangana_districts.json'), 'utf-8'),
) as Array<Record<string, any>>;
const districts = metadata as unknown as DistrictSummary[];

function nameOf(district: DistrictSummary | null): string | undefined {
  return (district as any)?.district || (district as any)?.district_name;
}

function polygonFor(record: Record<string, any>, properties: Record<string, unknown> = {}) {
  const lat = Number(record.latitude);
  const lng = Number(record.longitude);
  const d = 0.04;
  return {
    type: 'Feature',
    properties: { district_id: record.district_id, district_name: record.district_name, ...properties },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lng - d, lat - d],
        [lng + d, lat - d],
        [lng + d, lat + d],
        [lng - d, lat + d],
        [lng - d, lat - d],
      ]],
    },
  };
}

function allDistrictPolygons() {
  return metadata.map((record, index) => {
    const alias = [
      { district_id: record.district_id },
      { district: record.district_name },
      { DTNAME: record.district_name },
      { NAME: record.district_name },
    ][index % 4];
    return polygonFor(record, alias);
  });
}

test('canonical district metadata contains exactly 33 distinct IDs', () => {
  assert.equal(metadata.length, 33);
  const ids = metadata.map(record => record.district_id);
  assert.equal(new Set(ids).size, 33);
  assert.ok(ids.includes('mulugu'));
  assert.ok(ids.includes('narayanpet'));
});

test('validator confirms all 33 supplied district polygons and property aliases', () => {
  const boundaries = { type: 'FeatureCollection', features: allDistrictPolygons() };
  assert.equal(isValidGeoJsonFeatureCollection(boundaries), true);
  const validation = validateTelanganaBoundaries(boundaries, districts);
  assert.equal(validation.totalFeatures, 33);
  assert.equal(validation.boundaryFeatures, 33);
  assert.equal(validation.matchedDistrictIds.length, 33);
  assert.deepEqual(validation.missingDistrictIds, []);
  assert.deepEqual(validation.duplicateDistrictIds, []);
  assert.deepEqual(validation.unmatchedDistrictIds, []);
  assert.deepEqual(validation.invalidGeometries, []);
  assert.deepEqual(validation.outOfExtentGeometries, []);
  assert.equal(validation.matchesAllDistricts, true);
  assert.equal(validation.valid, true);
});

test('matchGeoJsonFeatureToDistrict resolves canonical IDs, legacy codes, and names', () => {
  assert.equal(nameOf(matchGeoJsonFeatureToDistrict(polygonFor(metadata[0]), districts)), metadata[0].district_name);
  assert.equal(
    nameOf(matchGeoJsonFeatureToDistrict({ type: 'Feature', properties: { DTNAME: 'Warangal' }, geometry: null }, districts)),
    'Warangal',
  );
  assert.equal(
    nameOf(matchGeoJsonFeatureToDistrict({ type: 'Feature', properties: { upstream_district_id: 'TEL-NIR' }, geometry: null }, districts)),
    'Nirmal',
  );
  assert.equal(
    nameOf(matchGeoJsonFeatureToDistrict({ type: 'Feature', properties: { district_id: 'TEL-HYD' }, geometry: null }, districts)),
    'Hyderabad',
  );
  assert.equal(matchGeoJsonFeatureToDistrict({ type: 'Feature', properties: { district_id: 'unknown' }, geometry: null }, districts), null);
});

test('builder preserves polygons and does not replace boundaries with centroid points', () => {
  const boundaries = { type: 'FeatureCollection', features: [polygonFor(metadata[0])] };
  const collection = buildTelanganaTelemetryGeoJson({ districts, boundaries });
  const polygonFeatures = collection.features.filter(f => f.properties.feature_type === 'district_boundary');
  assert.equal(polygonFeatures.length, 1);
  assert.equal(polygonFeatures[0].geometry?.type, 'Polygon');
  assert.equal(polygonFeatures[0].properties.geometry_basis, 'SUPPLIED_BOUNDARY');
  assert.equal(polygonFeatures[0].properties.risk_category, districts[0].risk_category);
  assert.equal(
    collection.features.some(f => f.properties.feature_type === 'district_boundary' && f.geometry?.type === 'Point'),
    false,
  );
});

test('builder adds stations, basin connections, and only verified reports', () => {
  const station = {
    station_id: 'STN-1',
    station_name: 'Test Gauge',
    district_id: metadata[0].district_id,
    latitude: metadata[0].latitude,
    longitude: metadata[0].longitude,
    source: 'Registry',
  };
  const connection = {
    connection_id: 'BASIN-1',
    upstream_district_id: 'TEL-HYD',
    downstream_district_id: metadata[1].district_id,
    source: 'Basin registry',
    data_mode: 'HISTORICAL',
  };
  const reports = [
    { id: 1, status: 'VERIFIED', lat: metadata[0].latitude, lng: metadata[0].longitude, incident_type: 'Road Flooding' },
    { id: 2, status: 'PENDING', lat: metadata[0].latitude, lng: metadata[0].longitude, incident_type: 'Road Flooding' },
  ];
  const collection = buildTelanganaTelemetryGeoJson({
    districts,
    hydrologicalStations: [station],
    basinConnections: [connection],
    citizenReports: reports,
  });
  const stations = collection.features.filter(f => f.properties.feature_type === 'hydrological_station');
  const basins = collection.features.filter(f => f.properties.feature_type === 'basin_connection');
  const verified = collection.features.filter(f => f.properties.feature_type === 'verified_citizen_report');
  assert.equal(stations.length, 1);
  assert.equal(stations[0].properties.data_status, 'REFERENCE');
  assert.equal(stations[0].geometry?.type, 'Point');
  assert.equal(basins.length, 1);
  assert.equal(basins[0].geometry?.type, 'LineString');
  assert.equal(basins[0].properties.geometry_basis, 'DISTRICT_CENTER');
  assert.equal(verified.length, 1);
  assert.equal(verified[0].properties.data_status, 'VERIFIED');
});

test('invalid, out-of-extent, and point-only boundary data are rejected', () => {
  assert.equal(isValidGeoJsonFeatureCollection({ type: 'FeatureCollection', features: [] }), true);
  assert.equal(isValidGeoJsonFeatureCollection({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ['invalid', 17] } }],
  }), false);
  assert.equal(isValidGeoJsonFeatureCollection({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {} }] }), false);

  const pointOnly = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { district_id: metadata[0].district_id },
      geometry: { type: 'Point', coordinates: [metadata[0].longitude, metadata[0].latitude] },
    }],
  };
  const pointValidation = validateTelanganaBoundaries(pointOnly, districts);
  assert.equal(pointValidation.valid, false);
  assert.deepEqual(pointValidation.nonPolygonFeatures, [metadata[0].district_name]);
  assert.equal(buildTelanganaTelemetryGeoJson({ districts, boundaries: pointOnly }).features.length, 0);

  const outside = polygonFor(metadata[0]);
  outside.geometry.coordinates[0][0] = [99, 25];
  const outsideValidation = validateTelanganaBoundaries({ type: 'FeatureCollection', features: [outside] }, districts);
  assert.equal(outsideValidation.valid, false);
  assert.equal(outsideValidation.outOfExtentGeometries.length, 1);
});

test('missing and duplicate districts are reported and no geometry is fabricated', () => {
  const features = allDistrictPolygons();
  features.pop();
  features.push(polygonFor(metadata[0]));
  const boundaries = { type: 'FeatureCollection', features };
  const validation = validateTelanganaBoundaries(boundaries, districts);
  assert.equal(validation.valid, false);
  assert.equal(validation.duplicateDistrictIds.length, 1);
  assert.equal(validation.missingDistrictIds.length, 1);
  assert.equal(validation.matchesAllDistricts, false);

  const empty = buildTelanganaTelemetryGeoJson({ districts, boundaries: null });
  assert.deepEqual(empty.features, []);
  assert.equal(empty.validation.canonicalDistrictCount, 33);
  assert.equal(empty.validation.matchesAllDistricts, false);

  const noDistricts = buildTelanganaTelemetryGeoJson({ districts: [], boundaries });
  assert.deepEqual(noDistricts.features, []);
});

test('risk colors cover SAFE/LOW through CRITICAL and unknown categories', () => {
  assert.equal(getRiskColor('SAFE'), '#10b981');
  assert.equal(getRiskColor('LOW'), '#10b981');
  assert.equal(getRiskColor('MODERATE'), '#f59e0b');
  assert.equal(getRiskColor('HIGH'), '#f97316');
  assert.equal(getRiskColor('CRITICAL'), '#ef4444');
  assert.equal(getRiskColor('UNKNOWN'), '#94a3b8');
});

test('map translations exist in English, Telugu, and Hindi', () => {
  const required = [
    'mapTitle', 'mapSubtitle', 'mapDistrictSearch', 'mapRiskLegend', 'mapSelectedDistrict',
    'mapRainfall', 'mapFloodRiskScore', 'mapHydrologicalStations', 'mapVerifiedReports',
    'mapLoading', 'mapUnavailable', 'mapError', 'mapEmptyDistricts', 'mapBoundariesMissing',
  ];
  for (const language of ['en', 'te', 'hi'] as const) {
    for (const key of required) {
      assert.ok(typeof STRINGS[language][key] === 'string' && STRINGS[language][key].length > 0, `${language}.${key}`);
    }
  }
  const enKeys = Object.keys(STRINGS.en).filter(key => key.startsWith('map')).sort();
  assert.deepEqual(Object.keys(STRINGS.te).filter(key => key.startsWith('map')).sort(), enKeys);
  assert.deepEqual(Object.keys(STRINGS.hi).filter(key => key.startsWith('map')).sort(), enKeys);
});

test('real 33-district boundary dataset is validated when supplied', t => {
  const realPath = path.join(process.cwd(), 'data/processed/geographic/telangana_districts.geojson');
  if (!fs.existsSync(realPath)) {
    t.skip('data/processed/geographic/telangana_districts.geojson is not present in this repository');
    return;
  }
  const boundaries = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  assert.equal(isValidGeoJsonFeatureCollection(boundaries), true);
  const validation = validateTelanganaBoundaries(boundaries, districts);
  assert.equal(validation.totalFeatures, 33);
  assert.equal(validation.matchedDistrictIds.length, 33);
  assert.deepEqual(validation.missingDistrictIds, []);
  assert.deepEqual(validation.duplicateDistrictIds, []);
  assert.deepEqual(validation.outOfExtentGeometries, []);
  assert.equal(validation.valid, true);
});

test('processed boundaries join real risk data, provenance, and legend colors', () => {
  const realPath = path.join(process.cwd(), 'data/processed/geographic/telangana_districts.geojson');
  assert.ok(fs.existsSync(realPath), 'processed boundary GeoJSON must be present');
  const boundaries = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  const riskCategories = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;
  const riskDistricts = districts.map((district, index) => ({
    ...district,
    risk_category: riskCategories[index % riskCategories.length],
    flood_risk_score: 20 + index,
    rainfall_mm_24h: 5 + index,
    rainfall_data_mode: 'SIMULATED',
  })) as DistrictSummary[];
  const collection = buildTelanganaTelemetryGeoJson({ districts: riskDistricts, boundaries });
  const boundaryFeatures = collection.features.filter(f => f.properties.feature_type === 'district_boundary');
  assert.equal(collection.validation.valid, true);
  assert.equal(boundaryFeatures.length, 33);

  const byName = new Map(riskDistricts.map(district => [nameOf(district) || '', district]));
  const colors: Record<string, string> = {
    SAFE: '#10b981', LOW: '#10b981', MODERATE: '#f59e0b', HIGH: '#f97316', CRITICAL: '#ef4444',
  };
  for (const feature of boundaryFeatures) {
    const district = byName.get(String(feature.properties.label));
    assert.ok(district, `unknown district: ${feature.properties.label}`);
    assert.equal(feature.properties.district_id, (district as any).district_id);
    assert.equal(feature.properties.risk_category, district.risk_category);
    assert.equal(feature.properties.flood_risk_score, district.flood_risk_score);
    assert.equal(feature.properties.rainfall_mm_24h, district.rainfall_mm_24h);
    assert.equal(feature.properties.rainfall_data_mode, district.rainfall_data_mode);
    assert.equal(getRiskColor(feature.properties.risk_category), colors[String(district.risk_category).toUpperCase()]);
    assert.equal(feature.properties.geometry_basis, 'SUPPLIED_BOUNDARY');
    assert.equal(feature.properties.data_status, 'REFERENCE');
    assert.match(String(feature.properties.source), /NWIC|Survey of India|District Boundary/i);
    assert.match(String(feature.properties.source_detail), /Other \(Open\)/);
  }
});
