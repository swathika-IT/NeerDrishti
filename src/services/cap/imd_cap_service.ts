import fs from 'fs';
import path from 'path';
import {
  parseRssItems,
  parseCapAlert,
  alertLifecycleStatus,
  type CapAlert,
  type CapRssItem,
} from './cap_parser';
import { getDb as getMongoDb, insertExternalSignal } from '../../db/mongo';
import { DATA_SOURCES } from '../../config/data_sources';

const DEFAULT_IMD_CAP_URL = 'https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml';
const DEFAULT_SACHET_STATE_URL = 'https://sachet.ndma.gov.in/cap_public_website/rss/rss_telangana.xml';
const DEFAULT_SACHET_INDIA_URL = 'https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml';

export const CAP_SOURCE_NAME = 'IMD CAP Feed (WMO Alert Hub aggregation)';
export const SACHET_CAP_SOURCE_NAME = 'NDMA SACHET CAP Feed';
export const CAP_SOURCE_TYPE = 'official_api';

export type CapHealth = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'STALE' | 'OFFLINE';
export type CapFeedKey = 'IMD' | 'SACHET_STATE' | 'SACHET_INDIA';

export interface CapAlertView {
  id: number;
  identifier: string;
  sender: string;
  sent: string;
  msgType: string;
  status: string;
  event: string;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  onset: string | null;
  expires: string | null;
  web: string | null;
  areaDesc: string;
  matchedDistrictIds: string[];
  areaScope: 'DISTRICT' | 'STATE' | 'OTHER';
  telanganaRelevant: boolean;
  capUrl: string | null;
  feedKey: CapFeedKey | null;
  publisher: string | null;
  sourceName: string;
  lifecycle: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  recorded_at: string;
}

export interface CapFeedStatus {
  key: CapFeedKey;
  label: string;
  publisher: string;
  url: string;
  enabled: boolean;
  health: CapHealth;
  item_count: number;
  relevant_item_count: number;
  latest_item_at: string | null;
  last_fetch_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  stored_count: number;
  duplicate_count: number;
  skipped_non_telangana: number;
  skipped_inactive: number;
  parse_error_count: number;
  parse_errors: { url: string; error: string }[];
}

export interface CapRefreshResult {
  status: CapHealth;
  items: number;
  relevant_items: number;
  stored: number;
  duplicates: number;
  skipped: number;
  errors: number;
  feeds: CapFeedStatus[];
}

interface ResolvedCapConfig {
  enabled: boolean;
  telanganaOnly: boolean;
  timeoutMs: number;
  maxItems: number;
  refreshMinutes: number;
  retries: number;
  retryBackoffMs: number;
  staleAfterHours: number;
  imdEnabled: boolean;
  imdUrl: string;
  sachetEnabled: boolean;
  sachetStateUrl: string;
  sachetIncludeIndia: boolean;
  sachetIndiaUrl: string;
}

interface CapFeedDefinition {
  key: CapFeedKey;
  label: string;
  publisher: string;
  sourceName: string;
  origin: string;
  url: string;
  prefilter: boolean;
}

interface FeedRuntimeState {
  key: CapFeedKey;
  label: string;
  publisher: string;
  url: string;
  enabled: boolean;
  health: CapHealth;
  itemCount: number;
  relevantItemCount: number;
  latestItemAt: string | null;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  storedCount: number;
  duplicateCount: number;
  skippedNonTelangana: number;
  skippedInactive: number;
  parseErrors: { url: string; error: string }[];
}

interface AreaMatch {
  matchedDistrictIds: string[];
  areaScope: 'DISTRICT' | 'STATE' | 'OTHER';
  telanganaRelevant: boolean;
}

interface ItemResult {
  stored: number;
  duplicates: number;
  skipped: number;
  skippedNonTelangana: number;
  errors: number;
  parseError?: { url: string; error: string };
}

const SEVERITY_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
const HEALTH_RANK: Record<CapHealth, number> = { HEALTHY: 0, UNKNOWN: 1, STALE: 2, DEGRADED: 3, OFFLINE: 4 };

