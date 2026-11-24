import crypto from 'crypto';
import { getDb } from '../../db/mongo';
import { normalizeDistrict } from '../district_normalizer';
import { loadNotificationConfig } from './config';
import { createDefaultProviders } from './providers';
import { NotificationRateLimiter, notificationRateLimiter } from './rate_limiter';
import type {
  NotificationAlertLevel,
  NotificationCandidateResult,
  NotificationChannelConfig,
  NotificationConfig,
  NotificationDeliveryChannel,
  NotificationDeliveryStatus,
  NotificationDispatchResult,
  NotificationProvider,
  NotificationProviderMessage,
  NotificationProviderResult,
  NotificationRequest,
  NotificationSkipReason,
  NotificationSubscriberRow,
} from './types';

const ALERT_RANK: Record<NotificationAlertLevel, number> = {
  NORMAL: 0,
  WATCH: 1,
  ELEVATED: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const SUBSCRIPTION_RANK: Record<string, number> = {
  WATCH: 1,
  ELEVATED: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const ALL_CHANNELS: NotificationDeliveryChannel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

export interface NotificationDeliveryServiceOptions {
  config?: NotificationConfig;
  providers?: Partial<Record<NotificationDeliveryChannel, NotificationProvider>>;
  rateLimiter?: NotificationRateLimiter;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

function channelConfig(config: NotificationConfig, channel: NotificationDeliveryChannel): NotificationChannelConfig {
  if (channel === 'EMAIL') return config.email;
  if (channel === 'SMS') return config.sms;
  return config.whatsapp;
}

function maskDestination(channel: NotificationDeliveryChannel, destination: string): string {
  const value = String(destination || '');
  if (channel === 'EMAIL') {
    const at = value.indexOf('@');
    if (at <= 0) return '***';
    return `${value.slice(0, 1)}***${value.slice(at)}`;
  }
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

function resolveDistrictId(raw: string): string {
  const normalized = normalizeDistrict(raw);
  if (normalized.resolved && normalized.districtId) return normalized.districtId;
  return String(raw || '').trim().toLowerCase();
}

function composeBody(request: NotificationRequest, channel: NotificationDeliveryChannel, dryRun: boolean): string {
  const lines: string[] = [];
  if (dryRun) lines.push('[DRY RUN] This notification was recorded but not delivered.');
  lines.push(`${request.alertLevel} flood alert for ${request.districtName}.`);
  lines.push(request.message);
  if (request.recommendedAction) lines.push(`Recommended action: ${request.recommendedAction}`);
  if (request.signalsTriggered && request.signalsTriggered.length > 0) {
    lines.push(`Triggered signals: ${request.signalsTriggered.join('; ')}`);
  }
  if (request.source) lines.push(`Source: ${request.source}`);
  lines.push('NeerDrishti decision-support notice. Confirm with official authorities.');
  const body = lines.join('\n');
  return channel === 'SMS' ? body.slice(0, 640) : body;
}

function composeSubject(request: NotificationRequest, dryRun: boolean): string {
  return `${dryRun ? '[DRY RUN] ' : ''}${request.title}`;
}

function destinationFor(channel: NotificationDeliveryChannel, row: NotificationSubscriberRow): string | null {
  if (channel === 'EMAIL') {
    const email = String(row.email || '').trim();
    return email || null;
  }
  const phone = String(row.phone || '').trim();
  return phone || null;
}

function eligibility(row: NotificationSubscriberRow, channel: NotificationDeliveryChannel, config: NotificationConfig): {
  eligible: boolean;
  reason?: NotificationSkipReason;
  destination?: string;
} {
  if (String(row.status).toUpperCase() !== 'ACTIVE') {
    return { eligible: false, reason: 'USER_INACTIVE' };
  }
  if (row.unsubscribed_all_at) {
    return { eligible: false, reason: 'UNSUBSCRIBED' };
  }
  if (row.email_enabled === null && row.sms_enabled === null && row.whatsapp_enabled === null) {
    return { eligible: false, reason: 'NO_PREFERENCES' };
  }

  const currentChannel = channelConfig(config, channel);
  if (!currentChannel.enabled) {
    return { eligible: false, reason: 'CHANNEL_DISABLED' };
  }

  if (channel === 'EMAIL' && row.email_enabled !== 1) {
    return { eligible: false, reason: 'CHANNEL_DISABLED' };
  }
  if (channel === 'SMS' && row.sms_enabled !== 1) {
    return { eligible: false, reason: 'CHANNEL_DISABLED' };
  }
  if (channel === 'WHATSAPP' && row.whatsapp_enabled !== 1) {
    return { eligible: false, reason: 'CHANNEL_DISABLED' };
  }

  if ((channel === 'SMS' || channel === 'WHATSAPP') && !row.consent_given_at) {
    return { eligible: false, reason: 'CONSENT_REQUIRED' };
  }

  const destination = destinationFor(channel, row);
  if (!destination) {
    return { eligible: false, reason: 'MISSING_DESTINATION' };
  }

  return { eligible: true, destination };
}

export class NotificationDeliveryService {
  private readonly config: NotificationConfig;
  private readonly providers: Record<NotificationDeliveryChannel, NotificationProvider>;
  private readonly rateLimiter: NotificationRateLimiter;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: NotificationDeliveryServiceOptions = {}) {
    this.config = options.config || loadNotificationConfig();
    this.providers = {
      ...createDefaultProviders(this.config),
      ...(options.providers || {}),
    };
    this.rateLimiter = options.rateLimiter || notificationRateLimiter;
    this.now = options.now || (() => new Date());
    this.sleep = options.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  public getConfig(): NotificationConfig {
    return this.config;
  }

  public async dispatch(request: NotificationRequest): Promise<NotificationDispatchResult> {
    const districtId = resolveDistrictId(request.districtId);
    const channels = Array.from(new Set(
      (request.channels && request.channels.length > 0 ? request.channels : ALL_CHANNELS)
        .filter((channel): channel is NotificationDeliveryChannel => ALL_CHANNELS.includes(channel))
    ));
    const subscribers = await this.getSubscribers(districtId);
    const alertRank = ALERT_RANK[request.alertLevel] ?? 0;
    const results: NotificationCandidateResult[] = [];
    const summary: Record<NotificationDeliveryStatus, number> = {
      DRY_RUN: 0,
      SENT: 0,
      FAILED: 0,
      SKIPPED: 0,
      RATE_LIMITED: 0,
    };

    for (const row of subscribers) {
      const subscriptionRank = SUBSCRIPTION_RANK[String(row.min_severity || '').toUpperCase()] ?? Number.MAX_SAFE_INTEGER;
      if (alertRank < subscriptionRank) {
        continue;
      }

      for (const channel of channels) {
        const check = eligibility(row, channel, this.config);
        if (!check.eligible || !check.destination) {
          const skipped: NotificationCandidateResult = {
            userId: row.user_id,
            channel,
            status: 'SKIPPED',
            attempts: 0,
            providerMessageId: null,
            notificationId: null,
            skipReason: check.reason || 'CHANNEL_DISABLED',
          };
          results.push(skipped);
          summary.SKIPPED += 1;
          continue;
        }

        const rateKey = `notification:${row.user_id}:${channel}`;
        const rate = this.rateLimiter.check(rateKey, this.config.rateLimitPerHour, 3600 * 1000);
        if (!rate.allowed) {
           const limited = await this.persistResult(request, row, channel, check.destination, {
            status: 'RATE_LIMITED',
            attempts: 0,
            providerMessageId: null,
            error: `RATE_LIMIT_EXCEEDED_RETRY_AFTER_${rate.retryAfterSeconds}S`,
          }, districtId);
          results.push(limited);
          summary.RATE_LIMITED += 1;
          continue;
        }

        const message = this.buildMessage(request, row, channel, check.destination);
        const providerResult = await this.callProvider(this.providers[channel], message);
        const candidate = await this.persistResult(request, row, channel, check.destination, providerResult, districtId);
        results.push(candidate);
        summary[candidate.status] += 1;
      }
    }

    return {
      dryRun: this.config.masterDryRun,
      districtId,
      alertLevel: request.alertLevel,
      totalCandidates: results.length,
      results,
      summary,
    };
  }

  private async getSubscribers(districtId: string): Promise<NotificationSubscriberRow[]> {
    const db = getDb();
    const subs = await db.collection('alert_subscriptions').find({ district_id: districtId }).sort({ _id: 1 }).toArray();
    if (subs.length === 0) return [];
    const userIds = subs.map((s: any) => s.user_id);
    const users = await db.collection('users').find({ _id: { $in: userIds }, deleted_at: null }).toArray();
    const userMap = new Map(users.map((u: any) => [u._id, u]));
    const prefs = await db.collection('notification_preferences').find({ user_id: { $in: userIds } }).toArray();
    const prefMap = new Map(prefs.map((p: any) => [p.user_id, p]));
    const rows: NotificationSubscriberRow[] = [];
    for (const s of subs) {
      const u = userMap.get(s.user_id);
      if (!u) continue;
      const p = prefMap.get(s.user_id);
      rows.push({
        user_id: u._id,
        email: u.email,
        full_name: u.full_name,
        phone: u.phone,
        phone_verified: u.phone_verified,
        status: u.status,
        subscription_id: s._id,
        min_severity: s.min_severity,
        email_enabled: p?.email_enabled,
        sms_enabled: p?.sms_enabled,
        whatsapp_enabled: p?.whatsapp_enabled,
        consent_given_at: p?.consent_given_at,
        unsubscribed_all_at: p?.unsubscribed_all_at,
      } as any);
    }
    rows.sort((a: any, b: any) => (a.user_id - b.user_id) || (a.subscription_id - b.subscription_id));
    return rows;
  }

  private buildMessage(
    request: NotificationRequest,
    row: NotificationSubscriberRow,
    channel: NotificationDeliveryChannel,
    destination: string
  ): NotificationProviderMessage {
    const body = composeBody(request, channel, this.config.masterDryRun);
    return {
      channel,
      to: destination,
      subject: channel === 'EMAIL' ? composeSubject(request, this.config.masterDryRun) : undefined,
      body,
      userId: row.user_id,
      districtId: resolveDistrictId(request.districtId),
      districtName: request.districtName,
      alertLevel: request.alertLevel,
    };
  }

  private async callProvider(
    provider: NotificationProvider,
    message: NotificationProviderMessage
  ): Promise<{
    status: NotificationDeliveryStatus;
    attempts: number;
    providerMessageId: string | null;
    error?: string;
    dryRunReason?: string;
  }> {
    let attempts = 0;
    let last: NotificationProviderResult = {
      status: 'FAILED',
      simulated: false,
      providerMessageId: null,
      realProviderConfirmation: false,
      retryable: false,
      error: 'PROVIDER_NOT_INVOKED',
    };

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      attempts += 1;
      try {
        last = await provider.send(message);
      } catch (error) {
        last = {
          status: 'FAILED',
          simulated: false,
          providerMessageId: null,
          realProviderConfirmation: false,
          retryable: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (last.status !== 'FAILED') break;
      if (last.retryable === false) break;
      if (attempt < this.config.maxRetries) {
        const backoff = this.config.retryBackoffMs * Math.pow(2, attempt);
        if (backoff > 0) await this.sleep(backoff);
      }
    }

    if (last.status === 'SENT') {
      if (this.config.masterDryRun) {
        return {
          status: 'FAILED',
          attempts,
          providerMessageId: null,
          error: 'DRY_RUN_PROVIDER_RETURNED_SENT',
        };
      }
      if (!last.realProviderConfirmation || !last.providerMessageId) {
        return {
          status: 'FAILED',
          attempts,
          providerMessageId: null,
          error: 'UNCONFIRMED_PROVIDER_SUCCESS',
        };
      }
      return {
        status: 'SENT',
        attempts,
        providerMessageId: last.providerMessageId,
      };
    }

    if (last.status === 'DRY_RUN') {
      return {
        status: 'DRY_RUN',
        attempts,
        providerMessageId: null,
        dryRunReason: last.dryRunReason || 'DRY_RUN',
      };
    }

    return {
      status: 'FAILED',
      attempts,
      providerMessageId: null,
      error: last.error || 'PROVIDER_FAILURE',
    };
  }

  private async persistResult(
    request: NotificationRequest,
    row: NotificationSubscriberRow,
    channel: NotificationDeliveryChannel,
    destination: string,
    result: {
      status: NotificationDeliveryStatus;
      attempts: number;
      providerMessageId: string | null;
      error?: string;
      dryRunReason?: string;
    },
    districtId: string
  ): Promise<NotificationCandidateResult> {
    const id = `notif_${crypto.randomUUID()}`;
    const timestamp = this.now().toISOString();
    const currentChannel = channelConfig(this.config, channel);
    const subject = channel === 'EMAIL' ? composeSubject(request, this.config.masterDryRun) : request.title;
    const body = composeBody(request, channel, this.config.masterDryRun);
    const providerMessageId = result.status === 'SENT' && result.providerMessageId ? result.providerMessageId : null;
    const retryCount = Math.max(0, result.attempts - 1);
    const metadata = {
      dry_run: this.config.masterDryRun,
      simulated: result.status === 'DRY_RUN',
      provider: currentChannel.provider,
      provider_configured: currentChannel.configured,
      dry_run_reason: result.dryRunReason || null,
      recipient_masked: maskDestination(channel, destination),
      payload: {
        subject,
        body,
        recommended_action: request.recommendedAction || null,
        signals_triggered: request.signalsTriggered || [],
        source: request.source || null,
      },
      error: result.error || null,
    };

    const db = getDb();
    await db.collection('notification_history').insertOne({
      id,
      district_id: districtId,
      district_name: request.districtName,
      alert_level: request.alertLevel,
      channel,
      title: subject,
      message: body,
      recommended_action: request.recommendedAction || null,
      signals_triggered: JSON.stringify(request.signalsTriggered || []),
      status: result.status,
      recipient_group: 'Alert Subscriber',
      timestamp,
      is_prototype: 1,
      metadata: JSON.stringify(metadata),
      user_id: row.user_id,
      subscription_id: row.subscription_id,
      delivery_status: result.status,
      provider_message_id: providerMessageId,
      retry_count: retryCount,
      last_attempt_at: result.attempts > 0 ? timestamp : null,
    });

    return {
      userId: row.user_id,
      channel,
      status: result.status,
      attempts: result.attempts,
      providerMessageId,
      notificationId: id,
      error: result.error,
      dryRunReason: result.dryRunReason,
    };
  }
}
