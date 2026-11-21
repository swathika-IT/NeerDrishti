export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const BUTTON_STYLE =
  'display:inline-block;padding:12px 20px;border-radius:8px;background:#0369a1;color:#ffffff;text-decoration:none;font-weight:700;';

const WRAPPER_OPEN =
  '<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:24px 12px;"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;"><tr><td style="background:#0f172a;padding:22px 26px;"><div style="color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-0.02em;">NeerDrishti</div><div style="color:#7dd3fc;font-size:12px;margin-top:3px;">Urban Flood Intelligence</div></td></tr><tr><td style="padding:26px;">';
const WRAPPER_CLOSE =
  '</td></tr><tr><td style="padding:18px 26px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5;">NeerDrishti decision-support notice. For life-threatening emergencies, contact official emergency services immediately.</td></tr></table></td></tr></table></body></html>';

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface VerificationEmailInput {
  recipientName?: string | null;
  verificationUrl: string;
  expiresInHours: number;
}

export function buildVerificationEmail(input: VerificationEmailInput): TransactionalEmail {
  const name = String(input.recipientName || '').trim();
  const safeUrl = escapeHtml(input.verificationUrl);
  const greeting = name ? `Hello ${escapeHtml(name)},` : 'Hello,';
  return {
    to: '',
    subject: 'Verify your NeerDrishti account',
    text: [
      name ? `Hello ${name},` : 'Hello,',
      '',
      'Confirm your email address to finish setting up your NeerDrishti account.',
      input.verificationUrl,
      '',
      `This link expires in ${input.expiresInHours} hours and can be used once.`,
      'If you did not create this account, you can ignore this email.',
    ].join('\n'),
    html: `${WRAPPER_OPEN}
<h1 style="font-size:20px;margin:0 0 12px 0;color:#0f172a;">Verify your email</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 14px 0;">${greeting}</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 18px 0;">Confirm your email address to finish setting up your NeerDrishti account.</p>
<p style="margin:0 0 18px 0;"><a href="${safeUrl}" style="${BUTTON_STYLE}">Verify email address</a></p>
<p style="font-size:13px;line-height:1.6;margin:0 0 10px 0;color:#475569;">This link expires in ${input.expiresInHours} hours and can be used once.</p>
<p style="font-size:13px;line-height:1.6;margin:0;color:#475569;">If the button does not work, paste this link into your browser:<br><a href="${safeUrl}" style="color:#0369a1;word-break:break-all;">${safeUrl}</a></p>
<p style="font-size:12px;line-height:1.6;margin:16px 0 0 0;color:#64748b;">If you did not create this account, you can ignore this email.</p>
${WRAPPER_CLOSE}`,
  };
}

export interface PasswordResetEmailInput {
  recipientName?: string | null;
  resetUrl: string;
  expiresInMinutes: number;
}

export function buildPasswordResetEmail(input: PasswordResetEmailInput): TransactionalEmail {
  const name = String(input.recipientName || '').trim();
  const safeUrl = escapeHtml(input.resetUrl);
  const greeting = name ? `Hello ${escapeHtml(name)},` : 'Hello,';
  return {
    to: '',
    subject: 'Reset your NeerDrishti password',
    text: [
      name ? `Hello ${name},` : 'Hello,',
      '',
      'We received a request to reset your NeerDrishti password.',
      input.resetUrl,
      '',
      `This link expires in ${input.expiresInMinutes} minutes and can be used once.`,
      'If you did not request a password reset, you can ignore this email. Your password will not change.',
    ].join('\n'),
    html: `${WRAPPER_OPEN}
<h1 style="font-size:20px;margin:0 0 12px 0;color:#0f172a;">Reset your password</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 14px 0;">${greeting}</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 18px 0;">We received a request to reset your NeerDrishti password.</p>
<p style="margin:0 0 18px 0;"><a href="${safeUrl}" style="${BUTTON_STYLE}">Reset password</a></p>
<p style="font-size:13px;line-height:1.6;margin:0 0 10px 0;color:#475569;">This link expires in ${input.expiresInMinutes} minutes and can be used once.</p>
<p style="font-size:13px;line-height:1.6;margin:0;color:#475569;">If the button does not work, paste this link into your browser:<br><a href="${safeUrl}" style="color:#0369a1;word-break:break-all;">${safeUrl}</a></p>
<p style="font-size:12px;line-height:1.6;margin:16px 0 0 0;color:#64748b;">If you did not request a password reset, you can ignore this email. Your password will not change.</p>
${WRAPPER_CLOSE}`,
  };
}
