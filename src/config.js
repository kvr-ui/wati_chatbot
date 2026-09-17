import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, fallback) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(String(v)));

/** "https://host/v1/chat/completions" -> "https://host/v1" (the SDK adds the path back). */
function normalizeOpenAiBase(url) {
  if (!url) return '';
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\/(chat\/)?completions$/i, '');
  return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

/** WhatsApp ids are bare digits with a country code; accept "+91 98…" style input too. */
export const normalizeWaId = (v) => String(v ?? '').replace(/\D/g, '');

const phraseList = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const digitList = (v) =>
  new Set(
    String(v || '')
      .split(',')
      .map(normalizeWaId)
      .filter(Boolean)
  );

export const config = {
  root,
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  whatsappEnabled: bool(process.env.WHATSAPP_ENABLED, false),
  // Safety net for a live WATI account: when non-empty, the bot answers only these
  // numbers and ignores everyone else. Leave blank to reply to all contacts.
  whatsappAllowedNumbers: digitList(process.env.WHATSAPP_ALLOWED_NUMBERS),
  // Campaign opt-in. A contact outside the allowlist that sends one of these
  // phrases (the "Jan 2027" or "Your Last Attempt" ad message) unlocks the bot for itself alone;
  // everybody else stays ignored. Set WHATSAPP_UNLOCK_PHRASE empty to disable
  // it and leave the allowlist as the only way in.
  whatsappUnlockPhrases: phraseList(process.env.WHATSAPP_UNLOCK_PHRASE ?? 'jan 2027, january 2027, your last attempt'),
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || process.env.WATI_WEBHOOK_TOKEN || '',

  wati: {
    // Accept the several names WATI's dashboard/docs use for the same two values.
    endpoint: (process.env.WATI_API_ENDPOINT || process.env.WATI_API_URL || '').replace(/\/+$/, ''),
    token: (process.env.WATI_ACCESS_TOKEN || process.env.WATI_API_TOKEN || process.env.WATI_TOKEN || '')
      .replace(/^Bearer\s+/i, '')
      .trim(),
  },

  // OpenAI answers every question and embeds the knowledge base.
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    // Set to use an OpenAI-compatible gateway instead of api.openai.com.
    baseUrl: normalizeOpenAiBase(process.env.OPENAI_BASE_URL),
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  },


  bot: {
    name: process.env.BOT_NAME || 'Assistant',
    aiFallbackEnabled: bool(process.env.AI_FALLBACK_ENABLED, true),
    fallbackMessage:
      process.env.FALLBACK_MESSAGE ||
      'Sorry, I did not understand that. Type *menu* to see what I can help with.',
    handoverMessage:
      process.env.HANDOVER_MESSAGE || 'Sure - connecting you to a human agent. Please wait a moment.',
    sessionTtlMs: num(process.env.SESSION_TTL_MINUTES, 30) * 60_000,
    handoverPauseMs: num(process.env.HANDOVER_PAUSE_MINUTES, 60) * 60_000,
  },

  kb: {
    searchMode: process.env.KB_SEARCH_MODE || 'auto',
    dir: path.join(root, 'knowledge'),
    keywordsFile: path.join(root, 'knowledge', 'keywords.json'),
    cacheFile: path.join(root, 'data', 'embeddings.json'),
    topK: num(process.env.KB_TOP_K, 6),
    minScore: num(process.env.KB_MIN_SCORE, 0.25),
    chunkSize: 900,
    chunkOverlap: 150,
  },

  // Every question and answer, tester feedback, and lead scores. Collections
  // are domain-prefixed to match the other FOCAS projects sharing this
  // database (vsl_leads, bigin_contacts).
  mongo: {
    uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
    dbName: process.env.MONGODB_DB_NAME || 'focas',
    messages: process.env.MONGODB_MESSAGES_COLLECTION || 'wati_messages',
    leads: process.env.MONGODB_LEADS_COLLECTION || 'wati_leads',
    feedback: process.env.MONGODB_FEEDBACK_COLLECTION || 'wati_feedback',
    optins: process.env.MONGODB_OPTINS_COLLECTION || 'wati_optins',
    optouts: process.env.MONGODB_OPTOUTS_COLLECTION || 'wati_optouts',
    campaign: process.env.MONGODB_CAMPAIGN_COLLECTION || 'wati_campaign',
  },
};

export function assertConfig({ requireWati = true } = {}) {
  const missing = [];
  if (!config.openai.apiKey) missing.push('OPENAI_API_KEY');
  if (requireWati && !config.wati.endpoint) missing.push('WATI_API_ENDPOINT');
  if (requireWati && !config.wati.token) missing.push('WATI_ACCESS_TOKEN');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }
}
