import { parseCsv, findColumn } from './csv';
import { normalizeDistrict } from '../district_normalizer';

export interface HistoricalSourceAttribution {
  dataset: string;
  publisher: string;
  source_url: string;
  licence: string;
  licence_status?: 'UNVERIFIED' | 'CONFIRMED';
  accessed_on: string;
}

export interface HistoricalRainfallRecord {
  district_id: string;
  original_district: string;
  date: string;             // YYYY-MM-DD
  rainfall_mm: number;
  daily_normal_mm: number | null;
  category: string | null;
  metadata: Record<string, any>;
}

export interface RowRejection {
  line: number;
  reason: string;
  raw: string;
}

export interface ParseResult {
  records: HistoricalRainfallRecord[];
  rejections: RowRejection[];
  stats: {
    total_rows: number;
    accepted: number;
    rejected: number;
    states_seen: string[];
    districts_seen: number;
    alias_usages?: Record<string, number>;
  };
}

const MISSING_TOKENS = new Set(['', 'na', 'n/a', 'nd', 'nil', '-', '--', 'null', 'nan']);

/**
 * Explicit NWDP/IMD abbreviation aliases (verified against the NWDP Telangana district list
 * on 2026-11-04). These are documented shorthand used by the publisher, NOT automatic guesses:
 * every alias is listed here for audit and only used when the canonical normaliser fails.
 */
export const HISTORICAL_DISTRICT_ALIASES: Record<string, string> = {
  'B. KOTHAGUDEM': 'bhadradri_kothagudem',
  'J. BHUPALPALLY': 'jayashankar_bhupalpally',
  'KUMARAM BHEEM': 'kumuram_bheem_asifabad',
  'M. MALKAJGIRI': 'medchal_malkajgiri',
  'PEDDAPALLE': 'peddapalli',
  'Y. BHUVANAGIRI': 'yadadri_bhuvanagiri',
};

export function resolveHistoricalDistrict(rawName: string): { districtId: string | null; viaAlias: boolean } {
  const norm = normalizeDistrict(rawName);
  if (norm.resolved && norm.districtId) {
    return { districtId: norm.districtId, viaAlias: false };
  }
  const alias = HISTORICAL_DISTRICT_ALIASES[String(rawName || '').trim().toUpperCase()];
  if (alias) return { districtId: alias, viaAlias: true };
  return { districtId: null, viaAlias: false };
}

export function isMissingValue(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null) return true;
  return MISSING_TOKENS.has(String(raw).trim().toLowerCase());
}

