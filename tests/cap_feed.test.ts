import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getMongoTestUri, connectMongoTest, dropMongoTestDb, closeMongoTest, assertSafeMongoTestUri } from './helpers/mongo_test_harness';
import { parseCapAlert, parseRssItems } from '../src/services/cap/cap_parser';

const MONGO_URI = getMongoTestUri();
assertSafeMongoTestUri(MONGO_URI);
let mongo: any;

const IMD_FEED = 'https://mock.cap.test/imd.xml';
const SACHET_STATE_FEED = 'https://mock.cap.test/sachet-state.xml';
const SACHET_INDIA_FEED = 'https://mock.cap.test/sachet-india.xml';

type MockRoute = { status?: number; body: string; contentType?: string };
let routes: Record<string, MockRoute> = {};
let fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;

let imdCapService: any;
let matchAffectedAreas: (text: string) => any;

function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function capDocument(overrides: Partial<{
  identifier: string;
  sender: string;
  sent: string;
  status: string;
  msgType: string;
  event: string;
  severity: string;
  urgency: string;
  certainty: string;
  headline: string;
  description: string;
  instruction: string;
  areaDesc: string;
  expires: string;
  onset: string;
}> = {}): string {
  const now = new Date();
  const opts = {
    identifier: 'cap-1',
    sender: 'Telangana-SDMA',
    sent: now.toISOString(),
    status: 'Actual',
    msgType: 'Alert',
    event: 'Heavy Rain',
    severity: 'Severe',
    urgency: 'Expected',
    certainty: 'Likely',
    headline: 'Heavy rain likely over Warangal',
    description: 'Heavy rain is likely at isolated places.',
    instruction: 'Avoid low-lying areas.',
    areaDesc: 'Warangal',
    expires: new Date(now.getTime() + 6 * 3600000).toISOString(),
    onset: now.toISOString(),
    ...overrides,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <cap:identifier>${xmlEscape(opts.identifier)}</cap:identifier>
  <cap:sender>${xmlEscape(opts.sender)}</cap:sender>
  <cap:sent>${opts.sent}</cap:sent>
  <cap:status>${opts.status}</cap:status>
  <cap:msgType>${opts.msgType}</cap:msgType>
  <cap:scope>Public</cap:scope>
  <cap:info>
    <cap:language>en-IN</cap:language>
    <cap:category>Met</cap:category>
    <cap:event>${xmlEscape(opts.event)}</cap:event>
    <cap:responseType>Prepare</cap:responseType>
    <cap:urgency>${opts.urgency}</cap:urgency>
    <cap:severity>${opts.severity}</cap:severity>
    <cap:certainty>${opts.certainty}</cap:certainty>
    <cap:onset>${opts.onset}</cap:onset>
    <cap:effective>${opts.sent}</cap:effective>
    <cap:expires>${opts.expires}</cap:expires>
    <cap:senderName>Telangana State Disaster Management Authority</cap:senderName>
    <cap:headline>${xmlEscape(opts.headline)}</cap:headline>
    <cap:description>${xmlEscape(opts.description)}</cap:description>
    <cap:instruction>${xmlEscape(opts.instruction)}</cap:instruction>
    <cap:area>
      <cap:areaDesc>${xmlEscape(opts.areaDesc)}</cap:areaDesc>
    </cap:area>
  </cap:info>
</cap:alert>`;
}

function rssItem(title: string, link: string, pubDate: Date): string {
  return `<item>
    <title>${xmlEscape(title)}</title>
    <link>${link}</link>
    <guid isPermaLink="false">${link}</guid>
    <pubDate>${pubDate.toUTCString()}</pubDate>
  </item>`;
}

function rssFeed(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mock CAP feed</title>
    <description>Mock CAP feed</description>
    ${items.join('\n')}
  </channel>
</rss>`;
}

function configureFeeds(options: { imd?: boolean; sachet?: boolean; includeIndia?: boolean } = {}): void {
  process.env.IMD_CAP_ENABLED = options.imd === false ? 'false' : 'true';
  process.env.SACHET_CAP_ENABLED = options.sachet === false ? 'false' : 'true';
  process.env.SACHET_CAP_INCLUDE_ALL_INDIA = options.includeIndia === false ? 'false' : 'true';
}

async function clearCapRows(): Promise<void> {
  await mongo.db.collection('external_signals').deleteMany({ signal_type: 'official_alert' });
}
async function capRows(): Promise<any[]> {
  return await mongo.db.collection('external_signals').find({ signal_type: 'official_alert' }).sort({ id: 1, _id: 1 }).toArray();
}

before(async () => {
  process.env.MONGODB_URI = MONGO_URI;
  mongo = await connectMongoTest(MONGO_URI);
  await mongo.db.dropDatabase();
  const { initDatabase } = await import('../src/db/mongo');
  await initDatabase();
  process.env.IMD_CAP_RSS_URL = IMD_FEED;
  process.env.SACHET_CAP_RSS_URL = SACHET_STATE_FEED;
  process.env.SACHET_CAP_ALL_INDIA_RSS_URL = SACHET_INDIA_FEED;
  process.env.CAP_TELANGANA_ONLY = 'true';
  process.env.CAP_TIMEOUT_MS = '500';
  process.env.CAP_RETRIES = '2';
  process.env.CAP_RETRY_BACKOFF_MS = '1';
  process.env.CAP_MAX_ITEMS = '10';
  process.env.CAP_STALE_AFTER_HOURS = '24';
  configureFeeds();

  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    fetchCalls.push(url);
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body, {
      status: route.status || 200,
      headers: { 'Content-Type': route.contentType || 'application/xml' },
    });
  }) as any;

  const serviceModule = await import('../src/services/cap/imd_cap_service');
  imdCapService = serviceModule.imdCapService;
  matchAffectedAreas = serviceModule.matchAffectedAreas;
});

