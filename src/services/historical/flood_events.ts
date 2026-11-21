import { normalizeDistrict } from '../district_normalizer';

export const EVENT_TYPES = ['URBAN_FLOODING', 'WATERLOGGING', 'RIVER_OVERFLOW', 'RESERVOIR_RELEASE', 'CYCLONE_RAIN', 'OTHER'] as const;
export const EVENT_SEVERITIES = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;
export const OUTCOME_LABELS = ['FLOOD_EVENT', 'NEAR_MISS', 'FALSE_ALARM'] as const;
const INSTITUTIONAL_TYPES = ['IMD_BULLETIN', 'SDMA_REPORT', 'LOCAL_AUTHORITY'];

export interface EvidenceItem {
  type: string;
  title: string;
  url_or_reference: string;
  date: string;
}

export interface FloodEventLabel {
  event_id: string;
  district_id: string;
  onset_date: string;
  end_date?: string | null;
  event_type: string;
  peak_rainfall_mm_24h: number | null;
  affected_localities: string[];
  severity: string;
  outcome_label: string;
  evidence: EvidenceItem[];
  verified_by: string;
  notes: string;
}

export interface FloodEventValidationResult {
  valid: boolean;
  errors: string[];
  eventCount: number;
  districtsCovered: string[];
  eventsByYear: Record<string, number>;
  outcomeBreakdown: Record<string, number>;
}

function isIsoDate(s: any): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime());
}

/**
 * Validates a curated flood-event label file against the Phase 8 Epic 0 specification.
 * Never invents events; an empty (but properly structured) file validates as valid with 0 events.
 */
