import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = process.cwd();
const SOURCE_DB = path.join(PROJECT_ROOT, 'data', 'neerdrishti.db');
const TEST_DB = path.join(os.tmpdir(), `neerdrishti-hist-test-${Date.now()}.db`);

import { parseCsv } from '../src/services/historical/csv';
import { parseHistoricalRainfallCsv, resolveHistoricalDistrict } from '../src/services/historical/historical_import';
import { validateFloodEventsFile } from '../src/services/historical/flood_events';

const SOURCE = {
  dataset: 'IMD District-wise Daily Rainfall (via NWDP)',
  publisher: 'NWDP/NWIC',
  source_url: 'https://nwdp.nwic.gov.in/dataset/rainfall-daily-imd',
  licence: 'UNVERIFIED - test fixture',
  licence_status: 'UNVERIFIED' as const,
  accessed_on: '2026-11-04',
};

const HEADER = 'State,District,Date,"Daily Actual","Daily Normal",Category';
const row = (state: string, district: string, date: string, actual: string, normal = '5', cat = 'LD') =>
  `${state},${district},${date},${actual},${normal},${cat}`;

before(() => {
  fs.copyFileSync(SOURCE_DB, TEST_DB);
  process.env.DATABASE_PATH = TEST_DB;
});

after(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

test('CSV parser handles quotes, embedded commas, embedded newlines, CRLF and BOM', () => {
  const csv = '\uFEFFa,b,"c,d"\r\n"line\nbreak",e,f\r\n';
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['a', 'b', 'c,d']);
  assert.deepEqual(rows[1], ['line\nbreak', 'e', 'f']);
});

test('parses valid Telangana rows and filters other states', () => {
  const csv = [
    HEADER,
    row('TELANGANA', 'HYDERABAD', '2026-09-01', '12.4'),
    row('TELANGANA', 'WARANGAL', '2026-09-01', '0'),
    row('KERALA', 'IDUKKI', '2026-09-01', '40'),
  ].join('\n');
  const res = parseHistoricalRainfallCsv(csv, { stateFilter: 'Telangana', source: SOURCE });
  assert.equal(res.records.length, 2);
  assert.equal(res.rejections.length, 0);
  assert.equal(res.records[0].district_id, 'hyderabad');
  assert.equal(res.records[1].rainfall_mm, 0, 'zero rainfall is a valid value, not missing');
});

test('unresolved districts are rejected, never guessed; documented aliases resolve explicitly', () => {
  assert.equal(resolveHistoricalDistrict('MARS CITY').districtId, null);
  const alias = resolveHistoricalDistrict('B. KOTHAGUDEM');
  assert.equal(alias.districtId, 'bhadradri_kothagudem');
  assert.equal(alias.viaAlias, true);

  const csv = [HEADER, row('TELANGANA', 'NOT_A_DISTRICT', '2026-09-01', '3')].join('\n');
  const res = parseHistoricalRainfallCsv(csv, { stateFilter: 'Telangana', source: SOURCE });
  assert.equal(res.records.length, 0);
  assert.equal(res.rejections.length, 1);
  assert.match(res.rejections[0].reason, /Unresolved district/);
});

test('missing values and invalid dates are rejected and counted, never fabricated as zero', () => {
  const csv = [
    HEADER,
    row('TELANGANA', 'HYDERABAD', '2026-09-02', 'ND'),
    row('TELANGANA', 'HYDERABAD', '2026-09-03', 'NA'),
    row('TELANGANA', 'HYDERABAD', 'not-a-date', '10'),
    row('TELANGANA', 'HYDERABAD', '2026-09-04', '9999'),
  ].join('\n');
  const res = parseHistoricalRainfallCsv(csv, { stateFilter: 'Telangana', source: SOURCE });
  assert.equal(res.records.length, 0);
  assert.equal(res.rejections.length, 4);
  assert.ok(res.rejections.some(r => /missing\/invalid rainfall/i.test(r.reason)));
  assert.ok(res.rejections.some(r => /Invalid\/missing date/i.test(r.reason)));
});

test('duplicate (district, date) rows within a file are rejected', () => {
  const csv = [
    HEADER,
    row('TELANGANA', 'HYDERABAD', '2026-09-05', '1.2'),
    row('TELANGANA', 'HYDERABAD', '2026-09-05', '1.2'),
  ].join('\n');
  const res = parseHistoricalRainfallCsv(csv, { stateFilter: 'Telangana', source: SOURCE });
  assert.equal(res.records.length, 1);
  assert.equal(res.rejections.length, 1);
  assert.match(res.rejections[0].reason, /Duplicate row/);
});

test('source attribution and licence metadata are attached to every record', () => {
  const csv = [HEADER, row('TELANGANA', 'NIRMAL', '2026-09-06', '7.5')].join('\n');
  const res = parseHistoricalRainfallCsv(csv, { stateFilter: 'Telangana', source: SOURCE });
  const meta = res.records[0].metadata;
  assert.equal(meta.licence, 'UNVERIFIED - test fixture');
  assert.equal(meta.licence_status, 'UNVERIFIED');
  assert.equal(meta.source_url, SOURCE.source_url);
  assert.equal(meta.publisher, 'NWDP/NWIC');
  assert.equal(meta.accessed_on, '2026-11-04');
  assert.equal(meta.unit, 'mm/day');
});

