import crypto from 'crypto';

/** Canonical Phase 6 report categories. */
export const REPORT_CATEGORIES = [
  'Urban Flooding',
  'Waterlogging',
  'Blocked Drainage',
  'Rising Water Levels',
  'Road Flooding',
  'Lakes or Canals Overflow',
  'Other',
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** Legacy classifier values accepted for backward compatibility and mapped to canonical categories. */
const CATEGORY_ALIASES: Record<string, ReportCategory> = {
  'urban flooding': 'Urban Flooding',
  waterlogging: 'Waterlogging',
  'water logging': 'Waterlogging',
  'blocked drainage': 'Blocked Drainage',
  'drainage overflow': 'Blocked Drainage',
  'blocked drain': 'Blocked Drainage',
  'rising water levels': 'Rising Water Levels',
  'river overflow': 'Rising Water Levels',
  'rising water level': 'Rising Water Levels',
  'road flooding': 'Road Flooding',
  'lakes or canals overflow': 'Lakes or Canals Overflow',
  'lake overflow': 'Lakes or Canals Overflow',
  'canal overflow': 'Lakes or Canals Overflow',
  'water entering buildings': 'Urban Flooding',
  other: 'Other',
};

export function normalizeCategory(raw: unknown): ReportCategory | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const key = String(raw).trim().toLowerCase();
  const alias = CATEGORY_ALIASES[key];
  if (alias) return alias;
  const exact = REPORT_CATEGORIES.find(c => c.toLowerCase() === key);
  return exact || null;
}

export const REPORT_SEVERITIES = ['Low', 'Moderate', 'High', 'Critical'] as const;

/** Telangana bounding box (generous) for coordinate validation. */
export const TELANGANA_BOUNDS = { minLat: 15.5, maxLat: 20.5, minLng: 76.5, maxLng: 81.5 };

export const PRIVILEGED_REPORT_FIELDS = [
  'id',
  'reporter_user_id',
  'status',
  'ai_processed',
  'created_at',
  'classification_source',
  'classification_confidence',
  'verified',
  'verified_by',
  'approved',
];

export function findPrivilegedFields(body: Record<string, any>): string[] {
  return PRIVILEGED_REPORT_FIELDS.filter(f => body && Object.prototype.hasOwnProperty.call(body, f));
}

export function sanitizeText(raw: unknown, maxLen: number): string {
  if (raw === undefined || raw === null) return '';
  return String(raw)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLen);
}

export interface CoordinatesResult {
  ok: boolean;
  error?: string;
  lat?: number;
  lng?: number;
}

export function validateCoordinates(latRaw: unknown, lngRaw: unknown): CoordinatesResult {
  const hasLat = latRaw !== undefined && latRaw !== null && String(latRaw).trim() !== '';
  const hasLng = lngRaw !== undefined && lngRaw !== null && String(lngRaw).trim() !== '';
  if (!hasLat && !hasLng) return { ok: true };
  if (hasLat !== hasLng) {
    return { ok: false, error: 'Both latitude and longitude must be provided together.' };
  }
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'Coordinates must be finite numbers.' };
  }
  if (lat < TELANGANA_BOUNDS.minLat || lat > TELANGANA_BOUNDS.maxLat ||
      lng < TELANGANA_BOUNDS.minLng || lng > TELANGANA_BOUNDS.maxLng) {
    return { ok: false, error: 'Coordinates are outside the Telangana bounding box.' };
  }
  return { ok: true, lat, lng };
}

export interface ReportTimestampResult {
  ok: boolean;
  error?: string;
  reportedAt: string;
}

/** Server-authoritative timestamps: client value, if sent, must be a recent valid ISO timestamp. */
export function validateReportedAt(raw: unknown): ReportTimestampResult {
  const now = Date.now();
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, reportedAt: new Date(now).toISOString() };
  }
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: 'reported_at must be a valid ISO timestamp.', reportedAt: '' };
  }
  if (parsed.getTime() > now + 5 * 60 * 1000) {
    return { ok: false, error: 'reported_at cannot be in the future.', reportedAt: '' };
  }
  if (parsed.getTime() < now - 30 * 24 * 3600 * 1000) {
    return { ok: false, error: 'reported_at cannot be more than 30 days in the past.', reportedAt: '' };
  }
  return { ok: true, reportedAt: parsed.toISOString() };
}

export interface AttachmentValidationResult {
  ok: boolean;
  error?: string;
  kind?: 'data_uri' | 'url';
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  value?: string;
}

const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_ATTACHMENT_BYTES = 2_000_000;
const DATA_URI_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

/**
 * Validates an optional attachment reference. Accepts only raster image data URIs
 * (png/jpeg/webp) or https URLs. SVG is rejected (script-capable), as are non-http
 * schemes, path traversal and executable payloads. No image content analysis exists —
 * validation is structural only, never a claim of visual verification.
 */
export function validateAttachment(raw: unknown): AttachmentValidationResult {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true };
  }
  const value = String(raw).trim();
  if (value.length > 3_000_000) {
    return { ok: false, error: 'Attachment is too large.' };
  }
  if (/[\u0000-\u001F]/.test(value)) {
    return { ok: false, error: 'Attachment contains control characters.' };
  }
  if (value.includes('..') && !value.startsWith('data:')) {
    return { ok: false, error: 'Attachment reference contains a disallowed path sequence.' };
  }
  if (/^(javascript|vbscript|file|blob):/i.test(value) || /^data:text\//i.test(value) || /^data:image\/svg/i.test(value)) {
    return { ok: false, error: 'Attachment type is not permitted.' };
  }

  if (value.startsWith('data:')) {
    const match = value.match(DATA_URI_RE);
    if (!match) {
      return { ok: false, error: 'Only PNG, JPEG or WEBP image attachments are allowed.' };
    }
    const mimeType = match[1].toLowerCase();
    const base64 = match[2];
    if (!ALLOWED_IMAGE_MIMES.includes(mimeType)) {
      return { ok: false, error: 'Only PNG, JPEG or WEBP image attachments are allowed.' };
    }
    let sizeBytes = 0;
    try {
      sizeBytes = Buffer.from(base64, 'base64').length;
    } catch {
      return { ok: false, error: 'Attachment could not be decoded.' };
    }
    if (sizeBytes === 0) return { ok: false, error: 'Attachment is empty.' };
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: 'Attachment exceeds the 2 MB limit.' };
    }
    const sha256 = crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
    return { ok: true, kind: 'data_uri', mimeType, sizeBytes, sha256, value };
  }

  if (/^https:\/\//i.test(value)) {
    if (value.length > 500) return { ok: false, error: 'Attachment URL is too long.' };
    try {
      const url = new URL(value);
      if (url.username || url.password) return { ok: false, error: 'Attachment URL must not contain credentials.' };
      return { ok: true, kind: 'url', mimeType: 'image/*', sizeBytes: 0, sha256: '', value };
    } catch {
      return { ok: false, error: 'Attachment URL is malformed.' };
    }
  }

  return { ok: false, error: 'Attachment must be an https URL or a PNG/JPEG/WEBP data URI.' };
}
