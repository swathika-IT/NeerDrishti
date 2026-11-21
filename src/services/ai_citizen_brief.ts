/**
 * Citizen brief: short, grounded, validated flood explanation (en/te/hi).
 *
 * Pipeline: compact context -> LLM (temp 0.2, timeout, 1 retry) -> validate ->
 * deterministic template fallback. The LLM can never introduce numbers that are
 * not in the supplied context, issue "official orders", or omit the 112 line.
 */
import { callLlamaChat } from './llama_client';
import { classifyRainfall24h } from '../config/risk_model';
import { CITIZEN_LABEL, RAIN_CLASS_LABEL, type Lang, type RiskCategory } from '../config/citizen_labels';

export interface CitizenContext {
  district: string;
  rainfall_24h_mm: number | null;
  rainfall_class: string;
  risk_score: number;
  risk_level: RiskCategory;
  main_risk_drivers: string[];
  citizen_reports_24h: number;
  verified_reports_scored: boolean;
  data_mode: 'LIVE' | 'SIMULATED' | 'UNAVAILABLE' | string;
  data_timestamp: string | null;
  data_quality: string;
}

const FACTOR_NAMES: Record<string, string> = {
  rainfall: 'Rainfall',
  flood_history: 'Flood history',
  location_risk: 'Terrain',
  citizen_reports: 'Citizen reports',
  drainage_vulnerability: 'Drainage',
};

export function buildCitizenContext(d: any): CitizenContext {
  const contrib: Record<string, number> = d.contributions || {};
  const drivers = Object.entries(contrib)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => FACTOR_NAMES[k] || k);
  const mm = typeof d.rainfall_mm_24h === 'number' ? d.rainfall_mm_24h : null;
  return {
    district: d.district,
    rainfall_24h_mm: mm,
    rainfall_class: mm === null ? 'Unavailable' : classifyRainfall24h(mm),
    risk_score: d.flood_risk_score,
    risk_level: d.risk_category,
    main_risk_drivers: drivers,
    citizen_reports_24h: d.citizen_reports_24h ?? 0,
    verified_reports_scored: (d.citizen_report_score ?? 0) > 0,
    data_mode: d.rainfall_data_mode || 'SIMULATED',
    data_timestamp: d.rainfall_recorded_at ?? null,
    data_quality: d.risk_confidence || d.data_confidence || 'unknown',
  };
}

/** Verbatim system prompt from the project specification. */
export const CITIZEN_SYSTEM_PROMPT = `You are NeerDrishti, an AI flood-information assistant for Telangana.

Your purpose is to explain verified flood information in simple language.

RULES:
1. Use only the supplied district data.
2. Never invent rainfall values, water levels, or official instructions.
3. Directly answer the user's question.
4. Use the selected language: English, Telugu, or Hindi.
5. Keep citizen answers below 90 words.
6. Provide three short points: (a) what is happening, (b) what it means for the area, (c) what precautions people should take.
7. Distinguish observations, forecasts, and estimates.
8. If information is unavailable, explicitly say so.
9. Never issue fake government evacuation orders.
10. Never pretend an alert has been officially issued.
11. Avoid repetitive answers.
12. End with a reminder to contact district authorities and India's emergency number 112.`;

const MODE_TEXT: Record<string, Record<Lang, string>> = {
  SIMULATED: {
    en: 'demonstration (simulated) data, not real conditions',
    te: 'ఇది ప్రదర్శన కోసం అనుకరణ డేటా, నిజమైన పరిస్థితి కాదు',
    hi: 'यह प्रदर्शन हेतु नकली (सिमुलेटेड) डेटा है, वास्तविक स्थिति नहीं',
  },
  LIVE: {
    en: 'weather-model estimate',
    te: 'వాతావరణ నమూనా అంచనా',
    hi: 'मौसम मॉडल का अनुमान',
  },
  UNAVAILABLE: { en: 'rainfall data unavailable', te: 'వర్షపాత డేటా అందుబాటులో లేదు', hi: 'वर्षा डेटा उपलब्ध नहीं' },
};

