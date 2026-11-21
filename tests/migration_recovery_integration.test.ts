import assert from 'node:assert/strict';
import { test } from 'node:test';

const uri = process.env.MIGRATION_TEST_MONGODB_URI || '';
const safe = uri.startsWith('mongodb://127.0.0.1:') || uri.startsWith('mongodb://localhost:');

test('migration integration safety gate', () => {
  const inCi = process.env.CI === 'true';
  if (!uri) {
    if (inCi) {
      assert.fail('MIGRATION_TEST_MONGODB_URI is required in CI');
    }
    console.log('Skipping MongoDB integration tests: MIGRATION_TEST_MONGODB_URI is not set.');
    return;
  }
  assert.ok(safe, 'MIGRATION_TEST_MONGODB_URI must point to localhost');
  assert.ok(!uri.includes('mongodb+srv://'), 'Atlas SRV URIs are not allowed');
});