after(() => {
  globalThis.fetch = originalFetch;

});

test('CAP parser rejects malformed documents instead of fabricating alerts', () => {
  const missing = parseCapAlert('<not-cap><identifier>x</identifier></not-cap>');
  assert.equal(missing.alert, null);
  assert.match(missing.error || '', /Not a CAP alert/i);

  const malformed = parseCapAlert('<cap:alert><cap:identifier>x</cap:identifier>');
  assert.equal(malformed.alert, null);

  const missingSender = parseCapAlert(capDocument().replace(/<cap:sender>.*?<\/cap:sender>/, ''));
  assert.equal(missingSender.alert, null);
  assert.equal(missingSender.partialIdentifier, 'cap-1');
  assert.match(missingSender.error || '', /sender/i);
});

test('CAP parser accepts namespaced CAP 1.2 alerts and RSS items', () => {
  const parsed = parseCapAlert(capDocument({ identifier: 'cap-ns-1' }));
  assert.ok(parsed.alert);
  assert.equal(parsed.alert.identifier, 'cap-ns-1');
  assert.equal(parsed.alert.info.areas[0].areaDesc, 'Warangal');
  assert.equal(parsed.alert.msgType, 'Alert');

  const items = parseRssItems(rssFeed([
    rssItem('Heavy rain over Warangal', 'https://mock.cap.test/cap/1', new Date()),
  ]));
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://mock.cap.test/cap/1');
});

test('district matcher handles names, abbreviations, and statewide phrases', () => {
  assert.deepEqual(matchAffectedAreas('MLG, KHM districts of Telangana').matchedDistrictIds.sort(), ['khammam', 'mulugu']);
  assert.deepEqual(matchAffectedAreas('Heavy rain over Bhadradri Kothagudem').matchedDistrictIds, ['bhadradri_kothagudem']);
  assert.equal(matchAffectedAreas('remaining districts of Telangana').areaScope, 'STATE');
  assert.equal(matchAffectedAreas('remaining districts of Telangana').matchedDistrictIds.length, 33);
  assert.equal(matchAffectedAreas('16 districts of Telangana').areaScope, 'STATE');
  assert.equal(matchAffectedAreas('Goa').telanganaRelevant, false);
});

