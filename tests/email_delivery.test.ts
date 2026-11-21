import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMailActionUrl,
  deliverWithTransport,
  getAppBaseUrl,
  getSmtpConfig,
  isMailDryRun,
  isSmtpConfigured,
  sendTransactionalEmail,
  verifySmtpConnection,
  verifyWithTransport,
  type MailTransport,
  type MailTransportInfo,
  type SmtpConfig,
} from '../src/services/email/mail_service';
import { buildPasswordResetEmail, buildVerificationEmail } from '../src/services/email/templates';

const validEnv: NodeJS.ProcessEnv = {
  APP_BASE_URL: 'https://app.example.test/',
  MAIL_DRY_RUN: 'true',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'mailer@example.test',
  SMTP_PASS: 'fake-password-for-mock-tests',
  MAIL_FROM: 'NeerDrishti <no-reply@example.test>',
};

const mockConfig: SmtpConfig = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'mailer@example.test',
  pass: 'fake-password-for-mock-tests',
  from: 'NeerDrishti <no-reply@example.test>',
};

class MockTransport implements MailTransport {
  public verifyCalls = 0;
  public sendCalls: any[] = [];
  public closeCalls = 0;
  constructor(private readonly fail = false, private readonly info: MailTransportInfo = { messageId: 'mock-message-1' }) {}

  async verify(): Promise<void> {
    this.verifyCalls += 1;
    if (this.fail) throw new Error('mock verify failed with fake-password-for-mock-tests');
  }

  async sendMail(message: any): Promise<MailTransportInfo> {
    this.sendCalls.push(message);
    if (this.fail) throw new Error('mock send failed with fake-password-for-mock-tests');
    return this.info;
  }

  close(): void {
    this.closeCalls += 1;
  }
}

test('mail base URL uses APP_BASE_URL and strips trailing slashes', () => {
  assert.equal(getAppBaseUrl(validEnv), 'https://app.example.test');
});

test('mail action URLs contain encoded tokens and correct paths', () => {
  const verify = buildMailActionUrl('verify_email', 'token+with/slash', validEnv);
  const reset = buildMailActionUrl('reset_password', 'reset token', validEnv);
  assert.equal(verify, 'https://app.example.test/?verify_email=token%2Bwith%2Fslash');
  assert.equal(reset, 'https://app.example.test/?reset_password=reset+token');
});

test('SMTP config parses secure defaults and validates values', () => {
  const config = getSmtpConfig(validEnv);
  assert.ok(config);
  assert.equal(config.host, 'smtp.example.test');
  assert.equal(config.port, 587);
  assert.equal(config.secure, false);
  assert.equal(isSmtpConfigured(validEnv), true);
  assert.equal(isSmtpConfigured({ ...validEnv, SMTP_PASS: '' }), false);
  assert.equal(isSmtpConfigured({ ...validEnv, SMTP_HOST: 'https://smtp.example.test' }), false);
  assert.deepEqual(getSmtpConfig({ ...validEnv, SMTP_PORT: '65536' }), null);
  assert.equal(getSmtpConfig({ ...validEnv, SMTP_PORT: '465', SMTP_SECURE: undefined })?.secure, true);
});

test('mail dry-run defaults to true and verification makes no connection', async () => {
  assert.equal(isMailDryRun({}), true);
  assert.equal(isMailDryRun({ MAIL_DRY_RUN: 'false' }), false);

  let factoryCalled = false;
  const result = await verifySmtpConnection({
    env: validEnv,
    transportFactory: () => {
      factoryCalled = true;
      return new MockTransport();
    },
  });
  assert.deepEqual(result, { ok: false, status: 'DRY_RUN', dryRunReason: 'MAIL_DRY_RUN' });
  assert.equal(factoryCalled, false);
});

test('live send remains disabled even when MAIL_DRY_RUN is false', async () => {
  let factoryCalled = false;
  const result = await sendTransactionalEmail(
    {
      to: 'user@example.test',
      subject: 'Verify your NeerDrishti account',
      text: 'Verify',
      html: '<p>Verify</p>',
    },
    {
      env: { ...validEnv, MAIL_DRY_RUN: 'false' },
      transportFactory: () => {
        factoryCalled = true;
        return new MockTransport();
      },
    }
  );
  assert.equal(result.status, 'DRY_RUN');
  assert.equal(result.dryRunReason, 'LIVE_SEND_DISABLED_IN_THIS_RELEASE');
  assert.equal(factoryCalled, false);
});

test('mock SMTP transport verifies and closes without returning credentials', async () => {
  const mock = new MockTransport();
  const result = await verifyWithTransport(mockConfig, () => mock);
  assert.deepEqual(result, { ok: true, status: 'VERIFIED' });
  assert.equal(mock.verifyCalls, 1);
  assert.equal(mock.closeCalls, 1);
});

test('mock SMTP transport sends mail with expected from/to and payload', async () => {
  const mock = new MockTransport(false, { messageId: 'mock-message-2' });
  const email = buildPasswordResetEmail({
    recipientName: 'Demo Citizen',
    resetUrl: 'https://app.example.test/?reset_password=token',
    expiresInMinutes: 30,
  });
  const result = await deliverWithTransport(mockConfig, { ...email, to: 'user@example.test' }, () => mock);
  assert.equal(result.status, 'SENT');
  assert.equal(result.providerMessageId, 'mock-message-2');
  assert.equal(mock.sendCalls.length, 1);
  assert.equal(mock.sendCalls[0].from, mockConfig.from);
  assert.equal(mock.sendCalls[0].to, 'user@example.test');
  assert.match(mock.sendCalls[0].subject, /Reset your NeerDrishti password/);
  assert.match(mock.sendCalls[0].html, /https:\/\/app\.example\.test\/\?reset_password=token/);
  assert.equal(mock.closeCalls, 1);
});

test('mock SMTP provider returns sanitized failure without exposing credentials', async () => {
  const mock = new MockTransport(true);
  const result = await deliverWithTransport(mockConfig, {
    to: 'user@example.test',
    subject: 'Verify your NeerDrishti account',
    text: 'Verify',
    html: '<p>Verify</p>',
  }, () => mock);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'SMTP_DELIVERY_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /fake-password-for-mock-tests/);
  assert.equal(mock.closeCalls, 1);
});

test('verification email template escapes user content and includes expiry', () => {
  const email = buildVerificationEmail({
    recipientName: '<script>alert(1)</script>',
    verificationUrl: 'https://app.example.test/?verify_email=safe',
    expiresInHours: 24,
  });
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.match(email.html, /24 hours/);
  assert.match(email.text, /https:\/\/app\.example\.test\/\?verify_email=safe/);
  assert.match(email.subject, /Verify your NeerDrishti account/);
});

test('password reset template is clearly scoped and non-actionable when ignored', () => {
  const email = buildPasswordResetEmail({
    recipientName: 'Demo Citizen',
    resetUrl: 'https://app.example.test/?reset_password=safe',
    expiresInMinutes: 30,
  });
  assert.match(email.text, /can be used once/);
  assert.match(email.html, /password will not change/);
  assert.doesNotMatch(email.html, /secret|token=/);
});
