import { randomUUID } from 'node:crypto';
import { DistrictStatus } from '../types';
import { FLOOD_INTENTS, GroundedAIResponse, UserQuestionIntent } from '../types/ai';
import { intentService } from './intent_service';
import { aiIntelligenceService } from './ai_intelligence_service';

export type ConversationLanguage = 'en' | 'te' | 'hi';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  districtId?: string;
  createdAt: string;
}

interface ConversationSession {
  ownerKey: string;
  turns: ConversationTurn[];
  lastSeen: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_TURNS = 12;
const MAX_MESSAGE_CHARS = 2000;

const LOCAL_REPLIES: Record<'GREETING' | 'SMALL_TALK' | 'INTRODUCTION' | 'GRATITUDE' | 'GENERAL_CONVERSATION' | 'GENERAL_KNOWLEDGE', Record<ConversationLanguage, string>> = {
  GREETING: {
    en: 'Hello! Welcome to NeerDrishti. How can I help you today?',
    te: 'నమస్కారం! నీర్ దృష్టికి స్వాగతం. ఈ రోజు నేను మీకు ఎలా సహాయం చేయగలను?',
    hi: 'नमस्ते! नीरदृष्टि में आपका स्वागत है। आज मैं आपकी क्या मदद कर सकता हूँ?',
  },
  SMALL_TALK: {
    en: "I'm doing well, thank you! I'm here to help with flood risk, rainfall, alerts, safety guidance, and citizen reports. What would you like to know?",
    te: 'నేను బాగున్నాను, ధన్యవాదాలు! వరద ముప్పు, వర్షపాతం, హెచ్చరికలు, రక్షణ సలహాలు మరియు ప్రజా ఫిర్యాదులపై మీకు సహాయం చేయడానికి నేను ఇక్కడ ఉన్నాను. మీరు ఏమి తెలుసుకోవాలనుకుంటున్నారు?',
    hi: 'मैं ठीक हूँ, धन्यवाद! मैं बाढ़ जोखिम, वर्षा, चेतावनियों, सुरक्षा सलाह और नागरिक रिपोर्ट्स में आपकी मदद के लिए यहाँ हूँ। आप क्या जानना चाहेंगे?',
  },
  INTRODUCTION: {
    en: 'NeerDrishti is an urban flood intelligence and early-warning platform designed to help people understand flood risks across Telangana.',
    te: 'నీర్ దృష్టి అనేది తెలంగాణలోని 33 జిల్లాల్లో వరద ముప్పును అర్థం చేసుకోవడానికి సహాయపడే పట్టణ వరద ఇంటెలిజెన్స్ మరియు ముందస్తు హెచ్చరిక వేదిక.',
    hi: 'नीरदृष्टि एक शहरी बाढ़ सूचना और पूर्व-चेतावनी मंच है, जो तेलंगाना के 33 जिलों में बाढ़ जोखिम को समझने में लोगों की मदद करता है।',
  },
  GRATITUDE: {
    en: "You're welcome! Stay safe. I'm here whenever you need help.",
    te: 'ఖచ్చితంగా! సురక్షితంగా ఉండండి. మీకు సహాయం కావాల్సినప్పుడల్లా నేను ఇక్కడ ఉన్నాను.',
    hi: 'आपका स्वागत है! सुरक्षित रहें। जब भी आपको मदद चाहिए, मैं यहीं हूँ।',
  },
  GENERAL_CONVERSATION: {
    en: "I'm here and happy to chat. I can explain NeerDrishti, check district flood risk, summarize rainfall information, explain alerts, and share safety guidance.",
    te: 'నేను ఇక్కడ ఉన్నాను, మీతో మాట్లాడటం సంతోషం. నీర్ దృష్టి గురించి వివరించడం, జిల్లా వరద ముప్పు తనిఖీ చేయడం, వర్షపాత సమాచారం సంక్షిప్తీకరించడం, హెచ్చరికలు వివరించడం మరియు రక్షణ సలహాలు ఇవ్వడం నాకు సాధ్యం.',
    hi: 'मैं यहाँ हूँ और बात करने में खुशी होगी। मैं नीरदृष्टि समझा सकता हूँ, जिले का बाढ़ जोखिम देख सकता हूँ, वर्षा की जानकारी संक्षेप में दे सकता हूँ, अलर्ट समझा सकता हूँ और सुरक्षा सलाह दे सकता हूँ।',
  },
  GENERAL_KNOWLEDGE: {
    en: "I focus on NeerDrishti and flood-related questions, so I may not have a reliable answer for that topic. I can still help with district risk, rainfall, alerts, safety steps, and citizen reports.",
    te: 'నేను నీర్ దృష్టి మరియు వరద సంబంధిత ప్రశ్నలపై దృష్టి పెడతాను, కాబట్టి ఆ అంశంపై నాకు నమ్మకమైన సమాధానం ఉండకపోవచ్చు. జిల్లా ముప్పు, వర్షపాతం, హెచ్చరికలు, రక్షణ చర్యలు మరియు ప్రజా ఫిర్యాదులపై నేను సహాయం చేయగలను.',
    hi: 'मैं नीरदृष्टि और बाढ़ से जुड़े प्रश्नों पर ध्यान देता हूँ, इसलिए उस विषय पर मेरा विश्वसनीय उत्तर नहीं हो सकता। मैं जिले का जोखिम, वर्षा, अलर्ट, सुरक्षा कदम और नागरिक रिपोर्ट्स में मदद कर सकता हूँ।',
  },
};

const FOLLOW_UP_PATTERN = /\b(its|it|there|that|same|about|rainfall|rain|risk|dangerous|danger|safe|safety|alert|report|water|level|forecast|situation|status|how|what|why)\b/i;

export class ConversationStore {
  private sessions = new Map<string, ConversationSession>();

