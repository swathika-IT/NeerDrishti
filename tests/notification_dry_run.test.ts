import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = process.cwd();
const SOURCE_DB = path.join(PROJECT_ROOT, 'data', 'neerdrishti.db');
const TEST_DB = path.join(os.tmpdir(), `neerdrishti-notification-test-${Date.now()}.db`);

const originalFetch = globalThis.fetch;
const originalNetConnect = (net as any).connect;
const originalTlsConnect = (tls as any).connect;
const networkCalls: string[] = [];

let NotificationDeliveryService: any;
let NotificationRateLimiter: any;
let loadNotificationConfig: any;
let userSequence = 0;

function setBaseEnv(): void {
  delete process.env.NOTIFICATION_DRY_RUN;
  delete process.env.NOTIFICATION_LIVE_SEND_ENABLED;
  delete process.env.NOTIFICATION_MAX_RETRIES;
  delete process.env.NOTIFICATION_RETRY_BACKOFF_MS;
  delete process.env.NOTIFICATION_RATE_LIMIT_PER_HOUR;
  delete process.env.MAIL_DRY_RUN;
  delete process.env.MAIL_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMS_ENABLED;
  delete process.env.SMS_DRY_RUN;
  delete process.env.SMS_PROVIDER;
  delete process.env.SMS_API_URL;
  delete process.env.SMS_API_KEY;
  delete process.env.SMS_SENDER_ID;
  delete process.env.WHATSAPP_ENABLED;
  delete process.env.WHATSAPP_DRY_RUN;
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.WHATSAPP_API_URL;
  delete process.env.WHATSAPP_API_KEY;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.DATABASE_PATH = TEST_DB;
  process.env.NOTIFICATION_DRY_RUN = 'true';
  process.env.NOTIFICATION_LIVE_SEND_ENABLED = 'false';
  process.env.NOTIFICATION_MAX_RETRIES = '2';
  process.env.NOTIFICATION_RETRY_BACKOFF_MS = '1';
  process.env.NOTIFICATION_RATE_LIMIT_PER_HOUR = '10';
  process.env.MAIL_DRY_RUN = 'true';
}

function openDb(): DatabaseSync {
  return new DatabaseSync(TEST_DB);
}

function resetFixtures(): void {
  const db = openDb();
  db.exec(`
    DELETE FROM notification_history;
    DELETE FROM alert_subscriptions;
    DELETE FROM notification_preferences;
    DELETE FROM users WHERE email LIKE 'notify-test-%';
  `);
  db.close();
}

function seedSubscriber(options: {
  email?: string;
  phone?: string | null;
  districtId?: string;
  minSeverity?: string;
  emailEnabled?: number;
  smsEnabled?: number;
  whatsappEnabled?: number;
  consentGivenAt?: string | null;
  unsubscribedAllAt?: string | null;
  status?: string;
  withPreferences?: boolean;
} = {}): number {
  userSequence += 1;
  const now = new Date().toISOString();
  const db = openDb();
  const email = options.email || `notify-test-${userSequence}@example.com`;
  const info = db.prepare(`
    INSERT INTO users (
      email, password_hash, full_name, role, status, phone, phone_verified,
      email_verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'CITIZEN', ?, ?, 1, ?, ?, ?)
  `).run(
    email,
    'not-a-real-password-hash',
    `Notification Test ${userSequence}`,
    options.status || 'ACTIVE',
    options.phone === undefined ? '+919999999999' : options.phone,
    now,
    now,
    now
  );
  const userId = Number(info.lastInsertRowid);
  db.prepare(`
    INSERT INTO alert_subscriptions (user_id, district_id, min_severity, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, options.districtId || 'hyderabad', options.minSeverity || 'WATCH', now);

  if (options.withPreferences !== false) {
    db.prepare(`
      INSERT INTO notification_preferences (
        user_id, email_enabled, sms_enabled, whatsapp_enabled,
        consent_given_at, consent_source, unsubscribed_all_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      options.emailEnabled ?? 1,
      options.smsEnabled ?? 0,
      options.whatsappEnabled ?? 0,
      options.consentGivenAt ?? null,
      options.consentGivenAt ? 'test' : null,
      options.unsubscribedAllAt ?? null,
      now
    );
  }

  db.close();
  return userId;
}

