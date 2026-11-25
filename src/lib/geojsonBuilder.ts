import type { DistrictSummary } from '../types';

export const TELANGANA_EXTENT = {
  minLat: 15.7,
  maxLat: 19.95,
  minLng: 77.2,
  maxLng: 81.35,
} as const;

export const DISTRICT_PROPERTY_ALIASES = [
  'district_id',
  'districtId',
  'DISTRICT_ID',
  'district_code',
  'districtCode',
  'DTCODE',
  'canonical_id',
  'canonicalId',
  'district',
  'district_name',
  'districtName',
  'DISTRICT',
  'DTNAME',
  'dist_name',
  'distname',
  'NAME',
  'name',
  'upstream_district_id',
  'downstream_district_id',
  'upstream_district',
  'downstream_district',
] as const;

const DISTRICT_ID_ALIASES: Record<string, string> = {
  telbdk: 'bhadradri_kothagudem',
  telhyd: 'hyderabad',
  teljog: 'jogulamba_gadwal',
  teljys: 'jayashankar_bhupalpally',
  telkhm: 'khammam',
  telkrm: 'karimnagar',
  telmhb: 'mahabubabad',
  telmnc: 'mancherial',
  telngk: 'nagarkurnool',
  telnir: 'nirmal',
  telnlg: 'nalgonda',
  telped: 'peddapalli',
  telrjs: 'rajanna_sircilla',
  telrng: 'rangareddy',
  telvkr: 'vikarabad',
  telwnp: 'wanaparthy',
  telwru: 'warangal',
  telyad: 'yadadri_bhuvanagiri',
};

export type TelemetryGeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon';

export interface TelemetryFeatureProps {
  feature_type: 'district_boundary' | 'hydrological_station' | 'basin_connection' | 'verified_citizen_report';
  feature_id: string;
  label: string;
  district_id?: string;
  district_name?: string;
  risk_category?: string;
  flood_risk_score?: number;
  rainfall_mm_24h?: number;
  rainfall_data_mode?: string;
  rainfall_source?: string;
  data_source_mode?: string;
  data_provenance?: string;
  data_status: 'VERIFIED' | 'REPORTED' | 'REFERENCE' | 'DERIVED' | 'UNAVAILABLE';
  data_mode?: string;
  source?: string;
  source_detail?: string;
  details?: string;
  geometry_basis?: 'SUPPLIED_BOUNDARY' | 'DISTRICT_CENTER' | 'STATION_COORDINATE' | 'REPORT_COORDINATE';
  upstream_district_id?: string;
  downstream_district_id?: string;
  [key: string]: unknown;
}

export interface TelemetryFeature {
  type: 'Feature';
  id?: string | number;
  geometry: {
    type: TelemetryGeometryType;
    coordinates: unknown;
  } | null;
  properties: TelemetryFeatureProps;
}

export interface TelemetryFeatureCollection {
  type: 'FeatureCollection';
  features: TelemetryFeature[];
  source?: string;
  provenance?: string;
  validation?: BoundaryValidation;
  [key: string]: unknown;
}

export interface BoundaryValidation {
  valid: boolean;
  totalFeatures: number;
  boundaryFeatures: number;
  canonicalDistrictCount: number;
  matchedDistrictIds: string[];
  duplicateDistrictIds: string[];
  unmatchedDistrictIds: string[];
  missingDistrictIds: string[];
  invalidGeometries: string[];
  outOfExtentGeometries: string[];
  nonPolygonFeatures: string[];
  matchesAllDistricts: boolean;
}

export interface BuildTelemetryOptions {
  districts: readonly DistrictSummary[];
  boundaries?: unknown;
  hydrologicalStations?: readonly unknown[];
  basinConnections?: readonly unknown[];
  citizenReports?: readonly unknown[];
}

const RISK_COLORS: Record<string, string> = {
  SAFE: '#10b981',
  LOW: '#10b981',
  MODERATE: '#f59e0b',
  HIGH: '#f97316',
  CRITICAL: '#ef4444',
};

export const UNKNOWN_RISK_COLOR = '#94a3b8';