  public resolve(conversationId: string | undefined, ownerKey: string): string {
    this.prune();
    if (conversationId && UUID_PATTERN.test(conversationId)) {
      const session = this.sessions.get(conversationId);
      if (session && session.ownerKey === ownerKey) {
        session.lastSeen = Date.now();
        return conversationId;
      }
    }
    const id = randomUUID();
    this.sessions.set(id, { ownerKey, turns: [], lastSeen: Date.now() });
    return id;
  }

  public getTurns(conversationId: string, ownerKey: string): ConversationTurn[] {
    const session = this.sessions.get(conversationId);
    if (!session || session.ownerKey !== ownerKey) return [];
    session.lastSeen = Date.now();
    return session.turns.map(t => ({ ...t }));
  }

  public append(conversationId: string, ownerKey: string, turn: ConversationTurn): void {
    const session = this.sessions.get(conversationId);
    if (!session || session.ownerKey !== ownerKey) return;
    session.turns.push(turn);
    if (session.turns.length > MAX_TURNS) {
      session.turns = session.turns.slice(-MAX_TURNS);
    }
    session.lastSeen = Date.now();
  }

  public clear(conversationId: string, ownerKey: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session || session.ownerKey !== ownerKey) return false;
    this.sessions.delete(conversationId);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) this.sessions.delete(id);
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = Array.from(this.sessions.entries()).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (!oldest) return;
      this.sessions.delete(oldest[0]);
    }
  }
}

export const conversationStore = new ConversationStore();

export function resolveConversationContext(message: string, turns: ConversationTurn[]): string | undefined {
  const direct = intentService.extractDistricts(message);
  if (direct.length > 0) return direct[0];
  const previous = [...turns].reverse().find(t => t.districtId)?.districtId;
  if (!previous) return undefined;
  const text = `${message} ${/[\u0C00-\u0C7F\u0900-\u097F]/.test(message) ? message : message.toLowerCase()}`;
  const followUp = FOLLOW_UP_PATTERN.test(message) ||
    /ఇది|దీని|అది|అక్కడ|వర్షం|ముప్పు|అలర్ట్|రక్షణ|ఎలా|ఏమి/.test(text) ||
    /इस|उस|वहाँ|बारिश|जोखिम|खतरा|सुरक्षा|क्या|कैसे/.test(text);
  return followUp ? previous : undefined;
}

export function localConversationReply(intent: UserQuestionIntent, language: ConversationLanguage): string | undefined {
  if (intent in LOCAL_REPLIES) {
    return LOCAL_REPLIES[intent as keyof typeof LOCAL_REPLIES][language];
  }
  return undefined;
}

