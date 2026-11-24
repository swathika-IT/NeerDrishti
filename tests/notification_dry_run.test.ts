import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { getMongoTestUri, connectMongoTest, dropMongoTestDb, closeMongoTest, assertSafeMongoTestUri } from './helpers/mongo_test_harness';

const MONGO_URI = getMongoTestUri();
assertSafeMongoTestUri(MONGO_URI);
let mongo: any;

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

  process.env.MONGODB_URI = MONGO_URI;
process.env.NOTIFICATION_DRY_RUN = 'true';
  process.env.NOTIFICATION_LIVE_SEND_ENABLED = 'false';
  process.env.NOTIFICATION_MAX_RETRIES = '2';
  process.env.NOTIFICATION_RETRY_BACKOFF_MS = '1';
  process.env.NOTIFICATION_RATE_LIMIT_PER_HOUR = '10';
  process.env.MAIL_DRY_RUN = 'true';
}

async function resetFixtures(): Promise<void> {
  await mongo.db.collection('notification_history').deleteMany({});
  await mongo.db.collection('alert_subscriptions').deleteMany({});
  await mongo.db.collection('notification_preferences').deleteMany({});
  await mongo.db.collection('users').deleteMany({ email: { $regex: '^notify-test-' } });
}
async function nextSeq(name: string) {
  const r = await mongo.db.collection('sequences').findOneAndUpdate({ name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
  return Number(r?.value || 1);
}

async function seedSubscriber(options: {
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
} = {}): Promise<number> {
  userSequence += 1;
  const now = new Date();
  const email = options.email || `notify-test-${userSequence}@example.com`;
  const userId = userSequence;
  await mongo.db.collection('users').insertOne({
    _id: userId, email, password_hash: 'not-a-real-password-hash', full_name: `Notification Test ${userSequence}`, role: 'CITIZEN', status: options.status || 'ACTIVE', phone: options.phone === undefined ? '+919999999999' : options.phone, phone_verified: 1, email_verified_at: now, created_at: now, updated_at: now,
  });
  await mongo.db.collection('alert_subscriptions').insertOne({ _id: await nextSeq('alert_subscriptions'), user_id: userId, district_id: options.districtId || 'hyderabad', min_severity: options.minSeverity || 'WATCH', created_at: now });
  if (options.withPreferences !== false) {
    await mongo.db.collection('notification_preferences').insertOne({
      _id: userId, user_id: userId, email_enabled: options.emailEnabled ?? 1, sms_enabled: options.smsEnabled ?? 0, whatsapp_enabled: options.whatsappEnabled ?? 0,
      consent_given_at: options.consentGivenAt || null, consent_source: options.consentGivenAt ? 'test' : null, unsubscribed_all_at: options.unsubscribedAllAt || null, updated_at: now,
    });
  }
  return userId;
}

async function notificationRows(): Promise<any[]> {
  return await mongo.db.collection('notification_history').find({}).sort({ timestamp: 1, id: 1, _id: 1 }).toArray();
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
  process.env.MONGODB_URI = MONGO_URI;
  mongo = await connectMongoTest(MONGO_URI);
  await mongo.db.dropDatabase();
  const { initDatabase } = await import('../src/db/mongo');
  await initDatabase();
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

beforeEach(async () => {
  setBaseEnv();
  await resetFixtures();
  networkCalls.length = 0;
});

after(async () => {
  globalThis.fetch = originalFetch;
  (net as any).connect = originalNetConnect;
  (tls as any).connect = originalTlsConnect;
  if (mongo) { await dropMongoTestDb(mongo); await closeMongoTest(mongo); }
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
  await seedSubscriber({
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

  const rows = await notificationRows();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.delivery_status), ['DRY_RUN', 'DRY_RUN', 'DRY_RUN']);
  assert.deepEqual(rows.map(row => row.status), ['DRY_RUN', 'DRY_RUN', 'DRY_RUN']);
  assert.ok(rows.every(row => row.provider_message_id === null));
  assert.ok(rows.every(row => row.is_prototype === 1));
  assert.ok(rows.every(row => !['SENT', 'DELIVERED'].includes(row.status)));
});

test('email dry-run records the payload without SMTP credentials', async () => {
  await seedSubscriber({ emailEnabled: 1 });
  const service = newService();
  const result = await service.dispatch(request());
  const row = await notificationRows()[0];
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
  await seedSubscriber({ emailEnabled: 1 });

  const config = loadNotificationConfig();
  const service = newService({ config });
  const result = await service.dispatch(request({ channels: ['EMAIL'] }));

  assert.equal(config.liveSendEnabled, false);
  assert.equal(config.masterDryRun, true);
  assert.equal(result.results[0].status, 'DRY_RUN');
  assert.equal(networkCalls.length, 0);
  const rowsAfter = await notificationRows(); assert.equal(rowsAfter[0].provider_message_id, null);
});

test('SMS and WhatsApp require recorded consent', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.WHATSAPP_ENABLED = 'true';
  await seedSubscriber({
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
  assert.equal((await notificationRows()).length, 0);
  assert.equal(networkCalls.length, 0);
});

test('unsubscribe_all blocks every channel', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.WHATSAPP_ENABLED = 'true';
  await seedSubscriber({
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
  assert.equal((await notificationRows()).length, 0);
});

test('provider enable flags remain off by default', async () => {
  await seedSubscriber({
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
  await seedSubscriber({ withPreferences: false });
  const service = newService();
  const result = await service.dispatch(request());
  assert.equal(result.results[0].status, 'SKIPPED');
  assert.equal(result.results[0].skipReason, 'NO_PREFERENCES');
  assert.equal((await notificationRows()).length, 0);
});

test('subscription minimum severity suppresses lower alerts', async () => {
  await seedSubscriber({ minSeverity: 'HIGH', emailEnabled: 1 });
  const service = newService();
  const result = await service.dispatch(request({ alertLevel: 'WATCH' }));
  assert.equal(result.totalCandidates, 0);
  assert.equal((await notificationRows()).length, 0);
});

test('per-user per-channel rate limit prevents a second dry-run attempt', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.NOTIFICATION_RATE_LIMIT_PER_HOUR = '1';
  await seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
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
  const rows = await notificationRows();
  assert.deepEqual(rows.map(row => row.delivery_status), ['DRY_RUN', 'RATE_LIMITED']);
  assert.equal(rows[1].provider_message_id, null);
});

test('bounded retries stop after the configured maximum and never record SENT', async () => {
  process.env.SMS_ENABLED = 'true';
  process.env.NOTIFICATION_MAX_RETRIES = '2';
  await seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
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
  const row = await notificationRows()[0];

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
  await seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
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
  const row = await notificationRows()[0];

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
  await seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
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
  const row = await notificationRows()[0];

  assert.equal(result.results[0].status, 'FAILED');
  assert.equal(result.results[0].error, 'UNCONFIRMED_PROVIDER_SUCCESS');
  assert.equal(row.status, 'FAILED');
  assert.notEqual(row.status, 'SENT');
  assert.equal(row.provider_message_id, null);
});

test('provider SENT is rejected while master DRY_RUN is active', async () => {
  process.env.SMS_ENABLED = 'true';
  await seedSubscriber({ emailEnabled: 0, smsEnabled: 1, consentGivenAt: new Date().toISOString() });
  const sms = mockProvider('SMS', async () => ({
    status: 'SENT',
    simulated: false,
    providerMessageId: 'real-looking-id',
    realProviderConfirmation: true,
    retryable: false,
  }));
  const service = newService({ providers: { SMS: sms } });

  const result = await service.dispatch(request({ channels: ['SMS'] }));
  const row = await notificationRows()[0];

  assert.equal(result.results[0].status, 'FAILED');
  assert.equal(result.results[0].error, 'DRY_RUN_PROVIDER_RETURNED_SENT');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.provider_message_id, null);
});
