import type {
  NotificationChannelConfig,
  NotificationConfig,
  NotificationDeliveryChannel,
  NotificationProvider,
  NotificationProviderMessage,
  NotificationProviderResult,
} from './types';

function dryRunResult(reason: string): NotificationProviderResult {
  return {
    status: 'DRY_RUN',
    simulated: true,
    providerMessageId: null,
    realProviderConfirmation: false,
    retryable: false,
    dryRunReason: reason,
  };
}

function liveDisabledResult(channel: NotificationDeliveryChannel): NotificationProviderResult {
  return {
    status: 'FAILED',
    simulated: false,
    providerMessageId: null,
    realProviderConfirmation: false,
    retryable: false,
    error: `${channel}_LIVE_SEND_DISABLED_IN_THIS_RELEASE`,
  };
}

class DryRunChannelProvider implements NotificationProvider {
  constructor(
    public readonly channel: NotificationDeliveryChannel,
    private readonly config: NotificationChannelConfig,
    private readonly configuredFlagName: string
  ) {}

  async send(_message: NotificationProviderMessage): Promise<NotificationProviderResult> {
    if (!this.config.dryRun) {
      return liveDisabledResult(this.channel);
    }
    return dryRunResult(this.config.configured ? `${this.channel}_DRY_RUN` : `${this.configuredFlagName}_MISSING`);
  }
}

export function createDefaultProviders(config: NotificationConfig): Record<NotificationDeliveryChannel, NotificationProvider> {
  return {
    EMAIL: new DryRunChannelProvider('EMAIL', config.email, 'SMTP_CONFIG'),
    SMS: new DryRunChannelProvider('SMS', config.sms, 'SMS_CONFIG'),
    WHATSAPP: new DryRunChannelProvider('WHATSAPP', config.whatsapp, 'WHATSAPP_CONFIG'),
  };
}
