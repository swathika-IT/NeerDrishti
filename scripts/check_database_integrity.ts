import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { getDatabasePath } from '../src/db/path';

dotenv.config();

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const databaseOverride = argValue('--database');
if (databaseOverride) {
  process.env.DATABASE_PATH = path.resolve(process.cwd(), databaseOverride);
}

const databasePath = getDatabasePath();
if (!fs.existsSync(databasePath)) {
  console.error(JSON.stringify({ type: 'database_integrity', status: 'error', error: 'database_not_found', database_path: databasePath }));
  process.exit(1);
}

const REQUIRED_TABLES = ['districts', 'citizen_reports', 'external_signals', 'forecast_snapshots', 'users', 'schema_migrations'];
const db = new DatabaseSync(databasePath, { readOnly: true });

try {
  const integrityRows = db.prepare('PRAGMA integrity_check').all() as any[];
  const integrity = integrityRows.map(row => String(row.integrity_check ?? Object.values(row)[0] ?? '')).join(',');
  const foreignKeyRows = db.prepare('PRAGMA foreign_key_check').all() as any[];
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(row => String(row.name))
  );
  const missingTables = REQUIRED_TABLES.filter(table => !tables.has(table));
  const counts: Record<string, number | null> = {};
  for (const table of REQUIRED_TABLES) {
    if (tables.has(table)) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as any;
      counts[table] = Number(row.count);
    } else {
      counts[table] = null;
    }
  }
  const migrations = tables.has('schema_migrations')
    ? (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as any[]).map(row => String(row.name))
    : [];
  const derivedCounts: Record<string, number | null> = {};
  if (tables.has('external_signals')) {
    const row = db.prepare("SELECT COUNT(*) AS count FROM external_signals WHERE data_mode = 'HISTORICAL'").get() as any;
    derivedCounts.historical_external_signals = Number(row.count);
  } else {
    derivedCounts.historical_external_signals = null;
  }
  if (tables.has('notification_history')) {
    const row = db.prepare('SELECT COUNT(*) AS count FROM notification_history').get() as any;
    derivedCounts.notification_history = Number(row.count);
  } else {
    derivedCounts.notification_history = null;
  }

  const ok = integrity === 'ok' && foreignKeyRows.length === 0 && missingTables.length === 0;
  console.log(
    JSON.stringify(
      {
        type: 'database_integrity',
        status: ok ? 'ok' : 'error',
        database_path: databasePath,
        integrity_check: integrity,
        foreign_key_check: foreignKeyRows,
        missing_tables: missingTables,
        counts,
        derived_counts: derivedCounts,
        migrations,
      },
      null,
      2
    )
  );

  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  db.close();
}