test('refresh ingests IMD and SACHET alerts, maps districts, and prefilters all-India items', async () => {
  await clearCapRows();
  configureFeeds({ includeIndia: true });
  const now = new Date();
  const imdLink = 'https://mock.cap.test/cap/imd-1';
  const sachetLink = 'https://mock.cap.test/cap/sachet-1';
  const apLink = 'https://mock.cap.test/cap/ap-1';
  routes = {
    [IMD_FEED]: {
      body: rssFeed([rssItem('Heavy rain over Warangal', imdLink, now)]),
    },
    [SACHET_STATE_FEED]: {
      body: rssFeed([rssItem('Heavy Rainfall in MLG, KHM districts of Telangana', sachetLink, now)]),
    },
    [SACHET_INDIA_FEED]: {
      body: rssFeed([
        rssItem('Heavy Rainfall in MLG, KHM districts of Telangana', sachetLink, now),
        rssItem('Heavy rain over Vijayawada', apLink, now),
      ]),
    },
    [imdLink]: { body: capDocument({ identifier: 'imd-1', areaDesc: 'Warangal', severity: 'Moderate' }) },
    [sachetLink]: {
      body: capDocument({
        identifier: 'sach-1',
        headline: 'Heavy Rainfall in MLG, KHM districts of Telangana',
        areaDesc: '16 districts of Telangana',
      }),
    },
  };

  const result = await imdCapService.refresh();
  assert.equal(result.status, 'HEALTHY');
  assert.equal(result.stored, 3);
  assert.equal(result.duplicates, 1);
  assert.equal((await capRows()).length, 3);

  const rows = await capRows();
  assert.ok(rows.every(row => row.signal_type === 'official_alert'));
  assert.ok(rows.every(row => row.data_mode === 'FORECAST'));
  assert.ok(rows.every(row => row.unit === 'severity_code'));
  assert.deepEqual(rows.map(row => row.district_id).sort(), ['khammam', 'mulugu', 'warangal']);
  assert.ok(!rows.some(row => row.district_id === 'STATE_TELANGANA'));
  assert.ok(!fetchCalls.includes(apLink), 'all-India non-Telangana CAP documents must not be fetched');

  const active = imdCapService.getStoredAlerts(50, true, true);
  assert.equal(active.length, 3);
  assert.ok(active.every((alert: any) => alert.lifecycle === 'ACTIVE'));
  assert.ok(active.some((alert: any) => alert.feedKey === 'IMD'));
  assert.ok(active.some((alert: any) => alert.feedKey === 'SACHET_STATE'));

  const status = imdCapService.getStatus();
  assert.equal(status.feeds.length, 3);
  assert.ok(status.feeds.every((feed: any) => feed.health === 'HEALTHY'));
});

test('re-refresh suppresses duplicate alerts without adding rows', async () => {
  const beforeCount = (await capRows()).length;
  const rerun = await imdCapService.refresh();
  assert.equal((await capRows()).length, beforeCount);
  assert.ok(rerun.duplicates >= beforeCount);
});

test('newer Update supersedes the same identifier and district', async () => {
  await clearCapRows();
  configureFeeds({ imd: false, includeIndia: false });
  const firstSent = new Date(Date.now() - 60_000);
  const firstLink = 'https://mock.cap.test/cap/update-1';
  const firstDoc = capDocument({
    identifier: 'sach-update-1',
    sent: firstSent.toISOString(),
    msgType: 'Alert',
    severity: 'Moderate',
    areaDesc: 'Khammam',
    headline: 'Heavy rain warning for Khammam',
  });
  routes = {
    [SACHET_STATE_FEED]: { body: rssFeed([rssItem('Heavy rain over Khammam', firstLink, firstSent)]) },
    [firstLink]: { body: firstDoc },
  };
  await imdCapService.refresh();

  const updateSent = new Date();
  const updateDoc = capDocument({
    identifier: 'sach-update-1',
    sent: updateSent.toISOString(),
    msgType: 'Update',
    severity: 'Severe',
    areaDesc: 'Khammam',
    headline: 'Updated severe rain warning for Khammam',
  });
  routes[SACHET_STATE_FEED] = { body: rssFeed([rssItem('Updated heavy rain over Khammam', firstLink, updateSent)]) };
  routes[firstLink] = { body: updateDoc };
  const result = await imdCapService.refresh();
  assert.equal(result.stored, 1);

  const active = imdCapService.getStoredAlerts(50, true, true).filter((alert: any) => alert.identifier === 'sach-update-1');
  assert.equal(active.length, 1);
  assert.equal(active[0].msgType, 'Update');
  assert.equal(active[0].severity, 'Severe');
  assert.match(active[0].headline || '', /Updated/);
});

