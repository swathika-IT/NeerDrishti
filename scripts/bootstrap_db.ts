/**
 * Production bootstrap: create base schema + apply migrations, idempotently.
 * Runs before the server on every start (cheap no-op when up to date).
 *   node dist/bootstrap.cjs
 */
import 'dotenv/config';
import { initDatabase } from '../src/db/sqlite';
import { runMigrations } from '../src/db/migrate';

initDatabase();
const r = runMigrations();
console.log(`[bootstrap] schema ready. migrations applied now: ${r.applied.length}, already applied: ${r.skipped.length}`);
process.exit(0);
