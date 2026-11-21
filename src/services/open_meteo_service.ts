import { DistrictMetadata } from '../types';
import { rainfallService } from './rainfall_service';
import { DATA_SOURCES } from '../config/data_sources';
import { getDb } from '../db/sqlite';

const OPEN_METEO_BASE_URL = (process.env.OPEN_METEO_BASE_URL || 'https://api.open-meteo.com').replace(/\/$/, '');
const OPEN_METEO_ARCHIVE_URL = (process.env.OPEN_METEO_ARCHIVE_URL || 'https://archive-api.open-meteo.com').replace(/\/$/, '');
const OPEN_METEO_TIMEOUT_MS = Number(process.env.OPEN_METEO_TIMEOUT_MS) || 8000;
const OPEN_METEO_RETRIES = Math.max(0, Number(process.env.OPEN_METEO_RETRIES ?? 2));
const OPEN_METEO_CACHE_TTL_MS = Number(process.env.OPEN_METEO_CACHE_TTL_MS) || 5 * 60 * 1000;
const DUPLICATE_SUPPRESSION_WINDOW_MS = Number(process.env.DUPLICATE_SUPPRESSION_WINDOW_MS) || 20 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  value: LiveRainfallResult;
}

export interface OpenMeteoHourlyResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  elevation: number;
  hourly_units: {
    time: string;
    precipitation: string;
  };
  hourly: {
    time: string[];
    precipitation: number[];
  };
}

export interface LiveRainfallResult {
  success: boolean;
  district_id: string;
  district_name: string;
  rainfall_mm_24h?: number;
  rainfall_mm_3h?: number;
  recorded_at?: string;
  source_name?: string;
  data_mode?: 'LIVE' | 'HISTORICAL' | 'SIMULATED';
  deduplicated?: boolean;
  from_cache?: boolean;
  error?: string;
}

export class OpenMeteoService {
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing: boolean = false;
  private lastRefreshTime: string | null = null;
  private lastSuccessCount: number = 0;
  private lastFailCount: number = 0;
  private lastErrors: Record<string, string> = {};
  private cache: Map<string, CacheEntry> = new Map();
  private lastRateLimitedAt: string | null = null;

  /**
   * Bounded retry with backoff + jitter. Retries network errors, timeouts, HTTP 429
   * and 5xx. Does NOT retry other 4xx (client errors are permanent).
   */
  private async fetchWithRetry(
    url: string,
    headers?: Record<string, string>
  ): Promise<Response> {
    const attempts = OPEN_METEO_RETRIES + 1;
    let lastError: any = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OPEN_METEO_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'NeerDrishti-Flood-Intelligence/1.0',
            ...headers,
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.status !== 429 && response.status < 500) {
          return response;
        }

