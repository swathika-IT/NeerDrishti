# SQLite → MongoDB Migration Recovery Guide

## Scope

Source: `D:/downloadable/neerdrishti---urban-flood-intelligence/data/neerdrishti.db`
Target: MongoDB Atlas database `neerdrishti_staging`
Importer: `scripts/migration/sqlite_to_mongo.ts`
Core logic: `scripts/migration/importer_core.ts`

The importer opens SQLite with `readOnly: true`. The SQLite source is never modified.

## Source-to-target mappings (23)

| # | Source table | Target collection | Source rows | Expected target docs | ID |
|---:|---|---|---:|---:|---|
| 1 | districts | districts | 33 | 33 | `_id = district_id` |
| 2 | hydrological_stations | hydrological_stations | 33 | 33 | `_id = station_id` |
| 3 | users | users | 2 | 2 | `_id = id` |
| 4 | sessions | sessions | 3 | 3 | `_id = id` (token hash) |
| 5 | email_verifications | email_verifications | 1 | 1 | `_id = id` |
| 6 | password_resets | password_resets | 0 | 0 | `_id = id` |
| 7 | role_requests | role_requests | 0 | 0 | `_id = id` |
| 8 | official_profiles | official_profiles | 0 | 0 | `_id = user_id` |
| 9 | official_jurisdictions | official_jurisdictions | 0 | 0 | `_id = official_user_id|district_id` |
| 10 | user_districts | user_districts | 0 | 0 | `_id = user_id|district_id` |
| 11 | alert_subscriptions | alert_subscriptions | 0 | 0 | `_id = id` |
| 12 | notification_preferences | notification_preferences | 0 | 0 | `_id = user_id` |
| 13 | audit_logs | audit_logs | 10 | 10 | `_id = id` |
| 14 | citizen_reports | citizen_reports | 5 | 5 | `_id = id` |
| 15 | report_classification | report_classification | 5 | 5 | `_id = id` |
| 16 | report_moderation_history | report_moderation_history | 5 | 5 | `_id = id` |
| 17 | report_attachments | report_attachments | 0 | 0 | `_id = id` |
| 18 | external_signals | external_signals | 3377 | 3377 | `_id = id` |
| 19 | forecast_snapshots | forecast_snapshots | 132 | 132 | `_id = id` |
| 20 | alerts_history | alerts_history | 0 | 0 | `_id = alert_id`, `legacy_id = id` |
| 21 | notification_history | notification_history | 0 | 0 | `_id = id` |
| 22 | schema_migrations | schema_migrations | 3 | 3 | `_id = name` |
| 23 | sqlite_sequence | sequences | 8 | 8 | `_id = name` |

Expected total target documents: **3,617**.

## schema_migrations bookkeeping

- All 3 applied SQLite migration records are preserved in the `schema_migrations` collection.
- The MongoDB application does not run SQL migrations. `src/db/mongo.ts` creates collections/indexes and seeds districts/stations only when empty; it logs the preserved bookkeeping count at startup.
- `scripts/bootstrap_db.ts` runs SQLite schema/migrations only when `MONGODB_URI` is absent. In MongoDB mode it verifies the Atlas connection and skips SQLite entirely, so applied migrations are never rerun.
- `004_data_pipeline.sql` was not applied in the source database and is therefore not present in `schema_migrations`.

## Deterministic IDs

- Every mapped document has an explicit deterministic `_id`, so reruns are idempotent.
- `sessions._id = id` (the token hash used by application lookups).
- `official_jurisdictions._id = official_user_id|district_id`.
- `user_districts._id = user_id|district_id`.
- These match the unique indexes created by application initialization.

## Indexes

Indexes are created only by the controlled application initialization path (`src/db/mongo.ts` `initDatabase`), never by the importer or the preparation steps.

Unique indexes relevant to migration semantics:

| Collection | Unique index | Reason |
|---|---|---|
| users | `email` (collation) | Login lookup is normalized |
| districts | `district_name` (collation) | District identity |
| sessions | `id` | Token-hash lookup, duplicate prevention |
| official_jurisdictions | `(official_user_id, district_id)` | Natural key |
| user_districts | `(user_id, district_id)` | Natural key |
| alert_subscriptions | `(user_id, district_id)` | One subscription per user/district |
| notification_preferences | `user_id` | One preference document per user |
| email_verifications | `token_hash` | Token uniqueness |
| password_resets | `token_hash` | Token uniqueness |
| sequences | `name` | Counter name uniqueness |
| schema_migrations | `name` | Migration name uniqueness |
| alerts_history | `idempotency_key` (partial) | Alert idempotency |

