/**
 * Offline historical rainfall import (Phase 8 / Epic 3).
 *
 * Usage:
 *   npx tsx scripts/import_historical_rainfall.ts --file <path.csv> [--state Telangana] [--apply] [--report <path.json>]
 *
 * Defaults to DRY-RUN: nothing is written unless --apply is passed.
 * Never fabricates values: missing/invalid rows are rejected and reported.
 * HISTORICAL rows are written with data_mode='HISTORICAL' and can never be selected as LIVE.
 */
import fs from 'fs';
import path from 'path';
import { parseHistoricalRainfallCsv } from '../src/services/historical/historical_import';
import { evaluateFreshness } from '../src/services/signal_validator';
import {
  insertHistoricalSignalsBatch,
  getExistingSignalDateKeys,
  type HistoricalSignalRow,
} from '../src/db/sqlite';
import { getDb } from '../src/db/sqlite';

const SOURCE = {
  dataset: 'IMD District-wise Daily Rainfall (via NWDP)',
  publisher: 'National Water Data Portal (NWIC), Ministry of Jal Shakti, Govt. of India / India Meteorological Department',
  source_url: 'https://nwdp.nwic.gov.in/dataset/rainfall-daily-imd',
  // Licence VERIFIED UNVERIFIED on 2026-11-04: the NWDP resource page states "No License Provided".
  // GODL/NDSAP is NOT confirmed for this dataset. See docs/NWDP_LICENCE_VERIFICATION.md.
  licence: 'UNVERIFIED - resource page states "No License Provided"; not a confirmed open licence',
  licence_status: 'UNVERIFIED' as const,
  accessed_on: new Date().toISOString().slice(0, 10),
};

// NOTE: this identifier is kept stable for duplicate-detection with rows imported before the
// licence review. The "(GODL-India)" token is a legacy label and does NOT assert a licence.
const SOURCE_NAME = 'NWDP IMD District-wise Daily Rainfall (GODL-India)';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const file = arg('file');
  if (!file) {
    console.error('ERROR: --file <path.csv> is required');
    process.exit(1);
  }
  const state = arg('state', 'Telangana')!;
  const apply = hasFlag('apply');
  const reportPath = arg('report');

  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`ERROR: file not found: ${abs}`);
    process.exit(1);
  }

  const content = fs.readFileSync(abs, 'utf-8');
  const fileSha = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');

  const parsed = parseHistoricalRainfallCsv(content, { stateFilter: state, source: SOURCE });

  const existingKeys = getExistingSignalDateKeys(SOURCE_NAME, 'rainfall');
  const duplicatesSkipped: string[] = [];
  const toImport = parsed.records.filter(rec => {
    const key = `${rec.district_id}|${rec.date}`;
    if (existingKeys.has(key)) {
      duplicatesSkipped.push(key);
      return false;
    }
    return true;
  });

  const perDistrict: Record<string, { count: number; min_date: string; max_date: string }> = {};
  for (const rec of toImport) {
    const entry = perDistrict[rec.district_id] || { count: 0, min_date: rec.date, max_date: rec.date };
    entry.count++;
    if (rec.date < entry.min_date) entry.min_date = rec.date;
    if (rec.date > entry.max_date) entry.max_date = rec.date;
    perDistrict[rec.district_id] = entry;
  }

  const report: any = {
    generated_at: new Date().toISOString(),
    mode: apply ? 'APPLY' : 'DRY_RUN',
    file: { path: abs, sha256: fileSha, bytes: fs.statSync(abs).size },
    source: { source_name: SOURCE_NAME, ...SOURCE, unit: 'mm/day' },
    state_filter: state,
    parse: parsed.stats,
    duplicates_skipped: duplicatesSkipped.length,
    to_import: toImport.length,
    districts_covered: Object.keys(perDistrict).length,
    per_district: perDistrict,
    rejection_samples: parsed.rejections.slice(0, 25),
    rejection_reasons_summary: parsed.rejections.reduce((acc: Record<string, number>, r) => {
      const key = r.reason.replace(/'.*'/, "'...'").slice(0, 80);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n[import] DRY-RUN complete: ${toImport.length} rows ready, ${duplicatesSkipped.length} duplicates skipped, ${parsed.rejections.length} rejections. Re-run with --apply to write.`);
    return;
  }

  const beforeCounts = countSignals();
  console.warn('[import] NOTE: dataset licence is UNVERIFIED (NWDP resource page states "No License Provided"). Internal research/demonstration use only; obtain written permission from NWIC/IMD before redistribution. See docs/NWDP_LICENCE_VERIFICATION.md.');
  const rows: HistoricalSignalRow[] = toImport.map(rec => ({
    district_id: rec.district_id,
    source_name: SOURCE_NAME,
    source_type: 'historical_archive',
    signal_type: 'rainfall',
    value: rec.rainfall_mm,
    unit: 'mm',
    data_mode: 'HISTORICAL',
    freshness: evaluateFreshness(`${rec.date}T12:00:00.000Z`).status,
    confidence: 0.8,
    is_valid: 1,
    recorded_at: `${rec.date}T12:00:00.000Z`,
    metadata: rec.metadata,
  }));

  const inserted = insertHistoricalSignalsBatch(rows);
  const afterCounts = countSignals();

  report.inserted = inserted;
  report.counts = { before: beforeCounts, after: afterCounts };

  console.log(JSON.stringify(report, null, 2));
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n[import] APPLIED: inserted ${inserted} HISTORICAL rows (external_signals ${beforeCounts} -> ${afterCounts}).`);
}

function countSignals(): number {
  const db = getDb();
  return Number((db.prepare('SELECT count(*) AS c FROM external_signals').get() as any).c);
}

main().catch(err => {
  console.error('[import] FATAL:', err);
  process.exit(1);
});