function notificationRows(): any[] {
  const db = openDb();
  const rows = db.prepare('SELECT * FROM notification_history ORDER BY timestamp, id').all() as any[];
  db.close();
  return rows;
}

function mockProvider(channel: string, handler: (message: any, callNumber: number) => Promise<any>) {
  const calls: any[] = [];
  return {
    channel,
    calls,
    async send(message: any) {
      calls.push(message);
      return handler(message, calls.length);
    },
  };
}

function dryRunProvider(channel: string, reason = 'TEST_DRY_RUN') {
  return mockProvider(channel, async () => ({
    status: 'DRY_RUN',
    simulated: true,
    providerMessageId: null,
    realProviderConfirmation: false,
    retryable: false,
    dryRunReason: reason,
  }));
}

function newService(options: Record<string, any> = {}) {
  return new NotificationDeliveryService({
    config: options.config || loadNotificationConfig(),
    rateLimiter: options.rateLimiter || new NotificationRateLimiter(),
    sleep: async () => {},
    ...options,
  });
}

function request(overrides: Record<string, any> = {}) {
  return {
    districtId: 'hyderabad',
    districtName: 'Hyderabad',
    alertLevel: 'CRITICAL',
    title: 'Flood warning for Hyderabad',
    message: 'Critical flood risk is projected. Avoid low-lying areas.',
    recommendedAction: 'Move to higher ground and follow official instructions.',
    signalsTriggered: ['CURRENT_RISK', 'FORECAST_PEAK'],
    source: 'notification-test',
    ...overrides,
  };
}

before(async () => {
  fs.copyFileSync(SOURCE_DB, TEST_DB);
  setBaseEnv();

  globalThis.fetch = (async (input: any) => {
    networkCalls.push(`fetch:${String(input)}`);
    throw new Error('Network call blocked in notification tests');
  }) as typeof fetch;
  (net as any).connect = (...args: any[]) => {
    networkCalls.push('net.connect');
    throw new Error('Network call blocked in notification tests');
  };
  (tls as any).connect = (...args: any[]) => {
    networkCalls.push('tls.connect');
    throw new Error('Network call blocked in notification tests');
  };

  const deliveryModule = await import('../src/services/notifications/delivery_service');
  const configModule = await import('../src/services/notifications/config');
  const rateModule = await import('../src/services/notifications/rate_limiter');
  NotificationDeliveryService = deliveryModule.NotificationDeliveryService;
  NotificationRateLimiter = rateModule.NotificationRateLimiter;
  loadNotificationConfig = configModule.loadNotificationConfig;
});

beforeEach(() => {
  setBaseEnv();
  resetFixtures();
  networkCalls.length = 0;
});

