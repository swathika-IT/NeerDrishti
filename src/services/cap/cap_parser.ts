/**
 * Minimal, dependency-free parser for the IMD Common Alerting Protocol feed
 * (WMO Alert Hub format: RSS 2.0 index + OASIS CAP 1.2 XML alert documents).
 *
 * Tolerant by design: CAP documents from the feed use the `cap:` namespace prefix, but the
 * parser accepts prefixed or unprefixed tags. It never "repairs" missing required fields —
 * invalid alerts are rejected for honest reporting.
 */

export interface CapRssItem {
  title: string | null;
  link: string | null;
  guid: string | null;
  pubDate: string | null;
  description: string | null;
}

export interface CapArea {
  areaDesc: string;
  polygon?: string | null;
  geocode?: Record<string, string> | null;
}

export interface CapInfo {
  language: string | null;
  category: string | null;
  event: string;
  responseType: string | null;
  urgency: string | null;
  severity: string | null;
  certainty: string | null;
  onset: string | null;
  effective: string | null;
  expires: string | null;
  senderName: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  web: string | null;
  areas: CapArea[];
}

export interface CapAlert {
  identifier: string;
  sender: string;
  sent: string;
  status: string;
  msgType: string;
  scope: string | null;
  references: string | null;
  info: CapInfo;
}

export interface CapParseResult {
  alert: CapAlert | null;
  error?: string;
  partialIdentifier?: string;
}

export interface CapParseError {
  error: string;
  partialIdentifier?: string;
}

const ENTITY_MAP: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(input: string): string {
  return String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITY_MAP[name] ?? m)
    .trim();
}

function tagNameAlternation(tag: string): string {
  return `(?:[A-Za-z0-9_]+:)?${tag}`;
}

/** First occurrence of <tag>…</tag> (namespace prefix optional). Null when absent. */
export function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tagNameAlternation(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagNameAlternation(tag)}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]) : null;
}

/** All occurrences of <tag>…</tag>. */
export function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tagNameAlternation(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagNameAlternation(tag)}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decodeXmlEntities(m[1]));
  return out;
}

export function parseRssItems(rssXml: string): CapRssItem[] {
  const itemBlocks = extractAllTags(rssXml, 'item');
  return itemBlocks.map(block => ({
    title: extractTag(block, 'title'),
    link: extractTag(block, 'link'),
    guid: extractTag(block, 'guid'),
    pubDate: extractTag(block, 'pubDate'),
    description: extractTag(block, 'description'),
  }));
}

const VALID_STATUS = ['Actual', 'Test', 'Exercise', 'System', 'Draft'];
const VALID_MSG_TYPE = ['Alert', 'Update', 'Cancel', 'Ack', 'Error'];
const VALID_SEVERITY = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const VALID_URGENCY = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'];
const VALID_CERTAINTY = ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown'];

function parseIso(value: string | null): string | null {
  if (!value) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString();
}

/**
 * Parses a CAP 1.2 alert document. Returns a parse error (never a fabricated alert)
 * when required fields are missing or invalid.
 */
