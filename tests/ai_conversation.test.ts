import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { intentService } from '../src/services/intent_service';
import {
  answerConversation,
  ConversationStore,
  ConversationTurn,
  localConversationReply,
  resolveConversationContext,
  validateChatRequest,
} from '../src/services/ai_conversation_service';
import { GroundedAIResponse } from '../src/types/ai';

const grounded = (answer: string, source: GroundedAIResponse['source'] = 'Deterministic Fallback'): GroundedAIResponse => ({
  answer,
  directAnswer: answer,
  mainFactors: [],
  recommendedPrecautions: [],
  dataMode: 'Simulated Data',
  confidence: 'Medium',
  limitations: 'SIMULATION DATA USED',
  evidenceUsed: [],
  transparencyBadges: ['⚡ SIMULATION DATA USED'],
  intent: 'DISTRICT_RISK',
  districtsInvolved: ['Warangal'],
  isSimulated: true,
  isPrototype: false,
  source,
  timestamp: new Date().toISOString(),
});

const owner = () => `test:${randomUUID()}`;

test('English greetings and informal spellings are recognized', () => {
  for (const message of ['Hi', 'Hello', 'Hlo', 'heyy', 'namaste', 'Hey!']) {
    assert.equal(intentService.detectIntent(message).intent, 'GREETING', message);
  }
});

test('Telugu and Hindi greetings are recognized and detected by script', () => {
  for (const message of ['నమస్తే', 'నమస్కారం', 'హలో']) {
    const result = intentService.detectIntent(message);
    assert.equal(result.intent, 'GREETING', message);
    assert.equal(result.language, 'te', message);
  }
  for (const message of ['नमस्ते', 'नमस्कार', 'हैलो']) {
    const result = intentService.detectIntent(message);
    assert.equal(result.intent, 'GREETING', message);
    assert.equal(result.language, 'hi', message);
  }
});

test('small talk, gratitude, identity and general conversation are recognized', () => {
  assert.equal(intentService.detectIntent('How are you?').intent, 'SMALL_TALK');
  assert.equal(intentService.detectIntent('what are you doing?').intent, 'SMALL_TALK');
  assert.equal(intentService.detectIntent('ఎలా ఉన్నారు?').intent, 'SMALL_TALK');
  assert.equal(intentService.detectIntent('कैसे हो?').intent, 'SMALL_TALK');
  assert.equal(intentService.detectIntent('Thank you').intent, 'GRATITUDE');
  assert.equal(intentService.detectIntent('ధన్యవాదాలు').intent, 'GRATITUDE');
  assert.equal(intentService.detectIntent('धन्यवाद').intent, 'GRATITUDE');
  assert.equal(intentService.detectIntent('Who are you?').intent, 'INTRODUCTION');
  assert.equal(intentService.detectIntent('What is NeerDrishti?').intent, 'INTRODUCTION');
  assert.equal(intentService.detectIntent('ok').intent, 'GENERAL_CONVERSATION');
});

test('non-flood general questions are not forced into a flood report', () => {
  assert.equal(intentService.detectIntent('What is the capital of France?').intent, 'GENERAL_KNOWLEDGE');
});

test('district and flood questions retain flood intents and district extraction', () => {
  const risk = intentService.detectIntent('Is there a flood risk in Warangal?');
  assert.equal(risk.intent, 'DISTRICT_RISK');
  assert.ok(risk.detectedDistricts.includes('warangal'));
  assert.equal(intentService.detectIntent('Explain the latest rainfall information').intent, 'DISTRICT_RISK');
  assert.equal(intentService.detectIntent('What should I do during flooding?').intent, 'SAFETY_GUIDANCE');
});

