import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('migration importer fails when source database is missing', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migration/sqlite_to_mongo.ts', '--source=/tmp/does-not-exist.db', '--dry-run'], {
    cwd: process.cwd(),
    env: { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:27017/neerdrishti_test' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
});