export function validateFloodEventsFile(doc: any): FloodEventValidationResult {
  const errors: string[] = [];

  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['File is not a JSON object.'], eventCount: 0, districtsCovered: [], eventsByYear: {}, outcomeBreakdown: {} };
  }

  const prov = doc.dataset_provenance;
  if (!prov || typeof prov !== 'object') {
    errors.push('Missing dataset_provenance block.');
  } else {
    for (const field of ['created_by', 'created_on', 'updated_at', 'method']) {
      if (!prov[field]) errors.push(`dataset_provenance.${field} is required.`);
    }
    if (!Array.isArray(prov.sources) || prov.sources.length === 0) {
      errors.push('dataset_provenance.sources must list at least one source.');
    } else {
      prov.sources.forEach((s: any, i: number) => {
        for (const field of ['title', 'publisher', 'url', 'accessed_on', 'licence']) {
          if (!s || !s[field]) errors.push(`dataset_provenance.sources[${i}].${field} is required.`);
        }
      });
    }
  }

  if (!Array.isArray(doc.events)) {
    errors.push('events must be an array.');
    return { valid: errors.length === 0, errors, eventCount: 0, districtsCovered: [], eventsByYear: {}, outcomeBreakdown: {} };
  }

  const seen = new Set<string>();
  const districtsCovered = new Set<string>();
  const eventsByYear: Record<string, number> = {};
  const outcomeBreakdown: Record<string, number> = {};

  doc.events.forEach((e: any, i: number) => {
    const where = `events[${i}]${e?.event_id ? ` (${e.event_id})` : ''}`;
    if (!e || typeof e !== 'object') { errors.push(`${where}: not an object.`); return; }

    if (!e.event_id) errors.push(`${where}.event_id is required.`);
    if (!e.district_id) {
      errors.push(`${where}.district_id is required.`);
    } else {
      const norm = normalizeDistrict(String(e.district_id));
      if (!norm.resolved || !norm.districtId) {
        errors.push(`${where}.district_id '${e.district_id}' is not a canonical Telangana district.`);
      } else {
        districtsCovered.add(norm.districtId);
      }
    }

    if (!isIsoDate(e.onset_date)) errors.push(`${where}.onset_date must be YYYY-MM-DD.`);
    if (e.end_date != null) {
      if (!isIsoDate(e.end_date)) errors.push(`${where}.end_date must be YYYY-MM-DD when present.`);
      else if (isIsoDate(e.onset_date) && e.end_date < e.onset_date) errors.push(`${where}.end_date must be >= onset_date.`);
    }

    if (!EVENT_TYPES.includes(e.event_type)) errors.push(`${where}.event_type must be one of ${EVENT_TYPES.join(', ')}.`);
    if (!EVENT_SEVERITIES.includes(e.severity)) errors.push(`${where}.severity must be one of ${EVENT_SEVERITIES.join(', ')}.`);
    if (!OUTCOME_LABELS.includes(e.outcome_label)) errors.push(`${where}.outcome_label must be one of ${OUTCOME_LABELS.join(', ')}.`);

    if (e.peak_rainfall_mm_24h !== null && e.peak_rainfall_mm_24h !== undefined) {
      if (typeof e.peak_rainfall_mm_24h !== 'number' || !Number.isFinite(e.peak_rainfall_mm_24h) || e.peak_rainfall_mm_24h < 0) {
        errors.push(`${where}.peak_rainfall_mm_24h must be null or a non-negative number.`);
      }
    }

    if (!Array.isArray(e.affected_localities) || e.affected_localities.length === 0) {
      errors.push(`${where}.affected_localities must be a non-empty array.`);
    }

    if (!Array.isArray(e.evidence) || e.evidence.length === 0) {
      errors.push(`${where}.evidence must contain at least one item.`);
    } else {
      const institutional = e.evidence.filter((v: any) => INSTITUTIONAL_TYPES.includes(v?.type));
      if (institutional.length < 1 && e.evidence.length < 2) {
        errors.push(`${where} requires >=1 institutional source (${INSTITUTIONAL_TYPES.join('/')}) or >=2 independent sources.`);
      }
      e.evidence.forEach((v: any, vi: number) => {
        if (!v?.title) errors.push(`${where}.evidence[${vi}].title is required.`);
        if (!v?.url_or_reference) errors.push(`${where}.evidence[${vi}].url_or_reference is required.`);
        if (!isIsoDate(v?.date)) errors.push(`${where}.evidence[${vi}].date must be YYYY-MM-DD.`);
      });
    }

    if (!e.verified_by) errors.push(`${where}.verified_by is required.`);
    if (!e.notes) errors.push(`${where}.notes is required (severity rationale and caveats).`);

    if (e.district_id && isIsoDate(e.onset_date)) {
      const key = `${String(e.district_id).toLowerCase()}|${e.onset_date}`;
      if (seen.has(key)) errors.push(`${where}: duplicate (district_id, onset_date) pair.`);
      seen.add(key);
    }
    if (isIsoDate(e.onset_date)) {
      const year = String(e.onset_date).slice(0, 4);
      eventsByYear[year] = (eventsByYear[year] || 0) + 1;
    }
    outcomeBreakdown[e.outcome_label] = (outcomeBreakdown[e.outcome_label] || 0) + 1;
  });

  return {
    valid: errors.length === 0,
    errors,
    eventCount: doc.events.length,
    districtsCovered: [...districtsCovered].sort(),
    eventsByYear,
    outcomeBreakdown,
  };
}

/** Minimum viable backtest threshold per Phase 8 Epic 0 spec. */
export const PRIORITY_DISTRICTS = ['hyderabad', 'warangal', 'nirmal', 'mancherial', 'bhadradri_kothagudem'];
export const MIN_EVENTS_PER_PRIORITY_DISTRICT = 3;

export function assessBacktestReadiness(districtsCovered: string[], events: FloodEventLabel[]): {
  ready: boolean;
  reasons: string[];
  perPriorityDistrict: Record<string, number>;
} {
  const perPriorityDistrict: Record<string, number> = {};
  for (const d of PRIORITY_DISTRICTS) {
    perPriorityDistrict[d] = events.filter(e => normalizeDistrict(String(e.district_id)).districtId === d).length;
  }
  const reasons: string[] = [];
  for (const d of PRIORITY_DISTRICTS) {
    if (perPriorityDistrict[d] < MIN_EVENTS_PER_PRIORITY_DISTRICT) {
      reasons.push(`${d}: ${perPriorityDistrict[d]}/${MIN_EVENTS_PER_PRIORITY_DISTRICT} verified events`);
    }
  }
  return { ready: reasons.length === 0, reasons, perPriorityDistrict };
}
