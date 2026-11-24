/**
 * Production bootstrap.
 * MongoDB mode: verify the Atlas connection and skip SQLite schema/migrations.
 * SQLite mode: create base schema + apply migrations, idempotently.
 *   node dist/bootstrap.cjs
 */
import 'dotenv/config';
import { initDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrate';
import { initializeMongo, closeDb } from '../src/db/mongo';

async function main() {
  if ((process.env.MONGODB_URI || '').trim()) {
    await initializeMongo();
    console.log('[bootstrap] MongoDB mode: connection verified. SQLite schema/migrations skipped.');
    await closeDb();
    return;
  }

  initDatabase();
  const r = runMigrations();
  console.log(`[bootstrap] schema ready. migrations applied now: ${r.applied.length}, already applied: ${r.skipped.length}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