export function getRiskColor(category?: string | null): string {
  return RISK_COLORS[String(category || '').toUpperCase()] || UNKNOWN_RISK_COLOR;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function readCandidateKeys(feature: unknown): string[] {
  if (!isRecord(feature) || !isRecord(feature.properties)) return [];
  const props = feature.properties;
  const values = DISTRICT_PROPERTY_ALIASES.map(alias => props[alias]).filter(v => v !== undefined && v !== null);
  const nested = props.district;
  if (isRecord(nested)) {
    values.push(nested.district_id, nested.districtId, nested.district_name, nested.name);
  }
  return values.map(normalizeKey).filter(Boolean);
}

export function matchGeoJsonFeatureToDistrict(
  feature: unknown,
  districts: readonly DistrictSummary[],
): DistrictSummary | null {
  const candidates = readCandidateKeys(feature);
  if (!candidates.length) return null;

  const byNormalized = new Map<string, DistrictSummary>();
  for (const district of districts) {
    const record = district as unknown as Record<string, unknown>;
    const values = [
      record.district_id,
      record.district,
      record.district_name,
      (district as any).districtId,
      (district as any).canonical_id,
    ];
    for (const value of values) {
      const key = normalizeKey(value);
      if (key && !byNormalized.has(key)) byNormalized.set(key, district);
    }
  }

  for (const candidate of candidates) {
    const alias = DISTRICT_ID_ALIASES[candidate];
    if (alias) {
      const match = byNormalized.get(normalizeKey(alias));
      if (match) return match;
    }
    const exact = byNormalized.get(candidate);
    if (exact) return exact;
  }
  return null;
}

function isFinitePosition(value: unknown): boolean {
  return Array.isArray(value)
    && value.length >= 2
    && value[0] !== undefined
    && value[1] !== undefined
    && typeof value[0] === 'number'
    && typeof value[1] === 'number'
    && Number.isFinite(value[0])
    && Number.isFinite(value[1]);
}

function isPosition(value: unknown): boolean {
  return isFinitePosition(value)
    && Number(value[1]) >= TELANGANA_EXTENT.minLat
    && Number(value[1]) <= TELANGANA_EXTENT.maxLat
    && Number(value[0]) >= TELANGANA_EXTENT.minLng
    && Number(value[0]) <= TELANGANA_EXTENT.maxLng;
}

function collectPositions(value: unknown, output: unknown[] = []): unknown[] {
  if (!Array.isArray(value)) return output;
  if (isFinitePosition(value)) {
    output.push(value);
    return output;
  }
  for (const item of value) collectPositions(item, output);
  return output;
}

function validGeometry(geometry: unknown): geometry is TelemetryFeature['geometry'] {
  if (!isRecord(geometry)) return false;
  const type = geometry.type;
  const allowed: TelemetryGeometryType[] = [
    'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon',
  ];
  if (typeof type !== 'string' || !allowed.includes(type as TelemetryGeometryType)) return false;
  if (!Array.isArray(geometry.coordinates)) return false;
  const positions = collectPositions(geometry.coordinates);
  return positions.length > 0 && positions.every(isFinitePosition);
}

function readFeatures(input: unknown): TelemetryFeature[] | null {
  if (!isRecord(input) || input.type !== 'FeatureCollection' || !Array.isArray(input.features)) return null;
  const features: TelemetryFeature[] = [];
  for (const item of input.features) {
    if (!isRecord(item) || item.type !== 'Feature') return null;
    if (!isRecord(item.properties)) return null;
    if (item.geometry !== null && !validGeometry(item.geometry)) return null;
    features.push(item as unknown as TelemetryFeature);
  }
  return features;
}

export function isValidGeoJsonFeatureCollection(input: unknown): boolean {
  return readFeatures(input) !== null;
}

export function validateTelanganaBoundaries(
  input: unknown,
  districts: readonly DistrictSummary[],
): BoundaryValidation {
  const features = readFeatures(input) || [];
  const canonicalDistrictCount = districts.length;
  const matchedDistrictIds: string[] = [];
  const duplicateDistrictIds: string[] = [];
  const unmatchedDistrictIds: string[] = [];
  const invalidGeometries: string[] = [];
  const outOfExtentGeometries: string[] = [];
  const nonPolygonFeatures: string[] = [];
  let boundaryFeatures = 0;

  const expectedIds = new Set(
    districts
      .map(district => normalizeKey((district as any).district_id || districtName(district)))
      .filter(Boolean),
  );

  features.forEach((feature, index) => {
    const geometryType = feature.geometry?.type;
    const match = matchGeoJsonFeatureToDistrict(feature, districts);
    const label = String(
      (feature.properties as Record<string, unknown>).district_name
      || (feature.properties as Record<string, unknown>).DISTRICT
      || (feature.properties as Record<string, unknown>).name
      || (match as any)?.district
      || (match as any)?.district_name
      || (feature.properties as Record<string, unknown>).district_id
      || `feature_${index + 1}`,
    );

    if (!feature.geometry) {
      invalidGeometries.push(label);
      return;
    }
    if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
      nonPolygonFeatures.push(label);
      return;
    }
    boundaryFeatures += 1;
    const rings = feature.geometry.type === 'Polygon'
      ? feature.geometry.coordinates
      : (feature.geometry.coordinates as unknown[]).flat(1);
    const positions = collectPositions(feature.geometry.coordinates);
    const ringValid = Array.isArray(rings) && (rings as unknown[]).every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(isFinitePosition));
    if (!positions.length || !ringValid) invalidGeometries.push(label);
    if (positions.some(position => !isPosition(position))) outOfExtentGeometries.push(label);

    if (!match) {
      unmatchedDistrictIds.push(label);
      return;
    }
    const id = normalizeKey((match as any).district_id || match.district);
    if (matchedDistrictIds.includes(id)) duplicateDistrictIds.push(id);
    matchedDistrictIds.push(id);
  });

  const missingDistrictIds = [...expectedIds].filter(id => !matchedDistrictIds.includes(id)).sort();
  const distinctMatched = new Set(matchedDistrictIds);
  const valid = features.length > 0
    && boundaryFeatures === features.length
    && boundaryFeatures === distinctMatched.size
    && duplicateDistrictIds.length === 0
    && unmatchedDistrictIds.length === 0
    && invalidGeometries.length === 0
    && outOfExtentGeometries.length === 0
    && missingDistrictIds.length === 0
    && canonicalDistrictCount === 33;

  return {
    valid,
    totalFeatures: features.length,
    boundaryFeatures,
    canonicalDistrictCount,
    matchedDistrictIds: [...distinctMatched].sort(),
    duplicateDistrictIds,
    unmatchedDistrictIds,
    missingDistrictIds,
    invalidGeometries,
    outOfExtentGeometries,
    nonPolygonFeatures,
    matchesAllDistricts: canonicalDistrictCount === 33 && missingDistrictIds.length === 0 && duplicateDistrictIds.length === 0,
  };
}

