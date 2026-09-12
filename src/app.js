import express from 'express';
import path from 'node:path';
import { config, assertConfig, normalizeWaId } from './config.js';
import { handleMessage } from './handler.js';
import { sendSessionMessage } from './wati.js';
import { ensureIndex, indexStats, buildChunks } from './kb.js';
import { isNewMessage, deleteSession, stats as sessionStats } from './sessions.js';
import { matchTrigger, listTriggerIds } from './keywords.js';
import { listFeedback, saveFeedback } from './feedback.js';
import {
  listLeads, getLead, conversationStats, rescoreAll, exportTrainingJsonl, exportLeadsCsv,
} from './conversations.js';

if (config.whatsappEnabled) assertConfig();

export const app = express();
app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.static(path.join(config.root, 'public')));

const log = (...args) => console.log(new Date().toISOString(), ...args);

/* --------------------------- webhook payload --------------------------- */

/** Normalises a WATI webhook body into { waId, name, text, type, messageId }. */
function parseWatiEvent(body = {}) {
  const eventType = body.eventType || body.type;
  const isIncoming = body.owner === false || body.owner === 'false';

  // WATI fires many event types; only inbound customer messages should reach the bot.
  if (eventType !== 'message' || !isIncoming) {
    return { skip: true, reason: `ignored event: ${eventType} owner=${body.owner}` };
  }

  const text =
    body.text ??
    body.listReply?.title ??
    body.replyButtonReply?.title ??
    body.interactiveButtonReply?.title ??
    body.buttonReply?.text ??
    '';

  return {
    skip: false,
    waId: body.waId || body.whatsappNumber,
    name: body.senderName || body.name,
    text: String(text).trim(),
    type: body.type === 'text' || body.listReply || body.replyButtonReply ? 'text' : body.type,
    messageId: body.id || body.whatsappMessageId,
  };
}

/**
 * During testing on a live WATI account the allowlist keeps the bot off real
 * customer chats. An empty list means "reply to everyone".
 */
function isAllowed(waId) {
  const allowed = config.whatsappAllowedNumbers;
  return allowed.size === 0 || allowed.has(normalizeWaId(waId));
}

async function processEvent(event) {
  const { replies, meta } = await handleMessage(event);
  log(`<- ${event.waId} "${event.text}"`, JSON.stringify(meta));

  for (const reply of replies) {
    await sendSessionMessage(event.waId, reply);
    log(`-> ${event.waId} "${reply.slice(0, 80)}"`);
  }
}

/* ------------------------------- routes -------------------------------- */

app.post('/webhook/wati', (req, res) => {
  if (!config.whatsappEnabled) {
    return res.status(503).json({ ok: false, error: 'WhatsApp is disabled during browser testing.' });
  }
  if (config.webhookVerifyToken && req.query.token !== config.webhookVerifyToken) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }

  // Acknowledge immediately - WATI retries on slow responses.
  res.status(200).json({ ok: true });

  const event = parseWatiEvent(req.body);
  if (event.skip) return log('skip:', event.reason);
  if (!event.waId || !event.text) return log('skip: missing waId or text');
  if (!isAllowed(event.waId)) return log(`skip: ${event.waId} not in WHATSAPP_ALLOWED_NUMBERS`);
  if (!isNewMessage(event.messageId)) return log('skip: duplicate', event.messageId);

  processEvent(event).catch(async (err) => {
    console.error('handler error:', err);
    try {
      await sendSessionMessage(
        event.waId,
        'Sorry, something went wrong on our side. Please try again in a moment.'
      );
    } catch (sendErr) {
      console.error('failed to send error notice:', sendErr.message);
    }
  });
});

app.get('/health', async (_req, res) => {
  // Health must still answer when the database is down - that is when it matters.
  const conversations = await conversationStats().catch((err) => ({ error: err.message }));
  res.json({
    ok: true,
    provider: config.ai.provider,
    model: config.ai.provider === 'openai' ? config.openai.chatModel : config.anthropic.model,
    aiConfigured: Boolean(config.ai.provider === 'openai' ? config.openai.apiKey : config.anthropic.apiKey),
    botName: config.bot.name,
    whatsappEnabled: config.whatsappEnabled,
    whatsappAllowedNumbers: [...config.whatsappAllowedNumbers],
    kb: indexStats(),
    triggers: listTriggerIds().length,
    conversations,
    ...sessionStats(),
  });
});

const busySessions = new Set();
const validSession = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function publicError(err) {
  if (err.status === 401) return 'OpenAI rejected the API key. Update OPENAI_API_KEY in .env and restart the server.';
  if (err.status === 429) return 'OpenAI usage or rate limit reached. Check API billing, or try again shortly.';
  if (err.status === 403 || err.status === 404) return 'The configured AI model is unavailable. Check the model and API access in .env.';
  if (/^Set (OPENAI|ANTHROPIC)_API_KEY/.test(err.message)) return err.message;
  return 'The AI service could not answer. Check your connection and model settings, then try again.';
}

