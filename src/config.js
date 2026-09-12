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

/** "https://host/v1/messages" -> "https://host" (the SDK adds the path back). */
function normalizeAnthropicBase(url) {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '').replace(/\/v1\/messages$/i, '').replace(/\/v1$/i, '');
}
const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

/** WhatsApp ids are bare digits with a country code; accept "+91 98…" style input too. */
export const normalizeWaId = (v) => String(v ?? '').replace(/\D/g, '');

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
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || process.env.WATI_WEBHOOK_TOKEN || '',

  wati: {
    // Accept the several names WATI's dashboard/docs use for the same two values.
    endpoint: (process.env.WATI_API_ENDPOINT || process.env.WATI_API_URL || '').replace(/\/+$/, ''),
    token: (process.env.WATI_ACCESS_TOKEN || process.env.WATI_API_TOKEN || process.env.WATI_TOKEN || '')
      .replace(/^Bearer\s+/i, '')
      .trim(),
  },

  // Which provider answers questions: 'claude' or 'openai'.
  ai: { provider: (process.env.AI_PROVIDER || 'openai').toLowerCase() },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    // Set to use an OpenAI-compatible gateway instead of api.openai.com.
    baseUrl: normalizeOpenAiBase(process.env.OPENAI_BASE_URL),
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    // Custom gateway support. The SDK appends "/v1/messages" itself, so accept a
    // full messages URL and reduce it to the origin.
    baseUrl: normalizeAnthropicBase(process.env.ANTHROPIC_BASE_URL),
    // 'x-api-key' (Anthropic default) or 'bearer' for gateways that want Authorization.
    authStyle: (process.env.ANTHROPIC_AUTH_STYLE || 'x-api-key').toLowerCase(),
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    effort: process.env.ANTHROPIC_EFFORT || 'low',
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

  feedback: {
    // Kept on this machine so testers can share notes without any hosted database.
    dbFile: process.env.FEEDBACK_DB_FILE || path.join(root, 'data', 'feedback.sqlite'),
  },

  conversations: {
    // Every question and answer, for lead scoring and future model training.
    dbFile: process.env.CONVERSATIONS_DB_FILE || path.join(root, 'data', 'conversations.sqlite'),
  },
};

export function assertConfig({ requireWati = true } = {}) {
  const missing = [];
  if (!config.anthropic.apiKey && !config.openai.apiKey) missing.push('ANTHROPIC_API_KEY (or OPENAI_API_KEY)');
  if (requireWati && !config.wati.endpoint) missing.push('WATI_API_ENDPOINT');
  if (requireWati && !config.wati.token) missing.push('WATI_ACCESS_TOKEN');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }
}