export function parseDate(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : s;
  }
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const isoStr = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const d = new Date(`${isoStr}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : isoStr;
  }
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function parseNumberMm(raw: string): number | null {
  if (isMissingValue(raw)) return null;
  const cleaned = String(raw).replace(/[^\d.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 2000) return null; // plausible daily rainfall bound; out-of-range is a data defect
  return Math.round(n * 10) / 10;
}

/**
 * Parses a district-wise daily rainfall CSV (e.g. NWDP/IMD) into validated records.
 * - Only the requested state is kept (case-insensitive exact match).
 * - Districts resolve via the canonical normaliser; unresolved rows are REJECTED, never guessed.
 * - Missing values are skipped and counted (never converted to 0).
 * - Duplicate (district, date) rows inside the same file are de-duplicated.
 */
export function parseHistoricalRainfallCsv(
  content: string,
  options: {
    stateFilter?: string;
    source: HistoricalSourceAttribution;
    valueColumn?: string;
    normalColumn?: string;
    categoryColumn?: string;
  }
): ParseResult {
  const rows = parseCsv(content);
  const rejections: RowRejection[] = [];
  const records: HistoricalRainfallRecord[] = [];
  const seenKeys = new Set<string>();
  const statesSeen = new Set<string>();
  const districtsSeen = new Set<string>();
  const aliasUsages = new Map<string, number>();

  if (rows.length === 0) {
    return { records, rejections: [{ line: 0, reason: 'Empty CSV content', raw: '' }], stats: { total_rows: 0, accepted: 0, rejected: 1, states_seen: [], districts_seen: 0 } };
  }

  const headers = rows[0];
  const stateIdx = findColumn(headers, 'State', 'STATE');
  const districtIdx = findColumn(headers, 'District', 'DISTRICT');
  const dateIdx = findColumn(headers, 'Date', 'DATE');
  const valueIdx = findColumn(headers, options.valueColumn || 'Daily Actual');
  const normalIdx = findColumn(headers, options.normalColumn || 'Daily Normal');
  const categoryIdx = findColumn(headers, options.categoryColumn || 'Daily Category');

  if (districtIdx === -1 || dateIdx === -1 || valueIdx === -1) {
    return {
      records,
      rejections: [{ line: 1, reason: `Missing required columns. Found: ${headers.join(' | ')}`, raw: headers.join(',') }],
      stats: { total_rows: rows.length - 1, accepted: 0, rejected: rows.length - 1, states_seen: [], districts_seen: 0 },
    };
  }

  const wanted = options.stateFilter ? options.stateFilter.trim().toUpperCase() : null;
  let totalRows = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawLine = row.join(',');
    const lineNo = r + 1;

    const state = stateIdx !== -1 ? String(row[stateIdx] || '').trim().toUpperCase() : '';
    if (state) statesSeen.add(state);
    if (wanted && state && state !== wanted) {
      continue; // out-of-scope state: not a rejection, simply not selected
    }
    totalRows++;

    const originalDistrict = String(row[districtIdx] || '').trim();
    if (!originalDistrict) {
      rejections.push({ line: lineNo, reason: 'Missing district', raw: rawLine });
      continue;
    }

    const resolved = resolveHistoricalDistrict(originalDistrict);
    if (!resolved.districtId) {
      rejections.push({ line: lineNo, reason: `Unresolved district: '${originalDistrict}'`, raw: rawLine });
      continue;
    }
    if (resolved.viaAlias) aliasUsages.set(originalDistrict, (aliasUsages.get(originalDistrict) || 0) + 1);
    const districtId = resolved.districtId;

    const date = parseDate(row[dateIdx]);
    if (!date) {
      rejections.push({ line: lineNo, reason: `Invalid/missing date: '${row[dateIdx]}'`, raw: rawLine });
      continue;
    }

    const rainfall = parseNumberMm(row[valueIdx]);
    if (rainfall === null) {
      rejections.push({ line: lineNo, reason: `Missing/invalid rainfall value: '${row[valueIdx]}' (preserved as missing, not zero)`, raw: rawLine });
      continue;
    }

    const key = `${districtId}|${date}`;
    if (seenKeys.has(key)) {
      rejections.push({ line: lineNo, reason: `Duplicate row for (${districtId}, ${date}) within file`, raw: rawLine });
      continue;
    }
    seenKeys.add(key);
    districtsSeen.add(districtId);

    const normal = normalIdx !== -1 ? parseNumberMm(row[normalIdx]) : null;
    const category = categoryIdx !== -1 ? (String(row[categoryIdx] || '').trim() || null) : null;

    records.push({
      district_id: districtId,
      original_district: originalDistrict,
      date,
      rainfall_mm: rainfall,
      daily_normal_mm: normal,
      category,
      metadata: {
        dataset: options.source.dataset,
        publisher: options.source.publisher,
        source_url: options.source.source_url,
        licence: options.source.licence,
        licence_status: options.source.licence_status || 'UNVERIFIED',
        accessed_on: options.source.accessed_on,
        original_district: originalDistrict,
        original_state: state || null,
        district_mapping: resolved.viaAlias ? 'alias' : 'direct',
        unit: 'mm/day',
        daily_normal_mm: normal,
        daily_category: category,
      },
    });
  }

  return {
    records,
    rejections,
    stats: {
      total_rows: totalRows,
      accepted: records.length,
      rejected: rejections.length,
      states_seen: [...statesSeen].sort(),
      districts_seen: districtsSeen.size,
      alias_usages: Object.fromEntries([...aliasUsages.entries()].sort()),
    },
  };
}

import { getDb } from '../../db/mongo';

export interface HistoricalSignalRow {
  district_id: string;
  source_name: string;
  source_type: string;
  signal_type: string;
  value: number;
  unit: string;
  data_mode: string;
  freshness: string;
  confidence: number;
  is_valid: number;
  recorded_at: string;
  metadata: Record<string, any>;
}

export async function insertHistoricalSignalsBatch(rows: HistoricalSignalRow[], ingestedAt?: string): Promise<number> {
  if (rows.length === 0) return 0;
  const db = getDb();
  const docs = rows.map(r => ({ ...r, ingested_at: ingestedAt || new Date().toISOString() }));
  const res = await db.collection('external_signals').insertMany(docs, { ordered: false });
  return res.insertedCount || 0;
}

export async function getExistingSignalDateKeys(sourceName: string, signalType: string = 'rainfall'): Promise<Set<string>> {
  const db = getDb();
  const rows = await db.collection('external_signals').find({ source_name: sourceName, signal_type: signalType }, { projection: { district_id: 1, recorded_at: 1 } }).toArray();
  const keys = new Set<string>();
  for (const r of rows) {
    const date = String(r.recorded_at || '').slice(0, 10);
    if (r.district_id && date) keys.add(`${r.district_id}|${date}`);
  }
  return keys;
}