after(() => {
  globalThis.fetch = originalFetch;
  (net as any).connect = originalNetConnect;
  (tls as any).connect = originalTlsConnect;
  for (const file of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
});

test('defaults are DRY_RUN with SMS and WhatsApp disabled', () => {
  const config = loadNotificationConfig();
  assert.equal(config.masterDryRun, true);
  assert.equal(config.liveSendEnabled, false);
  assert.equal(config.email.dryRun, true);
  assert.equal(config.email.configured, false);
  assert.equal(config.sms.enabled, false);
  assert.equal(config.whatsapp.enabled, false);
  assert.equal(config.sms.dryRun, true);
  assert.equal(config.whatsapp.dryRun, true);
});

test('DRY_RUN invokes mocked SMTP, SMS and WhatsApp providers without network calls', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.WHATSAPP_ENABLED = 'true';
  seedSubscriber({
    emailEnabled: 1,
    smsEnabled: 1,
    whatsappEnabled: 1,
    consentGivenAt: new Date().toISOString(),
  });

  const email = dryRunProvider('EMAIL');
  const sms = dryRunProvider('SMS');
  const whatsapp = dryRunProvider('WHATSAPP');
  const service = newService({ providers: { EMAIL: email, SMS: sms, WHATSAPP: whatsapp } });

  const result = await service.dispatch(request());

  assert.equal(result.dryRun, true);
  assert.equal(result.totalCandidates, 3);
  assert.equal(result.summary.DRY_RUN, 3);
  assert.equal(result.summary.SENT, 0);
  assert.equal(result.summary.FAILED, 0);
  assert.equal(email.calls.length, 1);
  assert.equal(sms.calls.length, 1);
  assert.equal(whatsapp.calls.length, 1);
  assert.equal(networkCalls.length, 0);

  const rows = notificationRows();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.delivery_status), ['DRY_RUN', 'DRY_RUN', 'DRY_RUN']);
  assert.deepEqual(rows.map(row => row.status), ['DRY_RUN', 'DRY_RUN', 'DRY_RUN']);
  assert.ok(rows.every(row => row.provider_message_id === null));
  assert.ok(rows.every(row => row.is_prototype === 1));
  assert.ok(rows.every(row => !['SENT', 'DELIVERED'].includes(row.status)));
});

test('email dry-run records the payload without SMTP credentials', async () => {
  seedSubscriber({ emailEnabled: 1 });
  const service = newService();
  const result = await service.dispatch(request());
  const row = notificationRows()[0];
  const metadata = JSON.parse(row.metadata);

  assert.equal(result.results[0].status, 'DRY_RUN');
  assert.equal(result.results[0].attempts, 1);
  assert.equal(result.results[0].providerMessageId, null);
  assert.equal(row.delivery_status, 'DRY_RUN');
  assert.equal(row.provider_message_id, null);
  assert.equal(row.retry_count, 0);
  assert.equal(metadata.dry_run, true);
  assert.equal(metadata.simulated, true);
  assert.equal(metadata.provider, 'smtp');
  assert.equal(metadata.provider_configured, false);
  assert.equal(metadata.dry_run_reason, 'SMTP_CONFIG_MISSING');
  assert.match(metadata.recipient_masked, /^n\*\*\*@example\.com$/);
  assert.match(metadata.payload.subject, /^\[DRY RUN\]/);
  assert.match(metadata.payload.body, /not delivered/);
  assert.match(metadata.payload.body, /Critical flood risk is projected/);
  assert.equal(networkCalls.length, 0);
});

test('MAIL_DRY_RUN=false still cannot enable live email delivery', async () => {
  process.env.MAIL_DRY_RUN = 'false';
  process.env.SMTP_HOST = 'smtp.example.test';
  process.env.SMTP_USER = 'test-user';
  process.env.SMTP_PASS = 'test-pass';
  process.env.MAIL_FROM = 'alerts@example.test';
  process.env.NOTIFICATION_DRY_RUN = 'false';
  process.env.NOTIFICATION_LIVE_SEND_ENABLED = 'true';
  seedSubscriber({ emailEnabled: 1 });

  const config = loadNotificationConfig();
  const service = newService({ config });
  const result = await service.dispatch(request({ channels: ['EMAIL'] }));

  assert.equal(config.liveSendEnabled, false);
  assert.equal(config.masterDryRun, true);
  assert.equal(result.results[0].status, 'DRY_RUN');
  assert.equal(networkCalls.length, 0);
  assert.equal(notificationRows()[0].provider_message_id, null);
});