test('Cancel is stored and excluded from active alerts', async () => {
  const cancelSent = new Date(Date.now() + 5_000);
  const link = 'https://mock.cap.test/cap/cancel-1';
  routes[SACHET_STATE_FEED] = { body: rssFeed([rssItem('Cancelled warning for Khammam', link, cancelSent)]) };
  routes[link] = {
    body: capDocument({
      identifier: 'sach-update-1',
      sent: cancelSent.toISOString(),
      msgType: 'Cancel',
      areaDesc: 'Khammam',
      headline: 'Cancelled warning for Khammam',
    }),
  };
  const result = await imdCapService.refresh();
  assert.equal(result.stored, 1);

  const active = imdCapService.getStoredAlerts(50, true, true).filter((alert: any) => alert.identifier === 'sach-update-1');
  assert.equal(active.length, 0);
  const all = imdCapService.getStoredAlerts(50, true, false).filter((alert: any) => alert.identifier === 'sach-update-1');
  assert.equal(all.length, 1);
  assert.equal(all[0].lifecycle, 'CANCELLED');
  assert.equal(imdCapService.getAlertSummary().cancelled_count, 1);
});

test('expired warnings are stored but excluded from active alerts', async () => {
  await clearCapRows();
  const sent = new Date(Date.now() - 3 * 3600000);
  const link = 'https://mock.cap.test/cap/expired-1';
  routes[SACHET_STATE_FEED] = { body: rssFeed([rssItem('Expired warning for Warangal', link, sent)]) };
  routes[link] = {
    body: capDocument({
      identifier: 'sach-expired-1',
      sent: sent.toISOString(),
      expires: new Date(Date.now() - 2 * 3600000).toISOString(),
      areaDesc: 'Warangal',
    }),
  };
  const result = await imdCapService.refresh();
  assert.equal(result.stored, 1);
  assert.equal(imdCapService.getStoredAlerts(50, true, true).length, 0);
  const all = imdCapService.getStoredAlerts(50, true, false);
  assert.equal(all.length, 1);
  assert.equal(all[0].lifecycle, 'EXPIRED');
});

test('Test and Exercise CAP alerts are never stored as operational warnings', async () => {
  await clearCapRows();
  const now = new Date();
  const testLink = 'https://mock.cap.test/cap/test-1';
  const exerciseLink = 'https://mock.cap.test/cap/exercise-1';
  routes[SACHET_STATE_FEED] = {
    body: rssFeed([
      rssItem('Test warning for Warangal', testLink, now),
      rssItem('Exercise warning for Warangal', exerciseLink, now),
    ]),
  };
  routes[testLink] = { body: capDocument({ identifier: 'test-1', status: 'Test', areaDesc: 'Warangal' }) };
  routes[exerciseLink] = { body: capDocument({ identifier: 'exercise-1', status: 'Exercise', areaDesc: 'Warangal' }) };
  const result = await imdCapService.refresh();
  assert.equal(result.stored, 0);
  assert.equal(result.skipped, 2);
  assert.equal((await capRows()).length, 0);
});

test('empty feeds are reported STALE, never HEALTHY', async () => {
  await clearCapRows();
  configureFeeds({ imd: false, includeIndia: false });
  routes[SACHET_STATE_FEED] = { body: rssFeed([]) };
  const result = await imdCapService.refresh();
  assert.equal(result.stored, 0);
  assert.equal(result.status, 'STALE');
  const stateFeed = imdCapService.getStatus().feeds.find((feed: any) => feed.key === 'SACHET_STATE');
  assert.equal(stateFeed.health, 'STALE');
  const active = imdCapService.getStoredAlerts(50, true, true);
  assert.equal(active.length, 0);
});

test('feed outages are reported OFFLINE without throwing or fabricating alerts', async () => {
  await clearCapRows();
  configureFeeds({ imd: false, includeIndia: false });
  routes[SACHET_STATE_FEED] = { status: 500, body: 'upstream error' };
  fetchCalls = [];
  const result = await imdCapService.refresh();
  assert.equal(result.status, 'OFFLINE');
  assert.ok(result.errors >= 1);
  assert.equal((await capRows()).length, 0);
  assert.ok(fetchCalls.filter(url => url === SACHET_STATE_FEED).length >= 2, 'transient feed failures should be retried');
});