## Locks and concurrency

- `migration_state` contains `_id: migration_lock` and one checkpoint document per collection.
- Lock acquisition is atomic: `insertOne` is attempted first; an existing completed/failed lock is converted with a conditional `updateOne`.
- A running lock is always refused, including stale locks. Stale locks require manual recovery; the importer never silently takes over.
- Two concurrent importers cannot both acquire the lock.

## Checkpoints and restart

- A collection is skipped only when its checkpoint has `status = completed`, `sourceCount` equals the current source count, and the target document count equals `sourceCount`.
- If the checkpoint count disagrees with the target count, the importer stops with an actionable error.
- Rerunning after a partial failure is safe: completed collections are skipped after verification, and deterministic IDs prevent duplicate inserts.
- A non-empty target with no checkpoints is refused. A non-empty target with checkpoints is treated as recovery and allowed to resume.

## Duplicate and conflict handling

- Duplicate key (`11000`) is never silently skipped.
- The existing document is fetched and compared with the source document.
- Identical documents are counted as skipped; conflicting documents stop the migration.
- After each collection, source and target counts must match exactly; otherwise the migration stops.

## Partial-failure recovery

1. Capture the importer error.
2. Inspect `migration_state` checkpoints and per-collection target counts.
3. Rerun the importer. Completed collections are verified and skipped; incomplete collections are filled.
4. If counts conflict, stop and reconcile manually.
5. If the lock is running and no process is active, manually set it to `failed` or remove it, then rerun.
6. Never delete or modify SQLite source records.

## Rollback

Rollback is manual and collection-specific. The importer never drops data automatically.

| Collection | Rollback action |
|---|---|
| districts | Restore from pre-migration backup; do not drop if referenced |
| hydrological_stations | Restore from backup |
| users | Restore from backup; preserve credentials |
| sessions | Delete migrated session documents if app has not served traffic |
| email_verifications | Delete migrated documents |
| password_resets | Delete migrated documents |
| role_requests | Delete migrated documents |
| official_profiles | Delete migrated documents |
| official_jurisdictions | Delete migrated documents |
| user_districts | Delete migrated documents |
| alert_subscriptions | Delete migrated documents |
| notification_preferences | Delete migrated documents |
| audit_logs | Delete migrated documents |
| citizen_reports | Restore from backup; preserve attachments/classifications |
| report_classification | Restore from backup |
| report_moderation_history | Restore from backup |
| report_attachments | Restore from backup |
| external_signals | Delete migrated documents and re-import if needed |
| forecast_snapshots | Delete migrated documents and re-import if needed |
| alerts_history | Delete migrated documents and re-import if needed |
| notification_history | Delete migrated documents and re-import if needed |
| schema_migrations | Keep; informational only |
| sequences | Restore from backup; required for new inserts |

Rollback rules:

- Before cutover, the target is empty; rollback means dropping the migrated collections and `migration_state`.
- After cutover, never drop collections. Restore from a pre-migration Atlas backup and reconcile by deterministic `_id`.
- Take an Atlas backup before migration (`mongodump` or Atlas snapshot) and verify it restores to a scratch database.
- SQLite remains the source of truth and must not be modified during rollback.

## Backup and restore

```bash
# Backup target before migration
mongodump --uri="$MONGODB_URI" --out=./backup-pre-migration

# Restore to a scratch database for verification
mongorestore --uri="$MONGODB_URI" --nsFrom="neerdrishti_staging.*" --nsTo="neerdrishti_restore_check.*" ./backup-pre-migration/neerdrishti_staging
```

## Validation requirements

- Source SQLite passes `integrity_check` and `foreign_key_check`.
- Target is `neerdrishti_staging` and empty (or fully checkpointed for recovery).
- Dry-run performs no writes.
- Every collection count reconciles exactly.
- Application smoke checks pass after deployment.