test('SMS and WhatsApp require recorded consent', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.WHATSAPP_ENABLED = 'true';
  seedSubscriber({
    emailEnabled: 0,
    smsEnabled: 1,
    whatsappEnabled: 1,
    consentGivenAt: null,
  });
  const sms = dryRunProvider('SMS');
  const whatsapp = dryRunProvider('WHATSAPP');
  const service = newService({ providers: { SMS: sms, WHATSAPP: whatsapp } });

  const result = await service.dispatch(request({ channels: ['SMS', 'WHATSAPP'] }));

  assert.equal(result.totalCandidates, 2);
  assert.deepEqual(result.results.map(item => item.status), ['SKIPPED', 'SKIPPED']);
  assert.deepEqual(result.results.map(item => item.skipReason), ['CONSENT_REQUIRED', 'CONSENT_REQUIRED']);
  assert.equal(sms.calls.length, 0);
  assert.equal(whatsapp.calls.length, 0);
  assert.equal(notificationRows().length, 0);
  assert.equal(networkCalls.length, 0);
});

test('unsubscribe_all blocks every channel', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.WHATSAPP_ENABLED = 'true';
  seedSubscriber({
    emailEnabled: 1,
    smsEnabled: 1,
    whatsappEnabled: 1,
    consentGivenAt: new Date().toISOString(),
    unsubscribedAllAt: new Date().toISOString(),
  });
  const email = dryRunProvider('EMAIL');
  const sms = dryRunProvider('SMS');
  const whatsapp = dryRunProvider('WHATSAPP');
  const service = newService({ providers: { EMAIL: email, SMS: sms, WHATSAPP: whatsapp } });

  const result = await service.dispatch(request());

  assert.equal(result.summary.SKIPPED, 3);
  assert.ok(result.results.every(item => item.skipReason === 'UNSUBSCRIBED'));
  assert.equal(email.calls.length + sms.calls.length + whatsapp.calls.length, 0);
  assert.equal(notificationRows().length, 0);
});

test('provider enable flags remain off by default', async () => {
  seedSubscriber({
    emailEnabled: 0,
    smsEnabled: 1,
    whatsappEnabled: 1,
    consentGivenAt: new Date().toISOString(),
  });
  const sms = dryRunProvider('SMS');
  const whatsapp = dryRunProvider('WHATSAPP');
  const service = newService({ providers: { SMS: sms, WHATSAPP: whatsapp } });

  const result = await service.dispatch(request({ channels: ['SMS', 'WHATSAPP'] }));

  assert.ok(result.results.every(item => item.skipReason === 'CHANNEL_DISABLED'));
  assert.equal(sms.calls.length, 0);
  assert.equal(whatsapp.calls.length, 0);
});

test('missing notification preferences skip delivery', async () => {
  seedSubscriber({ withPreferences: false });
  const service = newService();
  const result = await service.dispatch(request());
  assert.equal(result.results[0].status, 'SKIPPED');
  assert.equal(result.results[0].skipReason, 'NO_PREFERENCES');
  assert.equal(notificationRows().length, 0);
});

test('subscription minimum severity suppresses lower alerts', async () => {
  seedSubscriber({ minSeverity: 'HIGH', emailEnabled: 1 });
  const service = newService();
  const result = await service.dispatch(request({ alertLevel: 'WATCH' }));
  assert.equal(result.totalCandidates, 0);
  assert.equal(notificationRows().length, 0);
});

test('per-user per-channel rate limit prevents a second dry-run attempt', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.NOTIFICATION_RATE_LIMIT_PER_HOUR = '1';
  seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
  const sms = dryRunProvider('SMS');
  const config = loadNotificationConfig();
  const service = newService({
    config,
    providers: { SMS: sms },
    rateLimiter: new NotificationRateLimiter(),
  });

  const first = await service.dispatch(request({ channels: ['SMS'] }));
  const second = await service.dispatch(request({ channels: ['SMS'] }));

  assert.equal(first.results[0].status, 'DRY_RUN');
  assert.equal(second.results[0].status, 'RATE_LIMITED');
  assert.equal(sms.calls.length, 1);
  const rows = notificationRows();
  assert.deepEqual(rows.map(row => row.delivery_status), ['DRY_RUN', 'RATE_LIMITED']);
  assert.equal(rows[1].provider_message_id, null);
});

