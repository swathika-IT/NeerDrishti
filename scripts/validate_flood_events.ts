/**
 * Validates the curated flood-event label file against the Phase 8 Epic 0 specification.
 * Usage: npx tsx scripts/validate_flood_events.ts [--file data/flood_events_telangana.json]
 * Exit code 0 = valid, 1 = invalid or missing file.
 */
import fs from 'fs';
import path from 'path';
import { validateFloodEventsFile, assessBacktestReadiness, type FloodEventLabel } from '../src/services/historical/flood_events';

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const file = arg('file', 'data/flood_events_telangana.json');
const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);

if (!fs.existsSync(abs)) {
  console.error(`[events] File not found: ${abs} (no events can be validated — this is not an error if curation has not started).`);
  process.exit(1);
}

let doc: any;
try {
  doc = JSON.parse(fs.readFileSync(abs, 'utf-8'));
} catch (err: any) {
  console.error(`[events] Invalid JSON: ${err.message}`);
  process.exit(1);
}

const result = validateFloodEventsFile(doc);
const readiness = assessBacktestReadiness(result.districtsCovered, (doc.events || []) as FloodEventLabel[]);

console.log(JSON.stringify({
  file: abs,
  valid: result.valid,
  event_count: result.eventCount,
  districts_covered: result.districtsCovered,
  events_by_year: result.eventsByYear,
  outcome_breakdown: result.outcomeBreakdown,
  errors: result.errors,
  backtest_readiness: readiness,
}, null, 2));

process.exit(result.valid ? 0 : 1);