export function validateChatRequest(body: any): { ok: true; message: string; language: ConversationLanguage; districtContext?: string; conversationId?: string } | { ok: false; error: string; status: number } {
  const input = body && typeof body === 'object' ? body : {};
  if (typeof input.message !== 'string') return { ok: false, error: 'Field "message" must be a string.', status: 400 };
  const message = input.message.trim();
  if (!message) return { ok: false, error: 'Please type a message.', status: 400 };
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: `Message is too long. Please use ${MAX_MESSAGE_CHARS} characters or fewer.`, status: 400 };
  const language: ConversationLanguage = ['en', 'te', 'hi'].includes(input.language) ? input.language : 'en';
  const districtContext = typeof input.districtContext === 'string' && input.districtContext.trim().length <= 100
    ? input.districtContext.trim() || undefined
    : undefined;
  const conversationId = typeof input.conversationId === 'string' && input.conversationId.length <= 100
    ? input.conversationId
    : undefined;
  return { ok: true, message, language, districtContext, conversationId };
}

function effectiveLanguage(message: string, requested: ConversationLanguage): ConversationLanguage {
  const detected = intentService.detectLanguage(message);
  return detected === 'en' ? requested : detected;
}

function localResponse(intent: UserQuestionIntent, language: ConversationLanguage, conversationId: string): GroundedAIResponse {
  const reply = localConversationReply(intent, language) || LOCAL_REPLIES.GENERAL_KNOWLEDGE[language];
  return {
    answer: reply,
    directAnswer: reply,
    mainFactors: [],
    recommendedPrecautions: [],
    dataMode: 'Not Applicable',
    confidence: 'Not Applicable',
    limitations: 'Live AI generation was not needed for this conversational reply.',
    evidenceUsed: [],
    transparencyBadges: ['Local Conversation', 'No Live Flood Data Used'],
    intent,
    districtsInvolved: [],
    isSimulated: false,
    isPrototype: false,
    source: 'Local Conversation',
    timestamp: new Date().toISOString(),
    conversationId,
    aiUnavailable: false,
    providerNote: 'Local conversational response.',
  };
}

type FloodAnswer = (
  query: string,
  language?: ConversationLanguage,
  districtContext?: string,
  allDistricts?: DistrictStatus[],
  history?: ConversationTurn[]
) => Promise<GroundedAIResponse>;

export async function answerConversation(
  request: { message: string; language: ConversationLanguage; districtContext?: string; conversationId?: string; ownerKey: string; allDistricts: DistrictStatus[] },
  floodAnswer: FloodAnswer = aiIntelligenceService.answer_question.bind(aiIntelligenceService)
): Promise<{ response: GroundedAIResponse; conversationId: string }> {
  const conversationId = conversationStore.resolve(request.conversationId, request.ownerKey);
  const turns = conversationStore.getTurns(conversationId, request.ownerKey);
  const language = effectiveLanguage(request.message, request.language);
  const detected = intentService.detectIntent(request.message, request.districtContext);
  const contextDistrictId = resolveConversationContext(request.message, turns);
  const districtContext = request.districtContext || contextDistrictId;
  const now = new Date().toISOString();

  conversationStore.append(conversationId, request.ownerKey, {
    role: 'user',
    content: request.message.slice(0, MAX_MESSAGE_CHARS),
    districtId: districtContext,
    createdAt: now,
  });

  let response: GroundedAIResponse;
  if (FLOOD_INTENTS.has(detected.intent)) {
    response = await floodAnswer(request.message, language, districtContext, request.allDistricts, turns);
    if (response.source !== 'Meta Llama') {
      response.aiUnavailable = true;
      response.providerNote = 'Live AI generation is unavailable; a local grounded response was used.';
      response.transparencyBadges = [...(response.transparencyBadges || []), 'Live AI Unavailable'];
    }
  } else {
    response = localResponse(detected.intent, language, conversationId);
  }

  response.conversationId = conversationId;
  conversationStore.append(conversationId, request.ownerKey, {
    role: 'assistant',
    content: response.answer.slice(0, MAX_MESSAGE_CHARS),
    districtId: response.districtsInvolved[0] ? districtContext : undefined,
    createdAt: new Date().toISOString(),
  });
  return { response, conversationId };
}
