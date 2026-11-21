import nodemailer from 'nodemailer';
import { parseBooleanValue } from '../../config/security';
import type { TransactionalEmail } from './templates';

const LIVE_SEND_IMPLEMENTED = false;
const SMTP_TIMEOUT_MS = 10000;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface MailTransportMessage extends TransactionalEmail {
  from: string;
}

export interface MailTransportInfo {
  messageId?: string;
}

export interface MailTransport {
  verify(): Promise<void>;
  sendMail(message: MailTransportMessage): Promise<MailTransportInfo>;
  close?(): void;
}

export type SmtpTransportFactory = (config: SmtpConfig) => MailTransport;

export interface MailDependencies {
  env?: NodeJS.ProcessEnv;
  transportFactory?: SmtpTransportFactory;
}

export interface MailSendResult {
  status: 'DRY_RUN' | 'SENT' | 'FAILED';
  dryRun: boolean;
  dryRunReason?: string;
  providerMessageId?: string | null;
  error?: 'SMTP_DELIVERY_FAILED';
}

export interface SmtpVerificationResult {
  ok: boolean;
  status: 'DRY_RUN' | 'VERIFIED' | 'NOT_CONFIGURED' | 'FAILED';
  dryRunReason?: string;
  error?: 'SMTP_VERIFY_FAILED';
}

export type MailActionTokenKind = 'verify_email' | 'reset_password';

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('APP_BASE_URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new Error('APP_BASE_URL must not contain embedded credentials.');
  }
  return raw.replace(/\/+$/, '');
}

export function getAppBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = hasValue(env.APP_BASE_URL)
    ? String(env.APP_BASE_URL).trim()
    : `http://localhost:${hasValue(env.PORT) ? String(env.PORT).trim() : '3000'}`;
  return normalizeBaseUrl(raw);
}

export function buildMailActionUrl(kind: MailActionTokenKind, token: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(`${getAppBaseUrl(env)}/`);
  url.searchParams.set(kind, token);
  return url.toString();
}

export function isMailDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanValue(env.MAIL_DRY_RUN) ?? true;
}

export function isLiveSendImplemented(): boolean {
  return LIVE_SEND_IMPLEMENTED;
}

export function getSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = String(env.SMTP_HOST || '').trim();
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '').trim();
  const from = String(env.MAIL_FROM || '').trim();
  if (!host || host.includes('://') || /\s/.test(host) || !user || !pass || !from) {
    return null;
  }

  const portRaw = env.SMTP_PORT === undefined || String(env.SMTP_PORT).trim() === '' ? '587' : String(env.SMTP_PORT).trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const secure = parseBooleanValue(env.SMTP_SECURE) ?? port === 465;
  return { host, port, secure, user, pass, from };
}

export function isSmtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getSmtpConfig(env) !== null;
}

function dryRunResult(reason: string): MailSendResult {
  return { status: 'DRY_RUN', dryRun: true, dryRunReason: reason, providerMessageId: null };
}

export function createSmtpTransport(config: SmtpConfig): MailTransport {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    pool: false,
  });
  return transport as unknown as MailTransport;
}

export async function deliverWithTransport(
  config: SmtpConfig,
  message: Omit<TransactionalEmail, 'to'> & { to: string },
  factory: SmtpTransportFactory = createSmtpTransport
): Promise<MailSendResult> {
  const transport = factory(config);
  try {
    const info = await transport.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return {
      status: 'SENT',
      dryRun: false,
      providerMessageId: info?.messageId ? String(info.messageId).slice(0, 200) : null,
    };
  } catch {
    return {
      status: 'FAILED',
      dryRun: false,
      providerMessageId: null,
      error: 'SMTP_DELIVERY_FAILED',
    };
  } finally {
    try {
      transport.close?.();
    } catch {
      // Closing must not leak transport errors into auth responses.
    }
  }
}

export async function verifyWithTransport(
  config: SmtpConfig,
  factory: SmtpTransportFactory = createSmtpTransport
): Promise<SmtpVerificationResult> {
  const transport = factory(config);
  try {
    await transport.verify();
    return { ok: true, status: 'VERIFIED' };
  } catch {
    return { ok: false, status: 'FAILED', error: 'SMTP_VERIFY_FAILED' };
  } finally {
    try {
      transport.close?.();
    } catch {
      // The transport is already discarded; closing must never expose credentials.
    }
  }
}

export async function verifySmtpConnection(options: MailDependencies = {}): Promise<SmtpVerificationResult> {
  const env = options.env || process.env;
  if (isMailDryRun(env)) {
    return { ok: false, status: 'DRY_RUN', dryRunReason: 'MAIL_DRY_RUN' };
  }
  if (!LIVE_SEND_IMPLEMENTED) {
    return { ok: false, status: 'DRY_RUN', dryRunReason: 'LIVE_SEND_DISABLED_IN_THIS_RELEASE' };
  }
  const config = getSmtpConfig(env);
  if (!config) {
    return { ok: false, status: 'NOT_CONFIGURED', dryRunReason: 'SMTP_NOT_CONFIGURED' };
  }

  return verifyWithTransport(config, options.transportFactory || createSmtpTransport);
}

export async function sendTransactionalEmail(
  message: Omit<TransactionalEmail, 'to'> & { to: string },
  options: MailDependencies = {}
): Promise<MailSendResult> {
  const env = options.env || process.env;
  if (isMailDryRun(env)) {
    return dryRunResult('MAIL_DRY_RUN');
  }
  if (!LIVE_SEND_IMPLEMENTED) {
    return dryRunResult('LIVE_SEND_DISABLED_IN_THIS_RELEASE');
  }

  const config = getSmtpConfig(env);
  if (!config) {
    return dryRunResult('SMTP_NOT_CONFIGURED');
  }

  return deliverWithTransport(config, message, options.transportFactory || createSmtpTransport);
}
