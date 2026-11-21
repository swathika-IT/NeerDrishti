/**
 * Notification preview + simulation helpers (DRY-RUN ONLY: nothing here talks to a provider).
 *  - Channel-specific previews: WhatsApp (character count, no SMS segments), SMS (encoding-aware segments), Email (subject+body).
 *  - Actual district risk is kept separate from the preview severity; a manual override is flagged explicitly.
 */
import { CITIZEN_LABEL, type Lang, type RiskCategory } from '../../config/citizen_labels';
import { MEANING, DO } from '../ai_citizen_brief';

export type Channel = 'WHATSAPP' | 'SMS' | 'EMAIL';
export type Severity = 'NORMAL' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'CRITICAL';
export const SEVERITIES: Severity[] = ['NORMAL', 'WATCH', 'ELEVATED', 'HIGH', 'CRITICAL'];

const SEV_TO_CATEGORY: Record<Severity, RiskCategory> = { NORMAL: 'LOW', WATCH: 'MODERATE', ELEVATED: 'MODERATE', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
const CATEGORY_TO_SEV: Record<RiskCategory, Severity> = { LOW: 'NORMAL', MODERATE: 'WATCH', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
export const severityFromRisk = (c: RiskCategory): Severity => CATEGORY_TO_SEV[c] ?? 'WATCH';

const DEMO_TAG: Record<Lang, string> = {
  en: '(Demo simulation, not an official alert.) Emergency: 112',
  te: '(ప్రదర్శన మాత్రమే, అధికారిక హెచ్చరిక కాదు.) అత్యవసరం: 112',
  hi: '(केवल प्रदर्शन, आधिकारिक अलर्ट नहीं।) आपातकाल: 112',
};
const BRAND: Record<Lang, string> = { en: 'NeerDrishti demo', te: 'NeerDrishti ప్రదర్శన', hi: 'NeerDrishti प्रदर्शन' };

// ---- SMS segmentation (GSM 03.38 vs UCS-2) ---------------------------------------------------
const GSM7_BASIC = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const GSM7_EXT = new Set(Array.from('^{}\\[~]|€\f'));

export interface SmsEstimate { encoding: 'GSM-7' | 'UCS-2'; units: number; segments: number; per_segment_limit: number; single_limit: number; note: string }

export function estimateSms(text: string): SmsEstimate {
  const chars = Array.from(text);
  let gsmUnits = 0, gsm = true;
  for (const ch of chars) {
    if (GSM7_BASIC.has(ch)) gsmUnits += 1;
    else if (GSM7_EXT.has(ch)) gsmUnits += 2;   // escape + char
    else { gsm = false; break; }
  }
  const note = 'Estimate only. Actual segmentation depends on the provider and carrier.';
  if (gsm) {
    const segments = gsmUnits === 0 ? 0 : gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
    return { encoding: 'GSM-7', units: gsmUnits, segments, per_segment_limit: segments > 1 ? 153 : 160, single_limit: 160, note };
  }
  const units = text.length;   // UTF-16 code units: emoji / astral chars count as 2
  const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS-2', units, segments, per_segment_limit: segments > 1 ? 67 : 70, single_limit: 70, note };
}

// ---- message building -----------------------------------------------------------------------
export interface PreviewInput { districtName: string; severity: Severity; language: Lang; channel: Channel }
export interface PreviewOutput {
  channel: Channel; language: Lang; severity: Severity; subject?: string; body: string;
  metrics: { characters: number; sms?: SmsEstimate };
}

export function buildPreview(i: PreviewInput): PreviewOutput {
  const cat = SEV_TO_CATEGORY[i.severity];
  const label = CITIZEN_LABEL[cat][i.language];
  const core = `${i.districtName}: ${label}. ${MEANING[cat][i.language]} ${DO[cat][i.language]}`;
  const tag = DEMO_TAG[i.language];
  if (i.channel === 'EMAIL') {
    const subject = `[${BRAND[i.language]}] ${label}: ${i.districtName}`;
    const body = `${core}\n\n${tag}`;
    return { channel: 'EMAIL', language: i.language, severity: i.severity, subject, body, metrics: { characters: body.length } };
  }
  const body = `${BRAND[i.language]} – ${core} ${tag}`;
  const metrics: PreviewOutput['metrics'] = { characters: Array.from(body).length };
  if (i.channel === 'SMS') metrics.sms = estimateSms(body);   // WHATSAPP intentionally gets NO segment data
  return { channel: i.channel, language: i.language, severity: i.severity, body, metrics };
}

// ---- contact validation + masking -----------------------------------------------------------
export function validateContact(channel: Channel, raw: string | undefined | null): { ok: boolean; value?: string; error?: string } {
  const v = (raw || '').trim();
  if (!v) return { ok: true };   // contact is optional for a simulation
  if (channel === 'EMAIL') return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 120 ? { ok: true, value: v } : { ok: false, error: 'Enter a valid email address.' };
  const compact = v.replace(/[\s-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? { ok: true, value: compact } : { ok: false, error: 'Enter the phone number in international format, e.g. +919876543210.' };
}

export function maskContact(channel: Channel, v: string | undefined): string | null {
  if (!v) return null;
  if (channel === 'EMAIL') { const [u, d] = v.split('@'); return `${u.slice(0, 1)}***@${d}`; }
  return `${v.slice(0, 3)}${'*'.repeat(Math.max(0, v.length - 6))}${v.slice(-3)}`;
}