export function parseCapAlert(xml: string): CapParseResult {
  if (!xml || typeof xml !== 'string' || xml.trim().length === 0) {
    return { alert: null, error: 'Empty CAP document' };
  }
  if (!/<(?:[A-Za-z0-9_]+:)?alert[\s>]/i.test(xml)) {
    return { alert: null, error: 'Not a CAP alert document (no <alert> root element)' };
  }

  const identifier = extractTag(xml, 'identifier');
  const sender = extractTag(xml, 'sender');
  const sentRaw = extractTag(xml, 'sent');
  const status = extractTag(xml, 'status');
  const msgType = extractTag(xml, 'msgType');

  if (!identifier) return { alert: null, error: 'Missing required field: identifier' };
  if (!sender) return { alert: null, error: 'Missing required field: sender', partialIdentifier: identifier };
  if (!sentRaw) return { alert: null, error: 'Missing required field: sent', partialIdentifier: identifier };
  const sent = parseIso(sentRaw);
  if (!sent) return { alert: null, error: `Invalid sent timestamp: ${sentRaw}`, partialIdentifier: identifier };
  if (!status || !VALID_STATUS.includes(status)) {
    return { alert: null, error: `Invalid or missing status: ${status ?? 'null'}`, partialIdentifier: identifier };
  }
  if (!msgType || !VALID_MSG_TYPE.includes(msgType)) {
    return { alert: null, error: `Invalid or missing msgType: ${msgType ?? 'null'}`, partialIdentifier: identifier };
  }

  const infoBlocks = extractAllTags(xml, 'info');
  if (infoBlocks.length === 0) {
    return { alert: null, error: 'CAP alert has no <info> block', partialIdentifier: identifier };
  }

  // Prefer an English info block; otherwise the first one.
  const pickEnglish = (blocks: string[]) =>
    blocks.find(b => {
      const lang = (extractTag(b, 'language') || '').toLowerCase();
      return lang === 'en' || lang.startsWith('en-');
    }) || blocks[0];
  const infoBlock = pickEnglish(infoBlocks);

  const event = extractTag(infoBlock, 'event');
  if (!event) return { alert: null, error: 'Info block missing required field: event', partialIdentifier: identifier };

  const severity = extractTag(infoBlock, 'severity');
  if (severity && !VALID_SEVERITY.includes(severity)) {
    return { alert: null, error: `Invalid severity: ${severity}`, partialIdentifier: identifier };
  }
  const urgency = extractTag(infoBlock, 'urgency');
  if (urgency && !VALID_URGENCY.includes(urgency)) {
    return { alert: null, error: `Invalid urgency: ${urgency}`, partialIdentifier: identifier };
  }
  const certainty = extractTag(infoBlock, 'certainty');
  if (certainty && !VALID_CERTAINTY.includes(certainty)) {
    return { alert: null, error: `Invalid certainty: ${certainty}`, partialIdentifier: identifier };
  }

  const areaBlocks = extractAllTags(infoBlock, 'area');
  const areas: CapArea[] = areaBlocks.map(block => {
    const geocodes = extractAllTags(block, 'geocode');
    const geocode: Record<string, string> = {};
    for (const g of geocodes) {
      const valueName = extractTag(g, 'valueName');
      const value = extractTag(g, 'value');
      if (valueName && value) geocode[valueName] = value;
    }
    return {
      areaDesc: extractTag(block, 'areaDesc') || '',
      polygon: extractTag(block, 'polygon'),
      geocode: Object.keys(geocode).length > 0 ? geocode : null,
    };
  }).filter(a => a.areaDesc.length > 0);

  if (areas.length === 0) {
    return { alert: null, error: 'Info block has no area with a usable areaDesc', partialIdentifier: identifier };
  }

  return {
    alert: {
      identifier,
      sender,
      sent,
      status,
      msgType,
      scope: extractTag(xml, 'scope'),
      references: extractTag(xml, 'references'),
      info: {
        language: extractTag(infoBlock, 'language'),
        category: extractTag(infoBlock, 'category'),
        event,
        responseType: extractTag(infoBlock, 'responseType'),
        urgency: urgency || null,
        severity: severity || null,
        certainty: certainty || null,
        onset: parseIso(extractTag(infoBlock, 'onset')),
        effective: parseIso(extractTag(infoBlock, 'effective')),
        expires: parseIso(extractTag(infoBlock, 'expires')),
        senderName: extractTag(infoBlock, 'senderName'),
        headline: extractTag(infoBlock, 'headline'),
        description: extractTag(infoBlock, 'description'),
        instruction: extractTag(infoBlock, 'instruction'),
        web: extractTag(infoBlock, 'web'),
        areas,
      },
    },
  };
}

/** Computes display status from msgType + expiry. Never alters stored values. */
export function alertLifecycleStatus(alert: { msgType: string; info: { expires: string | null } }, now: Date = new Date()): 'ACTIVE' | 'EXPIRED' | 'CANCELLED' {
  if (alert.msgType === 'Cancel') return 'CANCELLED';
  if (alert.info.expires) {
    const exp = new Date(alert.info.expires).getTime();
    if (Number.isFinite(exp) && exp <= now.getTime()) return 'EXPIRED';
  }
  return 'ACTIVE';
}
