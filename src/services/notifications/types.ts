export type NotificationDeliveryChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';

export type NotificationAlertLevel = 'NORMAL' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

export type NotificationDeliveryStatus = 'DRY_RUN' | 'SENT' | 'FAILED' | 'SKIPPED' | 'RATE_LIMITED';

export type NotificationSkipReason =
  | 'UNSUBSCRIBED'
  | 'NO_PREFERENCES'
  | 'CHANNEL_DISABLED'
  | 'CONSENT_REQUIRED'
  | 'MISSING_DESTINATION'
  | 'USER_INACTIVE'
  | 'BELOW_SUBSCRIPTION_SEVERITY';

export interface NotificationRequest {
  districtId: string;
  districtName: string;
  alertLevel: NotificationAlertLevel;
  title: string;
  message: string;
  recommendedAction?: string;
  signalsTriggered?: string[];
  source?: string;
  channels?: NotificationDeliveryChannel[];
}

export interface NotificationChannelConfig {
  enabled: boolean;
  dryRun: boolean;
  configured: boolean;
  provider: string;
}

export interface NotificationConfig {
  masterDryRun: boolean;
  liveSendEnabled: boolean;
  maxRetries: number;
  retryBackoffMs: number;
  rateLimitPerHour: number;
  email: NotificationChannelConfig & {
    from: string;
    host: string;
  };
  sms: NotificationChannelConfig;
  whatsapp: NotificationChannelConfig;
}

export interface NotificationProviderMessage {
  channel: NotificationDeliveryChannel;
  to: string;
  subject?: string;
  body: string;
  userId: number;
  districtId: string;
  districtName: string;
  alertLevel: NotificationAlertLevel;
}

export interface NotificationProviderResult {
  status: 'DRY_RUN' | 'SENT' | 'FAILED';
  simulated: boolean;
  providerMessageId: string | null;
  realProviderConfirmation: boolean;
  retryable?: boolean;
  error?: string;
  dryRunReason?: string;
}

export interface NotificationProvider {
  readonly channel: NotificationDeliveryChannel;
  send(message: NotificationProviderMessage): Promise<NotificationProviderResult>;
}

export interface NotificationCandidateResult {
  userId: number;
  channel: NotificationDeliveryChannel;
  status: NotificationDeliveryStatus;
  attempts: number;
  providerMessageId: string | null;
  notificationId: string | null;
  skipReason?: NotificationSkipReason;
  error?: string;
  dryRunReason?: string;
}

export interface NotificationDispatchResult {
  dryRun: boolean;
  districtId: string;
  alertLevel: NotificationAlertLevel;
  totalCandidates: number;
  results: NotificationCandidateResult[];
  summary: Record<NotificationDeliveryStatus, number>;
}

export interface NotificationSubscriberRow {
  user_id: number;
  email: string;
  full_name: string;
  phone: string | null;
  phone_verified: number;
  status: string;
  subscription_id: number;
  min_severity: string;
  email_enabled: number | null;
  sms_enabled: number | null;
  whatsapp_enabled: number | null;
  consent_given_at: string | null;
  unsubscribed_all_at: string | null;
}
