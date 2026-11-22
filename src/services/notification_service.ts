import { getDb } from '../db/mongo';
import { DistrictAlert } from '../types/alerts';

export type NotificationChannel = 
  | 'In-App Decision Support'
  | 'Browser Push'
  | 'SMS Mock Gateway'
  | 'WhatsApp Mock Dispatch'
  | 'Email Digest'
  | 'Email'
  | 'SMS'
  | 'WhatsApp';

export interface DecisionSupportNotification {
  id: string;
  districtId: string;
  districtName: string;
  alertLevel: 'NORMAL' | 'ADVISORY' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
  channel: NotificationChannel;
  title: string;
  message: string;
  recommendedAction: string;
  signalsTriggered: string[];
  status: 'DRY_RUN' | 'SENT' | 'FAILED' | 'SKIPPED' | 'RATE_LIMITED' | 'Delivered' | 'Dispatched (Prototype)' | 'Simulated Queue';
  recipientGroup: 'State Disaster Control Room' | 'District Collectorate' | 'Municipal Emergency Cells' | 'Field Responders' | 'Public Safety Broadcast' | 'Alert Subscriber';
  timestamp: string;
  isPrototype: boolean;
  userId?: number | null;
  subscriptionId?: number | null;
  deliveryStatus?: string | null;
  providerMessageId?: string | null;
  retryCount?: number;
  lastAttemptAt?: string | null;
  metadata?: Record<string, any>;
}

class NotificationService {
  private inMemoryLedger: DecisionSupportNotification[] = [];

  /**
   * Dispatches a prototype decision support notification
   */
  public async dispatchNotification(params: {
    districtId: string;
    districtName: string;
    alertLevel: 'NORMAL' | 'ADVISORY' | 'WATCH' | 'WARNING' | 'EMERGENCY';
    channel?: NotificationChannel;
    title: string;
    message: string;
    recommendedAction?: string;
    signalsTriggered?: string[];
    recipientGroup?: DecisionSupportNotification['recipientGroup'];
    metadata?: Record<string, any>;
  }): Promise<DecisionSupportNotification> {
    const id = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const channel = params.channel || 'In-App Decision Support';
    const timestamp = new Date().toISOString();
    const recipientGroup = params.recipientGroup || (
      params.alertLevel === 'EMERGENCY' || params.alertLevel === 'WARNING'
        ? 'State Disaster Control Room'
        : 'District Collectorate'
    );

    const notif: DecisionSupportNotification = {
      id,
      districtId: params.districtId,
      districtName: params.districtName,
      alertLevel: params.alertLevel,
      channel,
      title: params.title,
      message: params.message,
      recommendedAction: params.recommendedAction || 'Monitor hydro-meteorological stations and maintain field liaison.',
      signalsTriggered: params.signalsTriggered || ['Model Deterministic Threshold'],
      status: 'DRY_RUN',
      recipientGroup,
      timestamp,
      isPrototype: true,
      metadata: params.metadata,
    };

    // Store in memory
    this.inMemoryLedger.unshift(notif);
    if (this.inMemoryLedger.length > 200) {
      this.inMemoryLedger.pop();
    }

    // Persist to MongoDB
    try {
      const db = getDb();
      await db.collection('notification_history').insertOne({
        id: notif.id,
        district_id: notif.districtId,
        district_name: notif.districtName,
        alert_level: notif.alertLevel,
        channel: notif.channel,
        title: notif.title,
        message: notif.message,
        recommended_action: notif.recommendedAction,
        signals_triggered: JSON.stringify(notif.signalsTriggered),
        status: notif.status,
        recipient_group: notif.recipientGroup,
        timestamp: notif.timestamp,
        is_prototype: 1,
        metadata: JSON.stringify(notif.metadata || {}),
      });
    } catch (err) {
      console.warn('[NotificationService] Failed persisting notification to MongoDB:', err);
    }

    return notif;
  }

