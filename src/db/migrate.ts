import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { getDatabasePath, ensureDatabaseDirectory } from './path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const BACKUP_DIR = process.env.NEERDRISHTI_BACKUP_DIR
  ? path.resolve(process.cwd(), process.env.NEERDRISHTI_BACKUP_DIR)
  : path.join(process.cwd(), 'backups');
const DB_PATH = getDatabasePath();

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function backupDatabase(tag: string = 'pre-migration'): string | null {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `neerdrishti-${tag}-${stamp}.db`);
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`);
  } finally {
    db.close();
  }
  const check = new DatabaseSync(backupPath, { readOnly: true });
  const integrity = check.prepare('pragma integrity_check').all().map((r: any) => r.integrity_check ?? Object.values(r)[0]).join(',');
  check.close();
  if (integrity !== 'ok') {
    throw new Error(`Backup integrity_check failed for ${backupPath}: ${integrity}`);
  }
  return backupPath;
}

export function runMigrations(): { applied: string[]; skipped: string[]; backupPath: string | null } {
  ensureDatabaseDirectory(DB_PATH);
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort();

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    (db.prepare('SELECT name, checksum FROM schema_migrations').all() as any[]).map(r => r.name)
  );
  const storedChecksums = new Map(
    (db.prepare('SELECT name, checksum FROM schema_migrations').all() as any[]).map(r => [r.name, r.checksum])
  );

  const pending = files.filter(f => !applied.has(f));
  for (const f of files) {
    const stored = storedChecksums.get(f);
    if (stored && stored !== sha256File(path.join(MIGRATIONS_DIR, f))) {
      db.close();
      throw new Error(`Applied migration ${f} was modified after application. Checksum mismatch — refusing to proceed. Restore from backup if corruption is suspected.`);
    }
  }

  if (pending.length === 0) {
    console.log('[migrate] No pending migrations. Database is up to date.');
    db.close();
    return { applied: [], skipped: files, backupPath: null };
  }

  const backupPath = backupDatabase('pre-migration');
  console.log(`[migrate] Pre-migration backup: ${backupPath}`);

  const appliedNow: string[] = [];
  for (const file of pending) {
    const full = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(full, 'utf-8');
    const checksum = sha256File(full);
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)')
        .run(file, checksum, new Date().toISOString());
      db.exec('COMMIT');
      console.log(`[migrate] Applied ${file}`);
      appliedNow.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw new Error(`[migrate] ${file} failed and was rolled back. Backup at ${backupPath}. Original error: ${err}`);
    }
  }

  db.close();
  return { applied: appliedNow, skipped: files.filter(f => !pending.includes(f)), backupPath };
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  try {
    const result = runMigrations();
    console.log(`[migrate] Done. Applied: ${result.applied.length}, skipped: ${result.skipped.length}.`);
    process.exit(0);
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}
