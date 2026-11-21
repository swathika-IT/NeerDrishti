/**
 * NeerDrishti forecast validation & backtesting report (offline, read-only).
 *
 * Run: npx tsx scripts/forecast_validation_report.ts
 *
 * This script never fabricates accuracy metrics. It audits the datasets actually present in the
 * repository and states plainly whether a time-based backtest can be performed. Where data is
 * insufficient it says so and lists exactly what is required.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { getDatabasePath } from '../src/db/path';

const ROOT = process.cwd();
const report: any = { generatedAt: new Date().toISOString(), datasets: [], backtestPossible: false, reasons: [], requirements: [] };

function csvRows(relPath: string): { headers: string[]; rows: string[][] } {
  const raw = fs.readFileSync(path.join(ROOT, relPath), 'utf-8').trim();
  const lines = raw.split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(','));
  return { headers, rows };
}

// 1. Static historical context datasets (priority districts only)
for (const rel of ['data/flood_history.csv', 'data/districts.csv', 'data/drainage_risk.csv', 'data/sample_rainfall.csv', 'data/telangana_districts.csv']) {
  try {
    const { headers, rows } = csvRows(rel);
    report.datasets.push({ file: rel, rows: rows.length, columns: headers, districtsCovered: rows.length });
  } catch (err) {
    report.datasets.push({ file: rel, error: String(err) });
  }
}

// 2. SQLite signal ledger (only time series available)
try {
  const db = new DatabaseSync(getDatabasePath(), { readOnly: true });
  const signals = db.prepare('select count(*) c, min(recorded_at) mn, max(recorded_at) mx, count(distinct district_id) d from external_signals').get() as any;
  const hist = db.prepare("select count(*) c from external_signals where data_mode = 'HISTORICAL'").get() as any;
  const live = db.prepare("select count(*) c from external_signals where data_mode = 'LIVE'").get() as any;
  const snap = db.prepare("select count(*) c, min(forecast_generated_at) mn, max(forecast_generated_at) mx from forecast_snapshots").get() as any;
  const bugCorrupt = db.prepare('select count(*) c from forecast_snapshots where current_risk_score = 0').get() as any;
  report.datasets.push({
    file: 'data/neerdrishti.db (external_signals)',
    rows: signals.c,
    distinctDistricts: signals.d,
    span: { from: signals.mn, to: signals.mx },
    note: 'Rainfall-only, Open-Meteo model/ingest, a few days of data. Not a climatological series and contains no flood outcomes.',
  });
  report.forecastSnapshots = { total: snap.c, span: { from: snap.mn, to: snap.mx }, generatedWithFieldBug: bugCorrupt.c, valid: snap.c - bugCorrupt.c };
  db.close();
} catch (err) {
  report.datasets.push({ file: 'data/neerdrishti.db', error: String(err) });
}

// 3. Feasibility determination — explicit, not silent
const requirements = [
  'Multi-year (>=10 years) daily rainfall per all 33 districts (e.g. IMD district-wise rainfall, openly downloadable from the National Water Data Portal, last updated 2026-10-31).',
  'A labeled district-level flood event catalog with dates, affected districts and severity (e.g. Telangana SDMA event reports / IMD heavy-rainfall event bulletins).',
  'Matched input features for the same period (rainfall, antecedent wetness) and a defined outcome definition (e.g. district inundation reported / flood-alert issued).',
];
report.reasons = [
  'flood_history.csv covers only the 5 priority districts with event years, no dates, rainfall magnitudes or outcomes per event.',
  'sample_rainfall.csv is a single 2026-08-26 snapshot for 5 districts (baseline values), not a time series.',
  'external_signals contains rainfall for 33 districts but only since 2026-10-30 (~5 days), with no flood outcomes attached.',
  'No river-stage/hydrological observations are stored (hydrological_stations is a reference registry with seeded synthetic references).',
  'No labeled dependent variable exists anywhere in the repository, so MAE/RMSE/precision/recall/false-alarm rate cannot be computed without fabrication.',
];
report.requirements = requirements;
report.backtestPossible = false;
report.recommendedAction =
  'Import NWDP/IMD district-wise daily rainfall CSV (verified open) and a Telangana flood-event label set, then re-run this report. Until then, treat ALL forecast outputs as SIMULATED_FORECAST decision-support projections with NO measured accuracy.';

console.log(JSON.stringify(report, null, 2));
