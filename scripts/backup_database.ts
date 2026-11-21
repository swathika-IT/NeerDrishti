import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

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

const tagValue = argValue('--tag') || 'manual';
const tag = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tagValue) ? tagValue : 'manual';

const { backupDatabase } = await import('../src/db/migrate');
const { getDatabasePath } = await import('../src/db/path');

const backupPath = backupDatabase(tag);
if (!backupPath) {
  console.error(JSON.stringify({ type: 'database_backup', status: 'error', error: 'database_not_found', database_path: getDatabasePath() }));
  process.exit(1);
}

const stat = fs.statSync(backupPath);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');

console.log(
  JSON.stringify(
    {
      type: 'database_backup',
      status: 'ok',
      database_path: getDatabasePath(),
      backup_path: backupPath,
      bytes: stat.size,
      sha256,
      integrity: 'ok',
      retention_guidance: 'Keep the latest 30 backups plus pre-deployment and pre-migration backups. Backups are gitignored and must not be committed.',
    },
    null,
    2
  )
);
