import dotenv from 'dotenv';
import {
  deliverWithTransport,
  getSmtpConfig,
  verifyWithTransport,
} from '../src/services/email/mail_service';

dotenv.config();

const TEST_CONFIRMATION = 'SEND_ONE_TEST_EMAIL';
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function safeExit(code: number, payload: Record<string, unknown>): never {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

const verifyOnly = hasFlag('--verify-only');
const sendOne = hasFlag('--send-one');

if (Number(verifyOnly) + Number(sendOne) !== 1) {
  safeExit(2, {
    status: 'usage',
    message: 'Choose exactly one mode: --verify-only or --send-one.',
  });
}

const recipient = String(process.env.MAIL_TEST_RECIPIENT || '').trim().toLowerCase();
const confirmation = String(process.env.MAIL_TEST_CONFIRM || '').trim();
const recipientArg = String(argValue('--recipient') || '').trim().toLowerCase();

if (!recipient || !SIMPLE_EMAIL.test(recipient) || recipient.length > 254) {
  safeExit(2, {
    status: 'invalid_recipient',
    message: 'MAIL_TEST_RECIPIENT must be one explicit, valid email address.',
  });
}

if (recipientArg && recipientArg !== recipient) {
  safeExit(2, {
    status: 'recipient_mismatch',
    message: 'The --recipient argument must exactly match MAIL_TEST_RECIPIENT.',
  });
}

if (confirmation !== TEST_CONFIRMATION) {
  safeExit(2, {
    status: 'confirmation_required',
    message: 'MAIL_TEST_CONFIRM must equal SEND_ONE_TEST_EMAIL.',
  });
}

const config = getSmtpConfig();
if (!config) {
  safeExit(1, {
    status: 'smtp_not_configured',
    message: 'SMTP configuration is incomplete. No network connection was made.',
  });
}

if (verifyOnly) {
  const result = await verifyWithTransport(config);
  safeExit(result.ok ? 0 : 1, {
    status: result.ok ? 'smtp_verified' : 'smtp_verify_failed',
    recipient: maskEmail(recipient),
  });
}

const result = await deliverWithTransport(config, {
  to: recipient,
  subject: 'NeerDrishti SMTP connectivity test',
  text: [
    'This is a single explicitly authorized NeerDrishti SMTP connectivity test.',
    'No action is required and this message is not a flood alert.',
  ].join('\n'),
  html: [
    '<p>This is a single explicitly authorized NeerDrishti SMTP connectivity test.</p>',
    '<p>No action is required and this message is not a flood alert.</p>',
  ].join(''),
});

safeExit(result.status === 'SENT' ? 0 : 1, {
  status: result.status === 'SENT' ? 'test_email_sent' : 'test_email_failed',
  recipient: maskEmail(recipient),
});