test('local conversational replies are natural and trilingual', () => {
  assert.match(localConversationReply('GREETING', 'en') || '', /Hello! Welcome to NeerDrishti/);
  assert.match(localConversationReply('GREETING', 'te') || '', /నమస్కారం/);
  assert.match(localConversationReply('GREETING', 'hi') || '', /नमस्ते/);
  assert.match(localConversationReply('SMALL_TALK', 'en') || '', /doing well/);
  assert.match(localConversationReply('INTRODUCTION', 'en') || '', /urban flood intelligence/);
  assert.match(localConversationReply('GRATITUDE', 'en') || '', /You're welcome/);
  assert.match(localConversationReply('GENERAL_KNOWLEDGE', 'en') || '', /focus on NeerDrishti/);
});

test('follow-up references resolve to the previous district', () => {
  const turns: ConversationTurn[] = [
    { role: 'user', content: 'Tell me about Warangal.', districtId: 'warangal', createdAt: new Date().toISOString() },
    { role: 'assistant', content: 'Warangal details.', districtId: 'warangal', createdAt: new Date().toISOString() },
  ];
  assert.equal(resolveConversationContext('What about its rainfall?', turns), 'warangal');
  assert.equal(resolveConversationContext('Is it dangerous?', turns), 'warangal');
  assert.equal(resolveConversationContext('Tell me about Nirmal.', turns), 'nirmal');
  assert.equal(resolveConversationContext('Hello', []), undefined);
});

test('conversation store isolates sessions and keeps history bounded', () => {
  const store = new ConversationStore();
  const a = store.resolve(undefined, 'user:a');
  const b = store.resolve(undefined, 'user:b');
  assert.notEqual(a, b);
  store.append(a, 'user:a', { role: 'user', content: 'private note', createdAt: new Date().toISOString() });
  assert.equal(store.getTurns(a, 'user:b').length, 0);
  assert.equal(store.clear(a, 'user:b'), false);
  assert.equal(store.getTurns(a, 'user:a')[0]?.content, 'private note');
  for (let i = 0; i < 20; i++) {
    store.append(a, 'user:a', { role: 'user', content: `message ${i}`, createdAt: new Date().toISOString() });
  }
  assert.equal(store.getTurns(a, 'user:a').length, 12);
  assert.equal(store.clear(a, 'user:a'), true);
  assert.equal(store.getTurns(a, 'user:a').length, 0);
});

test('chat request validation rejects empty, long and invalid messages', () => {
  assert.equal(validateChatRequest({}).ok, false);
  assert.equal(validateChatRequest({ message: '   ' }).ok, false);
  assert.equal(validateChatRequest({ message: 'a'.repeat(2001) }).ok, false);
  assert.equal(validateChatRequest({ message: 42 }).ok, false);
  const ok = validateChatRequest({ message: 'Hi', language: 'xx', districtContext: 'warangal' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.language, 'en');
});

test('greetings work locally without the AI provider and do not invent flood numbers', async () => {
  let calls = 0;
  const result = await answerConversation(
    { message: 'Hlo', language: 'en', ownerKey: owner(), allDistricts: [] },
    async () => { calls++; return grounded('unexpected'); }
  );
  assert.equal(calls, 0);
  assert.equal(result.response.source, 'Local Conversation');
  assert.match(result.response.answer, /Hello! Welcome to NeerDrishti/);
  assert.doesNotMatch(result.response.answer, /\d+/);
});

test('provider-unavailable flood answers disclose fallback and preserve simulated-data provenance', async () => {
  const result = await answerConversation(
    { message: 'Is there a flood risk in Warangal?', language: 'en', ownerKey: owner(), allDistricts: [] },
    async () => grounded('Warangal uses SIMULATION DATA USED and no official alert is invented.')
  );
  assert.equal(result.response.aiUnavailable, true);
  assert.equal(result.response.isSimulated, true);
  assert.equal(result.response.dataMode, 'Simulated Data');
  assert.ok(result.response.transparencyBadges.includes('Live AI Unavailable'));
  assert.match(result.response.providerNote || '', /Live AI generation is unavailable/);
});

test('flood follow-up passes the remembered district to the grounded service', async () => {
  const key = owner();
  const first = await answerConversation(
    { message: 'Tell me about Warangal.', language: 'en', ownerKey: key, allDistricts: [] },
    async () => grounded('Warangal details.')
  );
  let seenContext: string | undefined;
  const second = await answerConversation(
    { message: 'What about its rainfall?', language: 'en', ownerKey: key, conversationId: first.conversationId, allDistricts: [] },
    async (_query, _language, districtContext) => {
      seenContext = districtContext;
      return grounded('Rainfall details for Warangal.');
    }
  );
  assert.equal(seenContext, 'warangal');
  assert.ok(second.conversationId);
});