const DISTRICT_CODE_MAP: Record<string, string> = {
  ADB: 'adilabad',
  BDDK: 'bhadradri_kothagudem',
  HNK: 'hanumakonda',
  HYD: 'hyderabad',
  JGLG: 'jogulamba_gadwal',
  JNG: 'jangaon',
  JSKB: 'jayashankar_bhupalpally',
  JTL: 'jagtial',
  KHM: 'khammam',
  KMB: 'kumuram_bheem_asifabad',
  KMR: 'kamareddy',
  KRM: 'karimnagar',
  MBB: 'mahabubabad',
  MBN: 'mahabubnagar',
  MCR: 'mancherial',
  MDM: 'medchal_malkajgiri',
  MED: 'medak',
  MHB: 'mahabubnagar',
  MLG: 'mulugu',
  MNCL: 'mancherial',
  NGKR: 'nagarkurnool',
  NKL: 'nagarkurnool',
  NLG: 'nalgonda',
  NRM: 'nirmal',
  NRPT: 'narayanpet',
  NZB: 'nizamabad',
  PPL: 'peddapalli',
  RJS: 'rajanna_sircilla',
  RR: 'ranga_reddy',
  SDP: 'siddipet',
  SGR: 'sangareddy',
  SRPT: 'suryapet',
  VKR: 'vikarabad',
  WGL: 'warangal',
  WNP: 'wanaparthy',
  YDDB: 'yadadri_bhuvanagiri',
};

const DISTRICT_TEXT_ALIASES: Record<string, string> = {
  ASIFABAD: 'kumuram_bheem_asifabad',
  BHADRACHALAM: 'bhadradri_kothagudem',
  BHADRADRI: 'bhadradri_kothagudem',
  BHONGIR: 'yadadri_bhuvanagiri',
  BHUPALPALLY: 'jayashankar_bhupalpally',
  BHUVANAGIRI: 'yadadri_bhuvanagiri',
  GADWAL: 'jogulamba_gadwal',
  JANAGAON: 'jangaon',
  JAYASHANKAR: 'jayashankar_bhupalpally',
  JOGULAMBA: 'jogulamba_gadwal',
  KOMARAM_BHEEM: 'kumuram_bheem_asifabad',
  KOTHAGUDEM: 'bhadradri_kothagudem',
  KUMURAM_BHEEM: 'kumuram_bheem_asifabad',
  MAHABOOBABAD: 'mahabubabad',
  MAHABOOBNAGAR: 'mahabubnagar',
  MAHBUBNAGAR: 'mahabubnagar',
  MALKajgiri: 'medchal_malkajgiri',
  MEDCHAL: 'medchal_malkajgiri',
  RANGA_REDDY: 'ranga_reddy',
  RANGAREDDY: 'ranga_reddy',
  RAJANNA: 'rajanna_sircilla',
  SIRCILLA: 'rajanna_sircilla',
  YADADRI: 'yadadri_bhuvanagiri',
};

let districtCatalog: { id: string; name: string }[] | null = null;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== 'false' && raw !== '0';
}

function resolveConfig(): ResolvedCapConfig {
  const imdEnabled = readBoolean('IMD_CAP_ENABLED', true);
  const sachetEnabled = readBoolean('SACHET_CAP_ENABLED', true);
  return {
    enabled: imdEnabled || sachetEnabled,
    telanganaOnly: readBoolean('CAP_TELANGANA_ONLY', readBoolean('IMD_CAP_TELANGANA_ONLY', true)),
    timeoutMs: readPositiveInt('CAP_TIMEOUT_MS', readPositiveInt('IMD_CAP_TIMEOUT_MS', 8000)),
    maxItems: readPositiveInt('CAP_MAX_ITEMS', readPositiveInt('IMD_CAP_MAX_ITEMS', 30)),
    refreshMinutes: readPositiveInt('CAP_REFRESH_MINUTES', readPositiveInt('IMD_CAP_REFRESH_MINUTES', 15)),
    retries: readPositiveInt('CAP_RETRIES', 2),
    retryBackoffMs: readPositiveInt('CAP_RETRY_BACKOFF_MS', 300),
    staleAfterHours: readPositiveInt('CAP_STALE_AFTER_HOURS', 24),
    imdEnabled,
    imdUrl: process.env.IMD_CAP_RSS_URL || DEFAULT_IMD_CAP_URL,
    sachetEnabled,
    sachetStateUrl: process.env.SACHET_CAP_RSS_URL || DEFAULT_SACHET_STATE_URL,
    sachetIncludeIndia: readBoolean('SACHET_CAP_INCLUDE_ALL_INDIA', true),
    sachetIndiaUrl: process.env.SACHET_CAP_ALL_INDIA_RSS_URL || DEFAULT_SACHET_INDIA_URL,
  };
}