  /**
   * Generates prototype notification broadcast for an evaluated district alert
   */
  public async dispatchAlertBroadcast(alert: DistrictAlert): Promise<DecisionSupportNotification[]> {
    const notifications: DecisionSupportNotification[] = [];
    const triggerNames = (alert.trigger_signals || []).map(t => t.description || t.signal_type);

    const level = alert.alert_level === 'CRITICAL' ? 'EMERGENCY' : alert.alert_level === 'HIGH' ? 'WARNING' : alert.alert_level === 'ELEVATED' ? 'WATCH' : alert.alert_level === 'WATCH' ? 'ADVISORY' : 'NORMAL';

    // 1. In-App Control Room Notification
    const inApp = await this.dispatchNotification({
      districtId: alert.district_id,
      districtName: alert.district_name,
      alertLevel: level,
      channel: 'In-App Decision Support',
      title: `[${alert.alert_level}] Flood Alert: ${alert.district_name}`,
      message: alert.headline || `${alert.district_name} reached ${alert.alert_level} status with score ${alert.current_risk}/100.`,
      recommendedAction: alert.trigger_reasons?.[0] || 'Deploy field inspection team and monitor gauge networks.',
      signalsTriggered: triggerNames,
      recipientGroup: level === 'EMERGENCY' ? 'State Disaster Control Room' : 'District Collectorate',
    });
    notifications.push(inApp);

    // 2. High severity mock multi-channel dispatch (SMS / Push)
    if (alert.alert_level === 'HIGH' || alert.alert_level === 'CRITICAL') {
       const sms = await this.dispatchNotification({
        districtId: alert.district_id,
        districtName: alert.district_name,
        alertLevel: level,
        channel: 'SMS Mock Gateway',
        title: `CRITICAL ALERT: ${alert.district_name}`,
        message: `EMERGENCY ALERT: High risk flood escalation detected in ${alert.district_name}. Projected Peak: ${alert.projected_risk}/100 at ${alert.peak_horizon}.`,
        recommendedAction: 'Immediate coordination with SDRF/Municipal local emergency stations.',
        signalsTriggered: triggerNames,
        recipientGroup: 'Municipal Emergency Cells',
      });
      notifications.push(sms);
    }

    return notifications;
  }

  /**
   * Retrieves notification ledger history
   */
  public async getHistory(limit: number = 50, districtId?: string): Promise<DecisionSupportNotification[]> {
    try {
      const db = getDb();
      const filter: any = {};
      if (districtId) filter.$or = [{ district_id: districtId }, { district_name: districtId }];
      const rows = await db.collection('notification_history').find(filter, { sort: { timestamp: -1 }, limit }).toArray();
      if (rows && rows.length > 0) {
        return rows.map(r => ({
            id: r.id,
            districtId: r.district_id,
            districtName: r.district_name,
            alertLevel: r.alert_level as any,
            channel: r.channel as any,
            title: r.title,
            message: r.message,
            recommendedAction: r.recommended_action,
            signalsTriggered: r.signals_triggered ? JSON.parse(r.signals_triggered) : [],
            status: r.status as any,
            recipientGroup: r.recipient_group as any,
            timestamp: r.timestamp,
            isPrototype: Boolean(r.is_prototype),
            userId: r.user_id ?? null,
            subscriptionId: r.subscription_id ?? null,
            deliveryStatus: r.delivery_status ?? null,
            providerMessageId: r.provider_message_id ?? null,
            retryCount: Number(r.retry_count || 0),
            lastAttemptAt: r.last_attempt_at ?? null,
            metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
          }));
      }
    } catch (err) {
      console.warn('[NotificationService] Error querying MongoDB history, using memory:', err);
    }

    if (districtId) {
      return this.inMemoryLedger.filter(n => n.districtId === districtId || n.districtName === districtId).slice(0, limit);
    }
    return this.inMemoryLedger.slice(0, limit);
  }

  /**
   * Get notification stats
   */
  public async getStats() {
    const history = await this.getHistory(200);
    const byChannel: Record<string, number> = {};
    const byLevel: Record<string, number> = {};

    for (const notif of history) {
      byChannel[notif.channel] = (byChannel[notif.channel] || 0) + 1;
      byLevel[notif.alertLevel] = (byLevel[notif.alertLevel] || 0) + 1;
    }

    return {
      totalDispatched: history.length,
      byChannel,
      byLevel,
      lastDispatchedAt: history[0]?.timestamp || null,
    };
  }
}

export const notificationService = new NotificationService();