/** Browser sessions are namespaced separately from all WhatsApp contacts. */
app.post(['/api/chat', '/simulate'], async (req, res) => {
  const { sessionId, waId, name = 'Tester', text, provider } = req.body || {};
  const id = sessionId ?? waId ?? 'test-user';
  if (!validSession(id) || typeof text !== 'string' || !text.trim() || text.length > 4000 ||
      typeof name !== 'string' || name.length > 100 ||
      (provider !== undefined && !['openai', 'claude'].includes(provider))) {
    return res.status(400).json({ error: 'Send a message of 1–4,000 characters with a valid session ID.' });
  }
  if (busySessions.has(id)) return res.status(409).json({ error: 'Wait for the current reply before sending another message.' });
  busySessions.add(id);
  try {
    const started = Date.now();
    const result = await handleMessage({ waId: `preview:${id}`, name, text: text.trim(), provider });
    res.json({ ...result, elapsedMs: Date.now() - started });
  } catch (err) {
    res.status(502).json({ error: publicError(err) });
  } finally {
    busySessions.delete(id);
  }
});

app.delete('/api/chat/:sessionId', (req, res) => {
  const id = req.params.sessionId;
  if (!validSession(id)) return res.status(400).json({ error: 'Invalid session ID.' });
  if (busySessions.has(id)) return res.status(409).json({ error: 'Wait for the current reply before starting a new chat.' });
  deleteSession(`preview:${id}`);
  res.json({ ok: true });
});

/* ------------------------------- leads --------------------------------- */

const STAGES = new Set(['hot', 'warm', 'cold', 'new']);
const CHANNELS = new Set(['whatsapp', 'preview']);

/** The database is a separate service now; a query failure must not crash the server. */
const dbError = (res) => res.status(503).json({ error: 'Lead database is unavailable. Check that MongoDB is running.' });

app.get('/api/leads', async (req, res) => {
  const { channel, stage } = req.query;
  if ((channel && !CHANNELS.has(channel)) || (stage && !STAGES.has(stage))) {
    return res.status(400).json({ error: 'Invalid channel or stage filter.' });
  }
  const requested = Number(req.query.limit ?? 100);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 1000) : 100;
  try {
    const [leads, stats] = await Promise.all([listLeads({ limit, channel, stage }), conversationStats()]);
    res.json({ leads, stats });
  } catch (err) {
    console.error('leads query failed:', err.message);
    dbError(res);
  }
});

app.get('/api/leads/:waId', async (req, res) => {
  try {
    const lead = await getLead(req.params.waId);
    if (!lead) return res.status(404).json({ error: 'No conversation recorded for that number.' });
    res.json({ lead });
  } catch (err) {
    console.error('lead query failed:', err.message);
    dbError(res);
  }
});

app.post('/api/leads/rescore', async (_req, res) => {
  try {
    res.json({ ok: true, leads: await rescoreAll() });
  } catch (err) {
    console.error('rescore failed:', err.message);
    dbError(res);
  }
});

app.get('/api/export/leads.csv', async (req, res) => {
  const { channel } = req.query;
  if (channel && !CHANNELS.has(channel)) return res.status(400).json({ error: 'Invalid channel filter.' });
  try {
    res.type('text/csv').attachment('leads.csv').send(await exportLeadsCsv({ channel }));
  } catch (err) {
    console.error('csv export failed:', err.message);
    dbError(res);
  }
});

app.get('/api/export/training.jsonl', async (req, res) => {
  const channel = req.query.channel ?? 'whatsapp';
  if (!CHANNELS.has(channel)) return res.status(400).json({ error: 'Invalid channel filter.' });
  const requested = Number(req.query.minTurns ?? 2);
  const minTurns = Number.isInteger(requested) && requested > 0 ? requested : 2;
  try {
    res.type('application/jsonl').attachment('training.jsonl').send(await exportTrainingJsonl({ channel, minTurns }));
  } catch (err) {
    console.error('training export failed:', err.message);
    dbError(res);
  }
});

app.get('/api/feedback', async (req, res) => {
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50;
  try {
    res.json({ reviews: await listFeedback(limit) });
  } catch (err) {
    console.error('feedback query failed:', err.message);
    dbError(res);
  }
});

app.post('/api/feedback', async (req, res) => {
  const { sessionId, reviewer = 'Test team', content } = req.body || {};
  if (!validSession(sessionId) || typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 100 ||
      typeof content !== 'string' || !content.trim() || content.length > 4000) {
    return res.status(400).json({ error: 'Add a review of 1–4,000 characters and a valid tester name.' });
  }

  try {
    const review = await saveFeedback({
      sessionId,
      reviewer: reviewer.trim(),
      content: content.trim(),
    });
    res.status(201).json({ review });
  } catch (err) {
    console.error('feedback save failed:', err.message);
    dbError(res);
  }
});

app.get('/api/knowledge', (_req, res) => {
  const documents = new Map();
  for (const chunk of buildChunks()) {
    if (!documents.has(chunk.source)) documents.set(chunk.source, { source: chunk.source, title: chunk.section || chunk.source, text: '' });
    documents.get(chunk.source).text += `${chunk.text}\n\n`;
  }
  res.json({ documents: [...documents.values()] });
});

/** Check which trigger a phrase hits: GET /match?text=hello */
app.get('/match', (req, res) => {
  res.json({ text: req.query.text || '', trigger: matchTrigger(req.query.text || '') });
});

/** Re-embed the knowledge base after editing files in knowledge/. */
app.post('/reindex', async (_req, res) => {
  try {
    await ensureIndex({ force: true, log });
    res.json({ ok: true, kb: indexStats() });
  } catch (err) {
    res.status(502).json({ ok: false, error: publicError(err) });
  }
});

app.use((err, _req, res, _next) => {
  res.status(err.status === 413 ? 413 : 400).json({ error: 'Invalid request. Send a valid JSON message under 4,000 characters.' });
});