function buildFeedDefinitions(config: ResolvedCapConfig): CapFeedDefinition[] {
  const feeds: CapFeedDefinition[] = [
    {
      key: 'IMD',
      label: 'IMD CAP feed',
      publisher: 'India Meteorological Department (IMD) / WMO Alert Hub',
      sourceName: CAP_SOURCE_NAME,
      origin: 'OFFICIAL_IMD_CAP',
      url: config.imdUrl,
      prefilter: false,
    },
    {
      key: 'SACHET_STATE',
      label: 'NDMA SACHET Telangana feed',
      publisher: 'National Disaster Management Authority (NDMA) SACHET',
      sourceName: SACHET_CAP_SOURCE_NAME,
      origin: 'OFFICIAL_NDMA_SACHET_CAP',
      url: config.sachetStateUrl,
      prefilter: false,
    },
  ];
  if (config.sachetIncludeIndia) {
    feeds.push({
      key: 'SACHET_INDIA',
      label: 'NDMA SACHET all-India feed',
      publisher: 'National Disaster Management Authority (NDMA) SACHET',
      sourceName: SACHET_CAP_SOURCE_NAME,
      origin: 'OFFICIAL_NDMA_SACHET_CAP',
      url: config.sachetIndiaUrl,
      prefilter: true,
    });
  }
  return feeds;
}

function loadDistrictCatalog(): { id: string; name: string }[] {
  if (districtCatalog) return districtCatalog;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'telangana_districts.json'), 'utf-8');
    districtCatalog = (JSON.parse(raw) as any[]).map(d => ({
      id: String(d.district_id),
      name: String(d.district_name),
    }));
  } catch {
    districtCatalog = [];
  }
  return districtCatalog;
}