        // Retryable: 429 or 5xx
        if (response.status === 429) {
          this.lastRateLimitedAt = new Date().toISOString();
          console.warn(`[OpenMeteoService] HTTP 429 (attempt ${attempt}/${attempts}) — backing off.`);
        } else {
          console.warn(`[OpenMeteoService] HTTP ${response.status} (attempt ${attempt}/${attempts}) — retrying.`);
        }
        lastError = new Error(`Open-Meteo HTTP ${response.status}: ${response.statusText}`);
      } catch (err: any) {
        clearTimeout(timeoutId);
        lastError = err;
        console.warn(`[OpenMeteoService] Request error (attempt ${attempt}/${attempts}):`, err?.message || err);
      }

      if (attempt < attempts) {
        const backoffMs = Math.min(4000, 250 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100));
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }

    throw lastError || new Error('Open-Meteo request failed after retries');
  }

  private getRecentLiveSignalForDistrict(districtId: string, sourceName: string): any | null {
    try {
      const db = getDb();
      const row = db.prepare(`
        SELECT * FROM external_signals
        WHERE district_id = ? AND source_name = ? AND signal_type = 'rainfall'
          AND data_mode = 'LIVE' AND is_valid = 1
        ORDER BY recorded_at DESC
        LIMIT 1
      `).get(districtId, sourceName);
      return row || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches real-time precipitation forecast/observation from Open-Meteo keyless API.
   * Computes 24-hour total and 3-hour precipitation burst for the district coordinates.
   */
  public async fetchLiveRainfallForDistrict(
    district: { district_id: string; district_name: string; latitude: number; longitude: number }
  ): Promise<LiveRainfallResult> {
    const { district_id, district_name, latitude, longitude } = district;
    const sourceName = DATA_SOURCES.OPEN_METEO_TELEMETRY.sourceName;

    // Cache layer: identical coordinates requested within the TTL reuse the last result.
    const cacheKey = `${district_id}:${latitude.toFixed(4)}:${longitude.toFixed(4)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, from_cache: true } as LiveRainfallResult & { from_cache?: boolean };
    }

    // Duplicate suppression across refreshes (and restarts): skip ingest when a fresh
    // Open-Meteo LIVE signal already exists for this district within the suppression window.
    const recentLive = this.getRecentLiveSignalForDistrict(district_id, sourceName);
    if (recentLive) {
      const ageMs = Date.now() - new Date(String(recentLive.recorded_at)).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < DUPLICATE_SUPPRESSION_WINDOW_MS) {
        const deduped: LiveRainfallResult = {
          success: true,
          district_id,
          district_name,
          rainfall_mm_24h: Number(recentLive.value),
          data_mode: 'LIVE',
          recorded_at: String(recentLive.recorded_at),
          source_name: sourceName,
        };
        this.cache.set(cacheKey, { expiresAt: Date.now() + OPEN_METEO_CACHE_TTL_MS, value: deduped });
        return { ...deduped, deduplicated: true } as LiveRainfallResult & { deduplicated?: boolean };
      }
    }

    const url = `${OPEN_METEO_BASE_URL}/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=precipitation&timezone=Asia%2FKolkata`;

    try {
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        throw new Error(`Open-Meteo HTTP ${response.status}: ${response.statusText}`);
      }

      const data: OpenMeteoHourlyResponse = await response.json();
      if (!data.hourly || !Array.isArray(data.hourly.time) || !Array.isArray(data.hourly.precipitation)) {
        throw new Error('Invalid Open-Meteo payload: hourly precipitation series missing');
      }

      const times = data.hourly.time;
      const precips = data.hourly.precipitation;

      if (times.length === 0 || precips.length === 0) {
        throw new Error('Empty precipitation series received from Open-Meteo');
      }

      // Determine current index based on IST current hour or latest available before/at now
      const now = new Date();
      // Format current hour in IST for matching "YYYY-MM-DDTHH:00"
      const istFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
      });

      const parts = istFormatter.formatToParts(now);
      const year = parts.find(p => p.type === 'year')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const day = parts.find(p => p.type === 'day')?.value;
      let hour = parts.find(p => p.type === 'hour')?.value || '00';
      if (hour === '24') hour = '00';

      const currentHourStr = `${year}-${month}-${day}T${hour}:00`;

      let currentIndex = times.findIndex(t => t.startsWith(currentHourStr));
      if (currentIndex === -1) {
        // Find closest timestamp before or equal to now
        const nowMs = now.getTime();
        let closestDiff = Infinity;
        currentIndex = 0;
        for (let i = 0; i < times.length; i++) {
          const tMs = new Date(times[i] + '+05:30').getTime();
          const diff = Math.abs(nowMs - tMs);
          if (diff < closestDiff) {
            closestDiff = diff;
            currentIndex = i;
          }
        }
      }

      // Calculate 24-hour rainfall (sum of last 24 available hours up to current index)
      const start24hIdx = Math.max(0, currentIndex - 23);
      let sum24h = 0;
      for (let i = start24hIdx; i <= currentIndex; i++) {
        const val = precips[i];
        if (typeof val === 'number' && !isNaN(val) && val >= 0) {
          sum24h += val;
        }
      }

      // Calculate 3-hour burst (sum of last 3 available hours up to current index)
      const start3hIdx = Math.max(0, currentIndex - 2);
      let sum3h = 0;
      for (let i = start3hIdx; i <= currentIndex; i++) {
        const val = precips[i];
        if (typeof val === 'number' && !isNaN(val) && val >= 0) {
          sum3h += val;
        }
      }

      const rainfall_mm_24h = Math.round(sum24h * 10) / 10;
      const rainfall_mm_3h = Math.round(sum3h * 10) / 10;
      const recorded_at = new Date().toISOString();
      const retrieved_at = new Date().toISOString();
      const source_name = sourceName;

      // Ingest into central deterministic signal pipeline (LIVE signal).
      // Preserve observation + retrieval timestamps; freshness computed at read time.
      const ingestRes = rainfallService.ingestObservation({
        rawDistrict: district_name,
        rainfall_mm: rainfall_mm_24h,
        burst_3h_mm: rainfall_mm_3h,
        unit: 'mm',
        sourceName: source_name,
        sourceType: 'weather_service',
        dataMode: 'LIVE',
        timestamp: recorded_at,
        metadata: {
          latitude,
          longitude,
          elevation: data.elevation,
          provider: 'open-meteo',
          matched_time: times[currentIndex],
          precipitation_units: data.hourly_units.precipitation,
          retrieved_at,
          observation_time: times[currentIndex],
        },
      });

      if (!ingestRes.success) {
        // Duplicate at the validator level is not a hard failure; surface honestly.
        if (/Duplicate/i.test(ingestRes.error || '')) {
          const deduped: LiveRainfallResult = {
            success: true,
            district_id,
            district_name,
            rainfall_mm_24h,
            rainfall_mm_3h,
            recorded_at,
            source_name,
            data_mode: 'LIVE',
          };
          this.cache.set(cacheKey, { expiresAt: Date.now() + OPEN_METEO_CACHE_TTL_MS, value: deduped });
          return { ...deduped, deduplicated: true } as LiveRainfallResult & { deduplicated?: boolean };
        }
        throw new Error(ingestRes.error || 'Signal ingestion pipeline failed');
      }

      const result: LiveRainfallResult = {
        success: true,
        district_id,
        district_name,
        rainfall_mm_24h,
        rainfall_mm_3h,
        recorded_at,
        source_name,
        data_mode: 'LIVE',
      };
      this.cache.set(cacheKey, { expiresAt: Date.now() + OPEN_METEO_CACHE_TTL_MS, value: result });
      return result;
    } catch (err: any) {
      return {
        success: false,
        district_id,
        district_name,
        error: err?.message || 'Failed to fetch Open-Meteo live rainfall',
      };
    }
  }

  /**
   * Fetches historical rainfall baseline from Open-Meteo Archive API.
   */
  public async fetchHistoricalBaselineForDistrict(
    district: { district_id: string; district_name: string; latitude: number; longitude: number },
    startDate: string,
    endDate: string
  ): Promise<{ success: boolean; total_mm?: number; average_daily_mm?: number; peak_daily_mm?: number; error?: string }> {
    const { district_name, latitude, longitude } = district;
    const url = `${OPEN_METEO_ARCHIVE_URL}/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=${startDate}&end_date=${endDate}&hourly=precipitation&timezone=Asia%2FKolkata`;

    try {
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        throw new Error(`Open-Meteo Archive HTTP ${response.status}: ${response.statusText}`);
      }

      const data: OpenMeteoHourlyResponse = await response.json();
      if (!data.hourly || !Array.isArray(data.hourly.precipitation)) {
        throw new Error('Invalid archive payload: precipitation missing');
      }

      let total = 0;
      let peakHour = 0;
      for (const val of data.hourly.precipitation) {
        if (typeof val === 'number' && !isNaN(val) && val >= 0) {
          total += val;
          if (val > peakHour) peakHour = val;
        }
      }

      const daysCount = Math.max(1, data.hourly.precipitation.length / 24);
      const averageDaily = total / daysCount;

      // Ingest as HISTORICAL signal baseline
      rainfallService.ingestObservation({
        rawDistrict: district_name,
        rainfall_mm: Math.round(averageDaily * 10) / 10,
        burst_3h_mm: Math.round(peakHour * 10) / 10,
        unit: 'mm',
        sourceName: DATA_SOURCES.TELANGANA_HISTORICAL_BASELINE.sourceName,
        sourceType: 'historical_archive',
        dataMode: 'HISTORICAL',
        timestamp: new Date().toISOString(),
        metadata: {
          startDate,
          endDate,
          archive_provider: 'open-meteo-archive',
        },
      });

      return {
        success: true,
        total_mm: Math.round(total * 10) / 10,
        average_daily_mm: Math.round(averageDaily * 10) / 10,
        peak_daily_mm: Math.round(peakHour * 10) / 10,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Failed to fetch Open-Meteo archive data',
      };
    }
  }

  /**
   * Refreshes all 33 Telangana districts in controlled batches (e.g. 5 concurrent requests).
   * Feeds results directly into the deterministic signal ingestion pipeline.
   */
  public async refreshAllDistricts(
    districts: DistrictMetadata[]
  ): Promise<{ total: number; success_count: number; fail_count: number; errors: Record<string, string> }> {
    if (this.isRefreshing) {
      return {
        total: districts.length,
        success_count: this.lastSuccessCount,
        fail_count: this.lastFailCount,
        errors: { system: 'Refresh operation already in progress' },
      };
    }

    this.isRefreshing = true;
    let successCount = 0;
    let failCount = 0;
    const errors: Record<string, string> = {};

    try {
      // Process in batches of 5 to remain polite to the Open-Meteo free tier
      const batchSize = 5;
      for (let i = 0; i < districts.length; i += batchSize) {
        const batch = districts.slice(i, i + batchSize);
        const promises = batch.map(d => this.fetchLiveRainfallForDistrict(d));
        const results = await Promise.all(promises);

        let batchRateLimited = 0;
        for (const res of results) {
          if (res.success) {
            successCount++;
          } else {
            failCount++;
            errors[res.district_name] = res.error || 'Unknown error';
            if (/429/.test(res.error || '')) batchRateLimited++;
          }
        }

        // Rate-limit awareness: if most of a batch was throttled, stop early and retry next cycle
        if (batchRateLimited >= Math.ceil(batch.length / 2) && batchRateLimited > 0) {
          console.warn(`[OpenMeteoService] Batch ${Math.floor(i / batchSize) + 1} heavily rate limited (${batchRateLimited}/${batch.length}). Stopping refresh early to protect the free tier quota; retrying on next scheduled cycle.`);
          // Record the unprocessed districts as failed for honest reporting
          for (const remaining of districts.slice(i + batchSize)) {
            failCount++;
            errors[remaining.district_name] = 'Not fetched: provider rate limit reached earlier in this cycle';
          }
          break;
        }

        if (i + batchSize < districts.length) {
          await new Promise(r => setTimeout(r, 150));
        }
      }

      this.lastRefreshTime = new Date().toISOString();
      this.lastSuccessCount = successCount;
      this.lastFailCount = failCount;
      this.lastErrors = errors;

      // Update DATA_SOURCES config state — never advertise a source as healthy when it delivered nothing.
      if (successCount > 0 && successCount === districts.length) {
        DATA_SOURCES.OPEN_METEO_TELEMETRY.health = 'HEALTHY';
        DATA_SOURCES.OPEN_METEO_TELEMETRY.lastSuccessfulUpdate = this.lastRefreshTime;
        DATA_SOURCES.OPEN_METEO_TELEMETRY.currentMode = 'LIVE';
      } else if (successCount > 0) {
        DATA_SOURCES.OPEN_METEO_TELEMETRY.health = 'DEGRADED';
        DATA_SOURCES.OPEN_METEO_TELEMETRY.lastSuccessfulUpdate = this.lastRefreshTime;
        DATA_SOURCES.OPEN_METEO_TELEMETRY.currentMode = 'LIVE';
      } else {
        DATA_SOURCES.OPEN_METEO_TELEMETRY.health = 'DOWN';
        DATA_SOURCES.OPEN_METEO_TELEMETRY.currentMode = 'UNAVAILABLE';
      }

      if (failCount > 0) {
        console.warn(`[OpenMeteoService] Ingested live rainfall telemetry: ${successCount} succeeded, ${failCount} incomplete.`);
      } else {
        console.log(`[OpenMeteoService] Ingested live rainfall telemetry: all ${successCount} districts updated successfully.`);
      }
    } catch (err: any) {
      console.error('[OpenMeteoService] Fatal error during district refresh:', err);
      DATA_SOURCES.OPEN_METEO_TELEMETRY.health = 'DEGRADED';
    } finally {
      this.isRefreshing = false;
    }

    return {
      total: districts.length,
      success_count: successCount,
      fail_count: failCount,
      errors,
    };
  }

  /**
   * Starts periodic background refresh loop according to DATA_SOURCES.refreshIntervalMinutes.
   */
  public startScheduledRefresh(districts: DistrictMetadata[]) {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    const intervalMinutes = DATA_SOURCES.OPEN_METEO_TELEMETRY.refreshIntervalMinutes || 30;
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[OpenMeteoService] Scheduling live Open-Meteo telemetry refresh every ${intervalMinutes} minutes.`);

    // Run initial live ingest immediately in background
    setTimeout(() => {
      this.refreshAllDistricts(districts).catch(e => console.error('[OpenMeteoService] Initial refresh error:', e));
    }, 1000);

    // Set recurring timer
    this.refreshTimer = setInterval(() => {
      this.refreshAllDistricts(districts).catch(e => console.error('[OpenMeteoService] Scheduled refresh error:', e));
    }, intervalMs);
  }

  public stopScheduledRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  public getStatus() {
    return {
      is_refreshing: this.isRefreshing,
      last_refresh_time: this.lastRefreshTime,
      last_success_count: this.lastSuccessCount,
      last_fail_count: this.lastFailCount,
      last_errors: this.lastErrors,
      last_rate_limited_at: this.lastRateLimitedAt,
      refresh_interval_minutes: DATA_SOURCES.OPEN_METEO_TELEMETRY.refreshIntervalMinutes,
      cache_entries: this.cache.size,
      source_metadata: DATA_SOURCES.OPEN_METEO_TELEMETRY,
    };
  }
}

export const openMeteoService = new OpenMeteoService();