export const MEANING: Record<RiskCategory, Record<Lang, string>> = {
  LOW: { en: 'Flooding is unlikely right now.', te: 'ప్రస్తుతం వరద ప్రమాదం తక్కువ.', hi: 'अभी बाढ़ का खतरा कम है।' },
  MODERATE: { en: 'Water may collect in some low-lying areas.', te: 'కొన్ని లోతట్టు ప్రాంతాల్లో నీరు నిలవవచ్చు.', hi: 'कुछ निचले इलाकों में पानी भर सकता है।' },
  HIGH: { en: 'Low-lying areas and roads may get waterlogged.', te: 'లోతట్టు ప్రాంతాలు, రోడ్లు నీటమునిగే అవకాశం ఉంది.', hi: 'निचले इलाकों और सड़कों पर पानी भरने की संभावना है।' },
  CRITICAL: { en: 'Signs of severe flood risk are present.', te: 'తీవ్ర వరద ప్రమాద సూచనలు ఉన్నాయి.', hi: 'गंभीर बाढ़ जोखिम के संकेत हैं।' },
};

export const DO: Record<RiskCategory, Record<Lang, string>> = {
  LOW: { en: 'Follow normal precautions.', te: 'సాధారణ జాగ్రత్తలు పాటించండి.', hi: 'सामान्य सावधानी रखें।' },
  MODERATE: { en: 'Avoid waterlogged roads.', te: 'నీరు నిలిచిన రోడ్లను నివారించండి.', hi: 'जलभराव वाली सड़कों से बचें।' },
  HIGH: { en: 'Stay away from flooded roads and drains; follow local updates.', te: 'నీట మునిగిన రోడ్లు, కాలువలకు దూరంగా ఉండండి; స్థానిక సూచనలు గమనించండి.', hi: 'डूबी सड़कों और नालों से दूर रहें; स्थानीय सूचनाएँ देखें।' },
  CRITICAL: { en: 'Check local authority instructions now and limit travel.', te: 'స్థానిక అధికారుల సూచనలను వెంటనే చూడండి; ప్రయాణం తగ్గించండి.', hi: 'स्थानीय अधिकारियों के निर्देश अभी देखें; यात्रा कम करें।' },
};

const FOOTER: Record<Lang, string> = {
  en: 'This is information, not an official order. For help contact district authorities or call 112.',
  te: 'ఇది సమాచారం మాత్రమే, అధికారిక ఆదేశం కాదు. సహాయానికి జిల్లా అధికారులను సంప్రదించండి లేదా 112 కు కాల్ చేయండి.',
  hi: 'यह केवल जानकारी है, आधिकारिक आदेश नहीं। सहायता हेतु जिला अधिकारियों से संपर्क करें या 112 डायल करें।',
};

export function deterministicCitizenBrief(ctx: CitizenContext, lang: Lang): string {
  const label = CITIZEN_LABEL[ctx.risk_level]?.[lang] ?? CITIZEN_LABEL.MODERATE[lang];
  const mode = (MODE_TEXT[ctx.rainfall_24h_mm === null ? 'UNAVAILABLE' : ctx.data_mode] || MODE_TEXT.UNAVAILABLE)[lang];
  const cls = RAIN_CLASS_LABEL[ctx.rainfall_class]?.[lang];
  let now: string;
  if (ctx.rainfall_24h_mm === null) {
    now = mode + '.';
  } else if (lang === 'te') {
    now = `24 గంటల్లో సుమారు ${ctx.rainfall_24h_mm} మి.మీ. వర్షం (${cls}) – ${mode}.`;
  } else if (lang === 'hi') {
    now = `24 घंटे में लगभग ${ctx.rainfall_24h_mm} मिमी वर्षा (${cls}) – ${mode}।`;
  } else {
    now = `About ${ctx.rainfall_24h_mm} mm rain in 24 hours (${cls}) – ${mode}.`;
  }
  const lv = ctx.risk_level;
  return `${ctx.district}: ${label}\n1. ${now}\n2. ${MEANING[lv][lang]}\n3. ${DO[lv][lang]}\n${FOOTER[lang]}`;
}