function normalizeForMatch(value: string): string {
  return ` ${String(value).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

export function matchAffectedAreas(areaDesc: string): AreaMatch {
  const haystack = normalizeForMatch(areaDesc);
  const tokens = new Set(haystack.trim().split(' ').filter(Boolean));
  const catalog = loadDistrictCatalog();
  const matched = new Set<string>();

  for (const district of catalog) {
    const name = normalizeForMatch(district.name).trim();
    if (name && haystack.includes(` ${name} `)) matched.add(district.id);
  }
  for (const [code, districtId] of Object.entries(DISTRICT_CODE_MAP)) {
    if (tokens.has(code)) matched.add(districtId);
  }
  for (const [alias, districtId] of Object.entries(DISTRICT_TEXT_ALIASES)) {
    const normalizedAlias = normalizeForMatch(alias).trim();
    if (normalizedAlias && haystack.includes(` ${normalizedAlias} `)) matched.add(districtId);
  }

  const stateWide =
    /(?:ALL|REMAINING|ENTIRE|WHOLE)\s+(?:THE\s+)?(?:\d+\s+)?DISTRICTS?/.test(haystack) ||
    /(?:STATEWIDE|STATE\s+WIDE|ACROSS\s+TELANGANA|ENTIRE\s+TELANGANA)/.test(haystack) ||
    /\b33\s+DISTRICTS?\b/.test(haystack);
  const stateMention = /\bTELANGANA\b/.test(haystack);

  if (stateWide) {
    return {
      matchedDistrictIds: catalog.map(d => d.id),
      areaScope: 'STATE',
      telanganaRelevant: true,
    };
  }
  if (matched.size > 0) {
    return {
      matchedDistrictIds: [...matched],
      areaScope: 'DISTRICT',
      telanganaRelevant: true,
    };
  }
  if (stateMention) {
    return { matchedDistrictIds: [], areaScope: 'STATE', telanganaRelevant: true };
  }
  return { matchedDistrictIds: [], areaScope: 'OTHER', telanganaRelevant: false };
}

function looksTelanganaRelevant(item: CapRssItem): boolean {
  const text = [item.title, item.description, item.guid].filter(Boolean).join(' ');
  return matchAffectedAreas(text).telanganaRelevant;
}

function alertSearchText(alert: CapAlert, item: CapRssItem): string {
  return [
    item.title,
    alert.info.headline,
    alert.info.description,
    alert.info.instruction,
    alert.info.event,
    alert.info.areas.map(a => a.areaDesc).join(' '),
  ].filter(Boolean).join(' ');
}

function computeFreshness(sentIso: string): 'FRESH' | 'AGING' | 'STALE' | 'EXPIRED' {
  const ageHours = Math.max(0, (Date.now() - new Date(sentIso).getTime()) / 3600000);
  if (!Number.isFinite(ageHours)) return 'EXPIRED';
  if (ageHours <= 6) return 'FRESH';
  if (ageHours <= 24) return 'AGING';
  if (ageHours <= 72) return 'STALE';
  return 'EXPIRED';
}

function latestDate(values: (string | null)[]): string | null {
  let latest: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const ts = new Date(value).getTime();
    if (Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function mapHealthToRegistry(health: CapHealth): 'HEALTHY' | 'STALE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN' {
  return health;
}

function worstHealth(states: FeedRuntimeState[]): CapHealth {
  let worst: CapHealth = 'HEALTHY';
  for (const state of states) {
    if (HEALTH_RANK[state.health] > HEALTH_RANK[worst]) worst = state.health;
  }
  return worst;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ImdCapService {
  private refreshTimer: NodeJS.Timeout | null = null;
  private initialRefreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private health: CapHealth = 'UNKNOWN';
  private lastFetchAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private lastItemCount = 0;
  private lastRelevantItemCount = 0;
  private lastStoredCount = 0;
  private lastDuplicateCount = 0;
  private lastSkippedNonTelangana = 0;
  private lastSkippedInactive = 0;
  private lastParseErrors: { url: string; error: string }[] = [];
  private feedStates = new Map<CapFeedKey, FeedRuntimeState>();

  public isEnabled(): boolean {
    return resolveConfig().enabled;
  }

  private createFeedStates(config: ResolvedCapConfig): Map<CapFeedKey, FeedRuntimeState> {
    const states = new Map<CapFeedKey, FeedRuntimeState>();
    for (const feed of buildFeedDefinitions(config)) {
      const enabled = feed.key === 'IMD' ? config.imdEnabled : config.sachetEnabled;
      states.set(feed.key, {
        key: feed.key,
        label: feed.label,
        publisher: feed.publisher,
        url: feed.url,
        enabled,
        health: enabled ? 'UNKNOWN' : 'OFFLINE',
        itemCount: 0,
        relevantItemCount: 0,
        latestItemAt: null,
        lastFetchAt: null,
        lastSuccessAt: null,
        lastError: enabled ? null : 'Feed disabled by configuration',
        storedCount: 0,
        duplicateCount: 0,
        skippedNonTelangana: 0,
        skippedInactive: 0,
        parseErrors: [],
      });
    }
    return states;
  }

  private async httpGet(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
          'User-Agent': 'NeerDrishti-Flood-Intelligence/1.0 (official CAP warning reader)',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async httpGetWithRetry(url: string, timeoutMs: number, retries: number, backoffMs: number): Promise<Response> {
    let lastError: any = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await this.httpGet(url, timeoutMs);
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`HTTP ${response.status}`);
          if (attempt < retries - 1) {
            await sleep(backoffMs * Math.pow(2, attempt));
            continue;
          }
        }
        return response;
      } catch (err) {
        lastError = err;
        if (attempt < retries - 1) {
          await sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
      }
    }
    throw lastError || new Error('CAP request failed');
  }

  private async hasStoredAlert(sourceName: string, identifier: string, sent: string, districtId: string): Promise<boolean> {
    const db = getMongoDb();
    const row = await db.collection('external_signals').findOne({
      source_name: sourceName,
      signal_type: 'official_alert',
      district_id: districtId,
      'metadata.cap_identifier': identifier,
      'metadata.sent': sent,
    });
    return Boolean(row);
  }

  private async processItem(
    feed: CapFeedDefinition,
    item: CapRssItem,
    config: ResolvedCapConfig,
    state: FeedRuntimeState,
    seenCapUrls: Set<string>,
    seenAlertKeys: Set<string>,
    seenStorageKeys: Set<string>,
  ): Promise<ItemResult> {
    const result: ItemResult = { stored: 0, duplicates: 0, skipped: 0, skippedNonTelangana: 0, errors: 0 };
    const capUrl = item.link || item.guid;
    if (!capUrl || !/^https:\/\//i.test(capUrl)) {
      result.errors = 1;
      result.parseError = { url: capUrl || '(missing link)', error: 'RSS item has no usable https CAP link' };
      return result;
    }
    if (seenCapUrls.has(capUrl)) {
      result.duplicates = 1;
      return result;
    }
    seenCapUrls.add(capUrl);

    let xml: string;
    try {
      const capRes = await this.httpGetWithRetry(capUrl, config.timeoutMs, config.retries, config.retryBackoffMs);
      if (!capRes.ok) throw new Error(`HTTP ${capRes.status}`);
      xml = await capRes.text();
    } catch (err: any) {
      result.errors = 1;
      result.parseError = { url: capUrl, error: err?.message || 'fetch failed' };
      return result;
    }

    const parsed = parseCapAlert(xml);
    if (!parsed.alert) {
      result.errors = 1;
      result.parseError = { url: capUrl, error: parsed.error || 'invalid CAP alert' };
      return result;
    }

    const alert = parsed.alert;
    const alertKey = `${alert.identifier}|${alert.sent}`;
    if (seenAlertKeys.has(alertKey)) {
      result.duplicates = 1;
      return result;
    }
    seenAlertKeys.add(alertKey);

    if (alert.status !== 'Actual' || !['Alert', 'Update', 'Cancel'].includes(alert.msgType)) {
      result.skipped = 1;
      result.skippedNonTelangana = 0;
      return result;
    }

    const scope = matchAffectedAreas(alertSearchText(alert, item));
    if (config.telanganaOnly && !scope.telanganaRelevant) {
      result.skipped = 1;
      result.skippedNonTelangana = 1;
      return result;
    }

    const targets = scope.areaScope === 'DISTRICT' && scope.matchedDistrictIds.length > 0
      ? scope.matchedDistrictIds
      : ['STATE_TELANGANA'];

    for (const districtId of targets) {
      const storageKey = `${feed.sourceName}|${alert.identifier}|${alert.sent}|${districtId}`;
      if (seenStorageKeys.has(storageKey) || await this.hasStoredAlert(feed.sourceName, alert.identifier, alert.sent, districtId)) {
        result.duplicates++;
        continue;
      }
      seenStorageKeys.add(storageKey);
      try {
        await this.storeAlert(feed, alert, scope, capUrl, districtId);
        result.stored++;
      } catch (err: any) {
        result.errors++;
        result.parseError = { url: capUrl, error: `store failed: ${err?.message || err}` };
      }
    }

    return result;
  }

  public async refresh(): Promise<CapRefreshResult> {
    const config = resolveConfig();
    const feedDefinitions = buildFeedDefinitions(config);
    const states = this.createFeedStates(config);
    this.feedStates = states;

    if (this.isRefreshing) {
      return this.emptyResult();
    }
    if (!config.enabled) {
      this.health = 'OFFLINE';
      this.lastError = 'All CAP feeds disabled by configuration';
      return this.emptyResult();
    }

    this.isRefreshing = true;
    this.lastFetchAt = new Date().toISOString();
    let totalItems = 0;
    let totalRelevant = 0;
    let stored = 0;
    let duplicates = 0;
    let skipped = 0;
    let skippedNonTelangana = 0;
    let skippedInactive = 0;
    let errors = 0;
    const parseErrors: { url: string; error: string }[] = [];
    const seenCapUrls = new Set<string>();
    const seenAlertKeys = new Set<string>();
    const seenStorageKeys = new Set<string>();

    try {
      for (const feed of feedDefinitions) {
        const state = states.get(feed.key)!;
        if (!state.enabled) continue;
        state.lastFetchAt = new Date().toISOString();

        try {
          const rssRes = await this.httpGetWithRetry(feed.url, config.timeoutMs, config.retries, config.retryBackoffMs);
          if (!rssRes.ok) throw new Error(`CAP feed HTTP ${rssRes.status}`);
          const rssXml = await rssRes.text();
          const items = parseRssItems(rssXml);
          state.itemCount = items.length;
          state.latestItemAt = latestDate(items.map(i => i.pubDate));
          totalItems += items.length;

          const candidates = (feed.prefilter ? items.filter(looksTelanganaRelevant) : items)
            .slice(0, config.maxItems);
          state.relevantItemCount = candidates.length;
          totalRelevant += candidates.length;

          const results = await mapWithConcurrency(candidates, 4, item =>
            this.processItem(feed, item, config, state, seenCapUrls, seenAlertKeys, seenStorageKeys)
          );

          for (const result of results) {
            state.storedCount += result.stored;
            state.duplicateCount += result.duplicates;
            state.skippedNonTelangana += result.skippedNonTelangana;
            state.skippedInactive += result.skipped - result.skippedNonTelangana;
            state.parseErrors.push(...(result.parseError ? [result.parseError] : []));
            stored += result.stored;
            duplicates += result.duplicates;
            skipped += result.skipped;
            skippedNonTelangana += result.skippedNonTelangana;
            skippedInactive += result.skipped - result.skippedNonTelangana;
            errors += result.errors;
            if (result.parseError) parseErrors.push(result.parseError);
          }

          const latestMs = state.latestItemAt ? new Date(state.latestItemAt).getTime() : NaN;
          const feedIsStale = items.length === 0 || !Number.isFinite(latestMs)
            || (Date.now() - latestMs) > config.staleAfterHours * 3600000;
          if (state.parseErrors.length > 0) {
            state.health = 'DEGRADED';
            state.lastError = `${state.parseErrors.length} item(s) failed parsing/fetch`;
          } else if (feedIsStale) {
            state.health = 'STALE';
            state.lastError = items.length === 0
              ? 'Feed reachable but returned zero items'
              : `Feed has no item newer than ${config.staleAfterHours} hours`;
          } else {
            state.health = 'HEALTHY';
            state.lastError = null;
          }
          state.lastSuccessAt = new Date().toISOString();
        } catch (err: any) {
          state.health = 'OFFLINE';
          state.lastError = err?.message || 'CAP feed unavailable';
          errors++;
        }
      }

      const enabledStates = [...states.values()].filter(s => s.enabled);
      this.health = enabledStates.length === 0 ? 'OFFLINE' : worstHealth(enabledStates);
      const successfulStates = enabledStates.filter(s => s.lastSuccessAt);
      this.lastSuccessAt = successfulStates.length > 0
        ? latestDate(successfulStates.map(s => s.lastSuccessAt))
        : this.lastSuccessAt;
      const feedErrors = enabledStates.filter(s => s.lastError).map(s => `${s.key}: ${s.lastError}`);
      this.lastError = feedErrors.length > 0 ? feedErrors.join('; ') : null;
      this.lastItemCount = totalItems;
      this.lastRelevantItemCount = totalRelevant;
      this.lastStoredCount = stored;
      this.lastDuplicateCount = duplicates;
      this.lastSkippedNonTelangana = skippedNonTelangana;
      this.lastSkippedInactive = skippedInactive;
      this.lastParseErrors = parseErrors;

      this.syncRegistry(states);
      return {
        status: this.health,
        items: totalItems,
        relevant_items: totalRelevant,
        stored,
        duplicates,
        skipped,
        errors,
        feeds: [...states.values()].map(s => this.toFeedStatus(s)),
      };
    } finally {
      this.isRefreshing = false;
    }
  }

  private syncRegistry(states: Map<CapFeedKey, FeedRuntimeState>): void {
    const imd = states.get('IMD');
    if (imd && DATA_SOURCES.IMD_CAP_FEED) {
      DATA_SOURCES.IMD_CAP_FEED.health = mapHealthToRegistry(imd.health);
      DATA_SOURCES.IMD_CAP_FEED.lastSuccessfulUpdate = imd.lastSuccessAt;
    }
    const sachetStates = [states.get('SACHET_STATE'), states.get('SACHET_INDIA')].filter(Boolean) as FeedRuntimeState[];
    if (sachetStates.length > 0 && DATA_SOURCES.SACHET_CAP_FEED) {
      const health = worstHealth(sachetStates);
      DATA_SOURCES.SACHET_CAP_FEED.health = mapHealthToRegistry(health);
      DATA_SOURCES.SACHET_CAP_FEED.lastSuccessfulUpdate = latestDate(sachetStates.map(s => s.lastSuccessAt));
    }
  }

  private async storeAlert(
    feed: CapFeedDefinition,
    alert: CapAlert,
    scope: AreaMatch,
    capUrl: string,
    districtId: string,
  ): Promise<void> {
    const areaDesc = alert.info.areas.map(a => a.areaDesc).join('; ');
    await insertExternalSignal({
      district_id: districtId,
      source_name: feed.sourceName,
      source_type: CAP_SOURCE_TYPE,
      signal_type: 'official_alert',
      value: SEVERITY_RANK[alert.info.severity || 'Unknown'] ?? 0,
      unit: 'severity_code',
      data_mode: 'FORECAST',
      freshness: computeFreshness(alert.sent),
      confidence: 0.95,
      is_valid: 1,
      recorded_at: alert.sent,
      metadata: {
        cap_identifier: alert.identifier,
        cap_url: capUrl,
        feed_key: feed.key,
        feed_label: feed.label,
        source_feed_url: feed.url,
        publisher: feed.publisher,
        sender: alert.sender,
        sender_name: alert.info.senderName,
        sent: alert.sent,
        status: alert.status,
        msg_type: alert.msgType,
        scope: alert.scope,
        references: alert.references,
        event: alert.info.event,
        category: alert.info.category,
        urgency: alert.info.urgency,
        severity: alert.info.severity,
        certainty: alert.info.certainty,
        onset: alert.info.onset,
        effective: alert.info.effective,
        expires: alert.info.expires,
        headline: alert.info.headline,
        description: alert.info.description,
        instruction: alert.info.instruction,
        web: alert.info.web,
        area_desc: areaDesc,
        matched_district_ids: scope.matchedDistrictIds,
        area_scope: scope.areaScope,
        telangana_relevant: scope.telanganaRelevant,
        origin: feed.origin,
        data_mode: 'FORECAST',
        disclaimer: 'Official CAP warning content reproduced from the source feed. NeerDrishti does not modify, approve, or replace government warnings.',
      },
    });
  }

  private toFeedStatus(state: FeedRuntimeState): CapFeedStatus {
    return {
      key: state.key,
      label: state.label,
      publisher: state.publisher,
      url: state.url,
      enabled: state.enabled,
      health: state.health,
      item_count: state.itemCount,
      relevant_item_count: state.relevantItemCount,
      latest_item_at: state.latestItemAt,
      last_fetch_at: state.lastFetchAt,
      last_success_at: state.lastSuccessAt,
      last_error: state.lastError,
      stored_count: state.storedCount,
      duplicate_count: state.duplicateCount,
      skipped_non_telangana: state.skippedNonTelangana,
      skipped_inactive: state.skippedInactive,
      parse_error_count: state.parseErrors.length,
      parse_errors: state.parseErrors.slice(0, 10),
    };
  }

  private emptyResult(): CapRefreshResult {
    return {
      status: this.health,
      items: 0,
      relevant_items: 0,
      stored: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      feeds: [...this.feedStates.values()].map(s => this.toFeedStatus(s)),
    };
  }

  public getStatus() {
    const config = resolveConfig();
    return {
      enabled: config.enabled,
      health: this.health,
      feed_url: config.imdUrl,
      telangana_only: config.telanganaOnly,
      refresh_minutes: config.refreshMinutes,
      stale_after_hours: config.staleAfterHours,
      is_refreshing: this.isRefreshing,
      last_fetch_at: this.lastFetchAt,
      last_success_at: this.lastSuccessAt,
      last_error: this.lastError,
      last_item_count: this.lastItemCount,
      last_relevant_item_count: this.lastRelevantItemCount,
      last_stored_count: this.lastStoredCount,
      last_duplicate_count: this.lastDuplicateCount,
      last_skipped_non_telangana: this.lastSkippedNonTelangana,
      last_skipped_inactive: this.lastSkippedInactive,
      parse_errors: this.lastParseErrors.slice(0, 10),
      feeds: [...this.feedStates.values()].map(s => this.toFeedStatus(s)),
    };
  }

  public async getStoredAlerts(limit: number = 50, telanganaOnly: boolean = false, activeOnly: boolean = false): Promise<CapAlertView[]> {
    try {
      const db = getMongoDb();
      const rows = await db.collection('external_signals').find({ signal_type: 'official_alert' }).sort({ recorded_at: -1 }).limit(1000).toArray();

      const latestByAlert = new Map<string, CapAlertView>();
      for (const row of rows) {
        let meta: any = {};
        try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch { meta = {}; }
        const identifier = meta.cap_identifier || `row-${row.id}`;
        const groupKey = `${identifier}|${row.district_id}`;
        const existing = latestByAlert.get(groupKey);
        if (existing) {
          const existingTs = new Date(existing.sent).getTime();
          const incomingTs = new Date(meta.sent || row.recorded_at).getTime();
          if (Number.isFinite(existingTs) && Number.isFinite(incomingTs) && incomingTs <= existingTs) continue;
        }
        latestByAlert.set(groupKey, {
          id: row.id,
          identifier: meta.cap_identifier || '',
          sender: meta.sender || '',
          sent: meta.sent || row.recorded_at,
          msgType: meta.msg_type || 'Alert',
          status: meta.status || 'Actual',
          event: meta.event || 'Weather alert',
          headline: meta.headline || null,
          description: meta.description || null,
          instruction: meta.instruction || null,
          severity: meta.severity || null,
          urgency: meta.urgency || null,
          certainty: meta.certainty || null,
          onset: meta.onset || null,
          expires: meta.expires || null,
          web: meta.web || null,
          areaDesc: meta.area_desc || '',
          matchedDistrictIds: Array.isArray(meta.matched_district_ids) ? meta.matched_district_ids : [],
          areaScope: meta.area_scope || 'OTHER',
          telanganaRelevant: Boolean(meta.telangana_relevant),
          capUrl: meta.cap_url || null,
          feedKey: meta.feed_key || null,
          publisher: meta.publisher || null,
          sourceName: row.source_name,
          lifecycle: alertLifecycleStatus({ msgType: meta.msg_type || 'Alert', info: { expires: meta.expires || null } }),
          recorded_at: row.recorded_at,
        });
      }

      return [...latestByAlert.values()]
        .filter(v => !telanganaOnly || v.telanganaRelevant)
        .filter(v => !activeOnly || v.lifecycle === 'ACTIVE')
        .sort((a, b) => new Date(b.sent).getTime() - new Date(a.sent).getTime())
        .slice(0, Math.max(1, Math.min(200, limit)));
    } catch (err) {
      console.error('[ImdCapService] Failed to read stored alerts:', err);
      return [];
    }
  }

  public async getAlertSummary() {
    const active = await this.getStoredAlerts(500, true, true);
    const bySeverity: Record<string, number> = { Extreme: 0, Severe: 0, Moderate: 0, Minor: 0, Unknown: 0 };
    for (const alert of active) {
      const severity = alert.severity || 'Unknown';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;
    }
    return {
      active_count: active.length,
      district_count: active.filter(a => a.areaScope === 'DISTRICT').length,
      state_count: active.filter(a => a.areaScope === 'STATE').length,
      cancelled_count: (await this.getStoredAlerts(500, true, false)).filter(a => a.lifecycle === 'CANCELLED').length,
      by_severity: bySeverity,
      generated_at: new Date().toISOString(),
    };
  }

  public startScheduledRefresh(): void {
    if (!this.isEnabled()) {
      console.log('[ImdCapService] Disabled by configuration.');
      return;
    }
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.initialRefreshTimer) clearTimeout(this.initialRefreshTimer);
    const config = resolveConfig();
    console.log(`[ImdCapService] Scheduling official CAP warning refresh every ${config.refreshMinutes} minutes.`);
    this.initialRefreshTimer = setTimeout(() => {
      this.initialRefreshTimer = null;
      this.refresh().catch(e => console.error('[ImdCapService] initial refresh error:', e));
    }, 3000);
    if (typeof this.initialRefreshTimer.unref === 'function') this.initialRefreshTimer.unref();
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(e => console.error('[ImdCapService] scheduled refresh error:', e));
    }, config.refreshMinutes * 60 * 1000);
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  public stopScheduledRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.initialRefreshTimer) {
      clearTimeout(this.initialRefreshTimer);
      this.initialRefreshTimer = null;
    }
  }
}

export const imdCapService = new ImdCapService();
