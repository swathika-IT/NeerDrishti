import { MongoClient } from 'mongodb';
import {
  APPROVED_EXCLUSIONS,
  EXPECTED_APPROVED_IMPORT_TOTAL,
  acquireLock,
  buildImportPlan,
  buildMappings,
  formatImportPlanSummary,
  insertDocuments,
  openSourceDatabase,
  recordPolicyExclusions,
  releaseLock,
  validateMongoUri,
  verifyCompletedCollection,
  verifyPolicyExclusions,
} from './importer_core';
import { recoverStaleLock } from './recovery';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const recoverLock = args.includes('--recover-stale-lock');
const sourcePath = args.find(a => a.startsWith('--source='))?.split('=').slice(1).join('=') || 'D:/downloadable/neerdrishti---urban-flood-intelligence/data/neerdrishti.db';
const mongoUri = (process.env.MONGODB_URI || '').trim();

const uriCheck = validateMongoUri(mongoUri);
if (!uriCheck.ok) {
  console.error(`MONGODB_URI rejected: ${uriCheck.reason}`);
  process.exit(1);
}

async function main() {
  const sqlite = openSourceDatabase(sourcePath);
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db();
  const state = db.collection('migration_state');
  const mappings = buildMappings(sqlite);
  const plan = buildImportPlan(mappings, {
    exclusions: APPROVED_EXCLUSIONS,
    expectedTotal: EXPECTED_APPROVED_IMPORT_TOTAL,
  });

  for (const line of formatImportPlanSummary(plan, dryRun ? 'DRY-RUN' : 'APPLY')) {
    console.log(line);
  }

  const excludedNonEmpty: string[] = [];
  for (const exclusion of plan.exclusions) {
    const n = await db.collection(exclusion.collection).countDocuments();
    if (n > 0) excludedNonEmpty.push(`${exclusion.collection}=${n}`);
  }
  if (excludedNonEmpty.length > 0) {
    console.error('Policy-excluded collections are not empty:', excludedNonEmpty.join(', '));
    await client.close();
    sqlite.close();
    process.exit(1);
  }

  const existing = await db.listCollections().toArray();
  const checkpoints = await state.find({}).toArray();
  const checkpointed = new Set(checkpoints.map((doc) => doc.collection).filter(Boolean));
  const nonEmpty: string[] = [];
  for (const c of existing) {
    if (c.name === 'migration_state') continue;
    const n = await db.collection(c.name).countDocuments();
    if (n > 0) nonEmpty.push(`${c.name}=${n}`);
  }
  if (!dryRun && nonEmpty.length > 0 && checkpointed.size === 0) {
    console.error('Target database is not empty and has no migration checkpoints:', nonEmpty.join(', '));
    await client.close();
    sqlite.close();
    process.exit(1);
  }

  let lockAcquired = false;
  if (!dryRun) {
    if (recoverLock) {
      const recovery = await recoverStaleLock(state);
      console.log(`[recovery] ${recovery.reason}`);
    }
    const lock = await acquireLock(state);
    if (!lock.acquired) {
      console.error(lock.reason || 'Migration lock is unavailable.');
      await client.close();
      sqlite.close();
      process.exit(1);
    }
    lockAcquired = true;
  }

  try {
    if (!dryRun) {
      await recordPolicyExclusions(state, plan);
      await verifyPolicyExclusions(state, plan);
    }
    for (const { collection, docs } of plan.imports) {
      const collectionState = await state.findOne({ collection });
      if (!dryRun && await verifyCompletedCollection(db.collection(collection), collectionState, docs.length)) {
        console.log(`${collection}: already completed (${docs.length}), skipped`);
        continue;
      }

      const result = dryRun
        ? { inserted: docs.length, skipped: 0 }
        : await insertDocuments(db.collection(collection), docs);

      if (!dryRun) {
        await state.updateOne(
          { collection },
          {
            $set: {
              collection,
              status: 'completed',
              sourceCount: docs.length,
              importedCount: result.inserted,
              skippedCount: result.skipped,
              completedAt: new Date().toISOString(),
            },
          },
          { upsert: true }
        );
      }
      if (!dryRun) {
        console.log(`${collection}: ${result.inserted} inserted, ${result.skipped} skipped`);
      }
    }

    if (lockAcquired) {
      await releaseLock(state, 'completed');
    }
    console.log(dryRun ? 'Dry-run complete. No writes performed.' : 'Migration complete.');
  } catch (err) {
    if (lockAcquired) {
      try {
        await releaseLock(state, 'failed');
      } catch {
        // Lock remains running for manual recovery.
      }
    }
    throw err;
  } finally {
    await client.close();
    sqlite.close();
  }
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