test('DB import is idempotent: re-importing the same rows inserts nothing new', async () => {
  const { insertHistoricalSignalsBatch, getExistingSignalDateKeys } = await import('../src/db/sqlite');
  const csv = [
    HEADER,
    row('TELANGANA', 'KAMAREDDY', '2026-09-10', '3.1'),
    row('TELANGANA', 'KAMAREDDY', '2026-09-11', '4.2'),
  ].join('\n');
  const parsed = parseHistoricalRainfallCsv(csv, { stateFilter: 'Telangana', source: SOURCE });
  const rows = parsed.records.map(r => ({
    district_id: r.district_id,
    source_name: 'TEST-HISTORICAL-SOURCE',
    source_type: 'historical_archive',
    signal_type: 'rainfall',
    value: r.rainfall_mm,
    unit: 'mm',
    data_mode: 'HISTORICAL',
    freshness: 'EXPIRED',
    confidence: 0.8,
    is_valid: 1,
    recorded_at: `${r.date}T12:00:00.000Z`,
    metadata: r.metadata,
  }));

  const inserted1 = insertHistoricalSignalsBatch(rows);
  assert.equal(inserted1, 2);
  const existing = getExistingSignalDateKeys('TEST-HISTORICAL-SOURCE', 'rainfall');
  const secondPass = rows.filter(r => !existing.has(`${r.district_id}|${r.recorded_at.slice(0, 10)}`));
  assert.equal(secondPass.length, 0, 'second import must skip all rows as duplicates');
});

test('HISTORICAL rows are stored with HISTORICAL mode and never selected as LIVE', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(TEST_DB, { readOnly: true });
  const stored = db.prepare("select count(*) c from external_signals where source_name = 'TEST-HISTORICAL-SOURCE' and data_mode = 'HISTORICAL'").get() as any;
  assert.equal(stored.c, 2);

  const { rainfallService } = await import('../src/services/rainfall_service');
  const ctx = rainfallService.selectRainfallForDistrict('kamareddy', 'Kamareddy', 5, 1, 'Heavy Rainfall');
  // The historical test source must never be presented as LIVE evidence. (A verified LIVE source
  // such as Open-Meteo may legitimately be selected; the historical row must not be.)
  assert.ok(
    !(ctx.dataMode === 'LIVE' && ctx.sourceName === 'TEST-HISTORICAL-SOURCE'),
    'historical rows must never be presented as LIVE evidence'
  );
});

test('event label validator accepts a properly structured empty template', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'data', 'flood_events_telangana.json'), 'utf-8'));
  const res = validateFloodEventsFile(doc);
  assert.equal(res.valid, true);
  assert.equal(res.eventCount, 0);
});

test('event label validator rejects malformed, unsupported and duplicate events', () => {
  const base = {
    event_id: 'TELANGANA-2020-hyderabad-1',
    district_id: 'hyderabad',
    onset_date: '2020-10-13',
    event_type: 'URBAN_FLOODING',
    peak_rainfall_mm_24h: null,
    affected_localities: ['Nadeem Colony'],
    severity: 'HIGH',
    outcome_label: 'FLOOD_EVENT',
    evidence: [{ type: 'SDMA_REPORT', title: 'Report', url_or_reference: 'https://example.gov/report', date: '2020-10-14' }],
    verified_by: 'curator',
    notes: 'Severity per SDMA description.',
  };
  const good = {
    dataset_provenance: { created_by: 'x', created_on: '2026-11-04', updated_at: '2026-11-04', method: 'manual', sources: [{ title: 't', publisher: 'p', url: 'u', accessed_on: '2026-11-04', licence: 'l' }] },
    events: [base],
  };
  assert.equal(validateFloodEventsFile(good).valid, true);

  const badDistrict = JSON.parse(JSON.stringify(good));
  badDistrict.events[0].district_id = 'atlantis';
  assert.equal(validateFloodEventsFile(badDistrict).valid, false);

  const badDate = JSON.parse(JSON.stringify(good));
  badDate.events[0].onset_date = '13-10-2020';
  assert.equal(validateFloodEventsFile(badDate).valid, false);

  const badEvidence = JSON.parse(JSON.stringify(good));
  badEvidence.events[0].evidence = [{ type: 'NEWS', title: 't', url_or_reference: 'u', date: '2020-10-14' }];
  const evRes = validateFloodEventsFile(badEvidence);
  assert.equal(evRes.valid, false);
  assert.ok(evRes.errors.some(e => /institutional source/.test(e)));

  const duplicate = JSON.parse(JSON.stringify(good));
  duplicate.events.push(JSON.parse(JSON.stringify(base)));
  assert.equal(validateFloodEventsFile(duplicate).valid, false);

  const missingProvenance = { events: [base] };
  assert.equal(validateFloodEventsFile(missingProvenance).valid, false);
});