function numeric(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function text(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return fallback;
}

function districtName(district: DistrictSummary): string {
  const record = district as unknown as Record<string, unknown>;
  return text(record, ['district', 'district_name', 'districtName'], '');
}

function coordinates(record: Record<string, unknown>): [number, number] | null {
  const nested = record.coordinates;
  const sources = [record, isRecord(nested) ? nested : {}];
  for (const source of sources) {
    const lat = numeric(source, ['lat', 'latitude', 'y']);
    const lng = numeric(source, ['lng', 'lon', 'longitude', 'x']);
    if (lat !== null && lng !== null
      && lat >= TELANGANA_EXTENT.minLat && lat <= TELANGANA_EXTENT.maxLat
      && lng >= TELANGANA_EXTENT.minLng && lng <= TELANGANA_EXTENT.maxLng) {
      return [lng, lat];
    }
  }
  return null;
}

function districtCenter(district: DistrictSummary): [number, number] | null {
  const record = district as unknown as Record<string, unknown>;
  const lat = numeric(record, ['lat', 'latitude']);
  const lng = numeric(record, ['lng', 'longitude']);
  if (lat === null || lng === null) return null;
  if (lat < TELANGANA_EXTENT.minLat || lat > TELANGANA_EXTENT.maxLat) return null;
  if (lng < TELANGANA_EXTENT.minLng || lng > TELANGANA_EXTENT.maxLng) return null;
  return [lng, lat];
}

function districtContext(district: DistrictSummary | null): Partial<TelemetryFeatureProps> {
  if (!district) return {};
  const record = district as unknown as Record<string, unknown>;
  return {
    district_id: text(record, ['district_id', 'districtId', 'canonical_id'], districtName(district)),
    district_name: districtName(district),
    risk_category: district.risk_category,
    flood_risk_score: district.flood_risk_score,
    rainfall_mm_24h: district.rainfall_mm_24h,
    rainfall_data_mode: district.rainfall_data_mode,
    rainfall_source: district.rainfall_source,
    data_source_mode: district.data_source_mode,
    data_provenance: district.data_provenance,
  };
}

function isVerifiedReport(report: Record<string, unknown>): boolean {
  const status = String(report.status ?? report.verification_status ?? '').toUpperCase();
  return status === 'VERIFIED' || status === 'VALIDATED';
}

export function buildTelanganaTelemetryGeoJson(options: BuildTelemetryOptions): TelemetryFeatureCollection {
  const districts = options.districts || [];
  const features: TelemetryFeature[] = [];
  const validation = validateTelanganaBoundaries(options.boundaries, districts);
  const featuresByDistrict = new Map<string, DistrictSummary>();
  for (const district of districts) {
    const id = normalizeKey((district as any).district_id || districtName(district));
    if (id) featuresByDistrict.set(id, district);
  }

  const boundaryFeatures = readFeatures(options.boundaries) || [];
  boundaryFeatures.forEach((feature, index) => {
    if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') return;
    const district = matchGeoJsonFeatureToDistrict(feature, districts);
    if (!district) return;
    const boundaryProps = feature.properties as Record<string, unknown>;
    features.push({
      type: 'Feature',
      id: `district-${normalizeKey((district as any).district_id || districtName(district))}`,
      geometry: feature.geometry,
      properties: {
        feature_type: 'district_boundary',
        feature_id: String(feature.id ?? `boundary-${index + 1}`),
        label: districtName(district),
        ...districtContext(district),
        data_status: 'REFERENCE',
        data_mode: 'BOUNDARY_DATASET',
        source: text(boundaryProps, ['source', 'source_dataset', 'license', 'licence'], 'District boundary dataset'),
        source_detail: [
          text(boundaryProps, ['source_publisher'], ''),
          text(boundaryProps, ['source_license'], ''),
          text(boundaryProps, ['source_updated'], ''),
        ].filter(Boolean).join(' | '),
        details: 'Boundary geometry from a documented district polygon dataset; not a live hydrological observation.',
        geometry_basis: 'SUPPLIED_BOUNDARY',
      },
    });
  });

  (options.hydrologicalStations || []).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const point = coordinates(raw);
    if (!point) return;
    const district = matchGeoJsonFeatureToDistrict(
      { type: 'Feature', properties: raw, geometry: { type: 'Point', coordinates: point } },
      districts,
    );
    const id = text(raw, ['station_id', 'id'], `station-${index + 1}`);
    features.push({
      type: 'Feature',
      id: `station-${id}`,
      geometry: { type: 'Point', coordinates: point },
      properties: {
        feature_type: 'hydrological_station',
        feature_id: id,
        label: text(raw, ['station_name', 'name'], id),
        ...districtContext(district),
        data_status: 'REFERENCE',
        data_mode: text(raw, ['data_mode', 'reference_type'], 'REFERENCE'),
        source: text(raw, ['source', 'source_name'], 'Hydrological station registry'),
        source_detail: text(raw, ['basin', 'water_body_name'], ''),
        details: 'Station location from registry; readings must be checked separately.',
        geometry_basis: 'STATION_COORDINATE',
      },
    });
  });

  (options.basinConnections || []).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const upstreamId = normalizeKey(raw.upstream_district_id ?? raw.upstream_district);
    const downstreamId = normalizeKey(raw.downstream_district_id ?? raw.downstream_district);
    const upstream = featuresByDistrict.get(DISTRICT_ID_ALIASES[upstreamId] ? normalizeKey(DISTRICT_ID_ALIASES[upstreamId]) : upstreamId);
    const downstream = featuresByDistrict.get(DISTRICT_ID_ALIASES[downstreamId] ? normalizeKey(DISTRICT_ID_ALIASES[downstreamId]) : downstreamId);
    const start = upstream ? districtCenter(upstream) : null;
    const end = downstream ? districtCenter(downstream) : null;
    if (!start || !end) return;
    const id = text(raw, ['connection_id', 'id'], `basin-${index + 1}`);
    features.push({
      type: 'Feature',
      id: `basin-${id}`,
      geometry: { type: 'LineString', coordinates: [start, end] },
      properties: {
        feature_type: 'basin_connection',
        feature_id: id,
        label: text(raw, ['water_body_name', 'basin_name'], id),
        upstream_district_id: upstream?.district,
        downstream_district_id: downstream?.district,
        data_status: 'DERIVED',
        data_mode: text(raw, ['data_mode'], 'HISTORICAL'),
        source: text(raw, ['source'], 'Basin connection registry'),
        source_detail: text(raw, ['basin_name', 'sub_basin'], ''),
        details: 'Line joins district centers; it is not a river boundary.',
        geometry_basis: 'DISTRICT_CENTER',
      },
    });
  });

  (options.citizenReports || []).forEach((raw, index) => {
    if (!isRecord(raw) || !isVerifiedReport(raw)) return;
    const point = coordinates(raw);
    if (!point) return;
    const district = matchGeoJsonFeatureToDistrict(
      { type: 'Feature', properties: raw, geometry: { type: 'Point', coordinates: point } },
      districts,
    );
    const id = text(raw, ['id', 'report_id'], `report-${index + 1}`);
    features.push({
      type: 'Feature',
      id: `report-${id}`,
      geometry: { type: 'Point', coordinates: point },
      properties: {
        feature_type: 'verified_citizen_report',
        feature_id: id,
        label: text(raw, ['incident_type', 'title'], 'Verified citizen report'),
        ...districtContext(district),
        data_status: 'VERIFIED',
        data_mode: 'VERIFIED_REPORT',
        source: text(raw, ['source'], 'Verified citizen report'),
        details: text(raw, ['description', 'summary'], ''),
        geometry_basis: 'REPORT_COORDINATE',
      },
    });
  });

  return {
    type: 'FeatureCollection',
    features,
    source: 'NeerDrishti existing APIs (/api/geo/districts, /api/hydrology/stations, /api/basin/connections, /api/reports)',
    provenance: 'District risk values come from /api/districts. Polygon geometries are used only when supplied by the boundary endpoint; center points never replace boundaries.',
    validation,
  };
}