const BANNED = [
  /evacuat/i, /\border(ed|s)?\b/i, /mandatory/i, /government has (announced|declared|issued)/i,
  /official(ly)? (alert|warning|evacuation)/i, /खाली करें/, /ఖాళీ చేయ/,
];
const MAX_WORDS = 90;

export interface BriefValidation { ok: boolean; reasons: string[]; words: number }

export function validateBrief(text: string, ctx: CitizenContext): BriefValidation {
  const reasons: string[] = [];
  const clean = (text || '').trim();
  const words = clean.split(/\s+/).filter(Boolean).length;
  if (!clean) reasons.push('empty');
  if (words > MAX_WORDS) reasons.push(`too_long:${words}`);
  if (!/\b112\b/.test(clean)) reasons.push('missing_112');
  // Footer "not an official order" is allowed; strip it before the banned-phrase scan.
  const scan = clean.replace(/not an official order|आधिकारिक आदेश नहीं|అధికారిక ఆదేశం కాదు/gi, '');
  for (const re of BANNED) if (re.test(scan)) reasons.push(`banned:${re.source}`);
  const allowed = new Set<string>(['1', '2', '3', '24', '112']);
  if (ctx.rainfall_24h_mm !== null) {
    allowed.add(String(ctx.rainfall_24h_mm));
    allowed.add(String(Math.round(ctx.rainfall_24h_mm)));
    allowed.add(ctx.rainfall_24h_mm.toFixed(1));
  }
  allowed.add(String(ctx.risk_score)); allowed.add(String(Math.round(ctx.risk_score)));
  allowed.add(String(ctx.citizen_reports_24h));
  for (const n of clean.match(/\d+(?:\.\d+)?/g) || []) {
    if (!allowed.has(n)) reasons.push(`unsupported_number:${n}`);
  }
  return { ok: reasons.length === 0, reasons, words };
}

export interface BriefResult {
  text: string;
  source: 'llm' | 'deterministic';
  model?: string;
  validation: BriefValidation;
  fallback_reason?: string;
  context: CitizenContext;
}

type LlmFn = typeof callLlamaChat;

export async function generateCitizenBrief(
  ctx: CitizenContext,
  lang: Lang,
  question?: string,
  llm: LlmFn = callLlamaChat,
  opts: { retries?: number; timeoutMs?: number } = {}
): Promise<BriefResult> {
  const retries = opts.retries ?? 1;
  let lastReason = 'llm_unavailable';
  const langName = { en: 'English', te: 'Telugu', hi: 'Hindi' }[lang];
  const user = `LANGUAGE: ${langName}\nQUESTION: ${(question || 'What is the flood situation and what should I do?').slice(0, 300)}\nDISTRICT DATA (JSON):\n${JSON.stringify(ctx)}\n\nReply in ${langName} with the district name and the risk label, then exactly three short numbered points, then the closing reminder. Under 90 words in total.`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await llm(
        [{ role: 'system', content: CITIZEN_SYSTEM_PROMPT }, { role: 'user', content: user }],
        { temperature: 0.2, timeoutMs: opts.timeoutMs ?? 12000 }
      );
      if (!res?.text) { lastReason = 'llm_unavailable'; continue; }
      const v = validateBrief(res.text, ctx);
      if (v.ok) return { text: res.text.trim(), source: 'llm', model: res.model, validation: v, context: ctx };
      lastReason = `validation_failed:${v.reasons.join(',')}`;
    } catch (e: any) {
      lastReason = `llm_error:${e?.message || 'unknown'}`;
    }
  }
  const text = deterministicCitizenBrief(ctx, lang);
  return { text, source: 'deterministic', validation: validateBrief(text, ctx), fallback_reason: lastReason, context: ctx };
}