test('bounded retries stop after the configured maximum and never record SENT', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.NOTIFICATION_MAX_RETRIES = '2';
  seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
  const sms = mockProvider('SMS', async () => ({
    status: 'FAILED',
    simulated: false,
    providerMessageId: null,
    realProviderConfirmation: false,
    retryable: true,
    error: 'SIMULATED_PROVIDER_FAILURE',
  }));
  const service = newService({ providers: { SMS: sms } });

  const result = await service.dispatch(request({ channels: ['SMS'] }));
  const row = notificationRows()[0];

  assert.equal(sms.calls.length, 3);
  assert.equal(result.results[0].status, 'FAILED');
  assert.equal(result.results[0].attempts, 3);
  assert.equal(result.summary.SENT, 0);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.delivery_status, 'FAILED');
  assert.equal(row.retry_count, 2);
  assert.equal(row.provider_message_id, null);
  assert.match(JSON.parse(row.metadata).error, /SIMULATED_PROVIDER_FAILURE/);
});

test('retry can recover to a DRY_RUN result without network calls', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.NOTIFICATION_MAX_RETRIES = '2';
  seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
  const sms = mockProvider('SMS', async (_message, callNumber) => {
    if (callNumber === 1) {
      return {
        status: 'FAILED',
        simulated: false,
        providerMessageId: null,
        realProviderConfirmation: false,
        retryable: true,
        error: 'TRANSIENT_FAILURE',
      };
    }
    return {
      status: 'DRY_RUN',
      simulated: true,
      providerMessageId: null,
      realProviderConfirmation: false,
      retryable: false,
      dryRunReason: 'TEST_RECOVERED_DRY_RUN',
    };
  });
  const service = newService({ providers: { SMS: sms } });

  const result = await service.dispatch(request({ channels: ['SMS'] }));
  const row = notificationRows()[0];

  assert.equal(sms.calls.length, 2);
  assert.equal(result.results[0].status, 'DRY_RUN');
  assert.equal(result.results[0].attempts, 2);
  assert.equal(row.delivery_status, 'DRY_RUN');
  assert.equal(row.retry_count, 1);
  assert.equal(row.provider_message_id, null);
  assert.equal(networkCalls.length, 0);
});

test('provider SENT without real confirmation or message ID is downgraded to FAILED', async () => {
  process.env.SMS_ENABLED = 'true';
  seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
  const sms = mockProvider('SMS', async () => ({
    status: 'SENT',
    simulated: false,
    providerMessageId: null,
    realProviderConfirmation: false,
    retryable: false,
  }));
  const config = {
    ...loadNotificationConfig(),
    masterDryRun: false,
    sms: { ...loadNotificationConfig().sms, dryRun: false, enabled: true },
  };
  const service = newService({ config, providers: { SMS: sms } });

  const result = await service.dispatch(request({ channels: ['SMS'] }));
  const row = notificationRows()[0];

  assert.equal(result.results[0].status, 'FAILED');
  assert.equal(result.results[0].error, 'UNCONFIRMED_PROVIDER_SUCCESS');
  assert.equal(row.status, 'FAILED');
  assert.notEqual(row.status, 'SENT');
  assert.equal(row.provider_message_id, null);
});

test('provider SENT is rejected while master DRY_RUN is active', async () => {
  process.env.SMS_ENABLED = 'true';
  seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
  const sms = mockProvider('SMS', async () => ({
    status: 'SENT',
    simulated: false,
    providerMessageId: 'real-looking-id',
    realProviderConfirmation: true,
    retryable: false,
  }));
  const service = newService({ providers: { SMS: sms } });

  const result = await service.dispatch(request({ channels: ['SMS'] }));
  const row = notificationRows()[0];

  assert.equal(result.results[0].status, 'FAILED');
  assert.equal(result.results[0].error, 'DRY_RUN_PROVIDER_RETURNED_SENT');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.provider_message_id, null);
});
