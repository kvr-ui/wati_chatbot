import { messages as messagesCollection, leads as leadsCollection } from './mongo.js';

/**
 * Durable conversation log, stored in MongoDB.
 *
 * Every turn is stored raw and verbatim in `wati_messages`. Lead scores in
 * `wati_leads` are *derived* from those turns and recomputed on demand, so the
 * scoring rules below can change at any time without losing or corrupting
 * history - messages are the source of truth, leads are a cache you can always
 * rebuild with rescoreAll().
 */

/* ---------------------------- lead scoring ----------------------------- */

/**
 * Buying signals, keyed by the trigger the message matched. Points are
 * deliberately blunt: someone asking for a payment link is worth far more than
 * someone asking where the office is.
 */
export const SIGNALS = {
  payment_link: { points: 30, label: 'Asked for a payment link' },
  payment_status: { points: 25, label: 'Payment already in progress' },
  admission: { points: 20, label: 'Asked how to join' },
  human_handover: { points: 18, label: 'Asked for a human agent' },
  fees: { points: 14, label: 'Asked about fees' },
  kit: { points: 10, label: 'Asked about the kit' },
  brochure: { points: 10, label: 'Requested the brochure' },
  timings: { points: 10, label: 'Asked about timings' },
  courses: { points: 8, label: 'Asked about courses' },
  placement: { points: 8, label: 'Asked about placement' },
  objections: { points: 6, label: 'Raised an objection' },
  location: { points: 5, label: 'Asked about location' },
  contact: { points: 4, label: 'Asked for contact details' },
};

const ENGAGEMENT_CAP = 20;

/** Score 0-100 from the signals hit plus how far the conversation got. */
export function scoreLead({ signals = [], userMessages = 0 }) {
  const intent = signals.reduce((sum, id) => sum + (SIGNALS[id]?.points ?? 0), 0);
  const engagement = Math.min(ENGAGEMENT_CAP, Math.max(0, userMessages - 1) * 4);
  return Math.min(100, intent + engagement);
}

export const stageFor = (score) => (score >= 60 ? 'hot' : score >= 30 ? 'warm' : score > 0 ? 'cold' : 'new');

/* ------------------------------ recording ------------------------------ */

/**
 * Records one exchange: what the lead asked and what the bot answered.
 *
 * Never throws into the caller. A logging outage must not stop the bot
 * replying to a customer - losing a log line is far cheaper than losing a sale.
 */
export async function logTurn({ waId, name, channel = 'whatsapp', text, replies = [], meta = {}, elapsedMs = null }) {
  try {
    const triggerId = meta.trigger ?? null;
    const now = new Date();

    const docs = [{
      waId, name: name ?? null, channel, role: 'user', text,
      triggerId, reason: meta.reason ?? null,
      provider: null, model: null, sources: null, elapsedMs: null, createdAt: now,
    }];

    for (const reply of replies) {
      docs.push({
        waId, name: name ?? null, channel, role: 'assistant', text: reply,
        triggerId, reason: meta.reason ?? null,
        provider: meta.provider ?? null, model: meta.model ?? null,
        sources: meta.sources ?? null, elapsedMs, createdAt: now,
      });
    }

    await (await messagesCollection()).insertMany(docs);
    await updateLead({ waId, name, channel, triggerId, handover: Boolean(meta.handover), now });
  } catch (err) {
    console.error('conversation log failed:', err.message);
  }
}

async function updateLead({ waId, name, channel, triggerId, handover, now }) {
  const collection = await leadsCollection();
  const existing = await collection.findOne({ waId });

  const signals = new Set(existing?.signals ?? []);
  if (triggerId && SIGNALS[triggerId]) signals.add(triggerId);

  const list = [...signals];
  const userMessages = (existing?.userMessages ?? 0) + 1;
  const score = scoreLead({ signals: list, userMessages });

  await collection.updateOne(
    { waId },
    {
      $set: {
        ...(name ? { name } : {}),
        lastSeen: now,
        userMessages,
        signals: list,
        score,
        stage: stageFor(score),
        handover: Boolean(existing?.handover) || handover,
      },
      $setOnInsert: { waId, channel, firstSeen: now, ...(name ? {} : { name: null }) },
    },
    { upsert: true }
  );
}

/* ------------------------------- reading ------------------------------- */

const leadView = (doc) => ({
  waId: doc.waId,
  name: doc.name ?? null,
  channel: doc.channel,
  firstSeen: doc.firstSeen,
  lastSeen: doc.lastSeen,
  userMessages: doc.userMessages ?? 0,
  signals: (doc.signals ?? []).map((id) => ({ id, label: SIGNALS[id]?.label ?? id })),
  score: doc.score ?? 0,
  stage: doc.stage ?? 'new',
  handover: Boolean(doc.handover),
});

const messageView = (doc) => ({
  id: String(doc._id),
  role: doc.role,
  text: doc.text,
  trigger: doc.triggerId ?? null,
  reason: doc.reason ?? null,
  provider: doc.provider ?? null,
  model: doc.model ?? null,
  sources: doc.sources ?? null,
  elapsedMs: doc.elapsedMs ?? null,
  createdAt: doc.createdAt,
});

export async function listLeads({ limit = 100, channel, stage } = {}) {
  const filter = {};
  if (channel) filter.channel = channel;
  if (stage) filter.stage = stage;

  const docs = await (await leadsCollection())
    .find(filter).sort({ score: -1, lastSeen: -1 }).limit(limit).toArray();
  return docs.map(leadView);
}

export async function getLead(waId) {
  const lead = await (await leadsCollection()).findOne({ waId });
  if (!lead) return null;

  const docs = await (await messagesCollection()).find({ waId }).sort({ _id: 1 }).toArray();
  return { ...leadView(lead), messages: docs.map(messageView) };
}

export async function conversationStats() {
  const [messageCount, leadCount, hot] = await Promise.all([
    (await messagesCollection()).countDocuments(),
    (await leadsCollection()).countDocuments(),
    (await leadsCollection()).countDocuments({ stage: 'hot' }),
  ]);
  return { messages: messageCount, leads: leadCount, hotLeads: hot };
}

/** Recompute every score from the stored turns - safe to run after changing SIGNALS. */
export async function rescoreAll() {
  const messagesColl = await messagesCollection();
  const leadsColl = await leadsCollection();

  // One pass over user messages per lead, rather than two queries each.
  const summaries = await messagesColl.aggregate([
    { $match: { role: 'user' } },
    { $group: { _id: '$waId', userMessages: { $sum: 1 }, triggers: { $addToSet: '$triggerId' } } },
  ]).toArray();

  const writes = summaries.map(({ _id: waId, userMessages, triggers }) => {
    const signals = triggers.filter((id) => id && SIGNALS[id]);
    const score = scoreLead({ signals, userMessages });
    return {
      updateOne: {
        filter: { waId },
        update: { $set: { signals, score, stage: stageFor(score), userMessages } },
      },
    };
  });

  if (writes.length) await leadsColl.bulkWrite(writes);
  return listLeads({ limit: 1000 });
}

/* ------------------------------ exporting ------------------------------ */

/**
 * Conversations as JSONL in chat fine-tuning format - one training example per
 * lead. Defaults to real WhatsApp chats only; preview traffic is your own
 * testing and would teach the model your test phrasing.
 */
export async function exportTrainingJsonl({ channel = 'whatsapp', minTurns = 2 } = {}) {
  const grouped = await (await messagesCollection()).aggregate([
    { $match: { channel } },
    { $sort: { _id: 1 } },
    { $group: { _id: '$waId', messages: { $push: { role: '$role', content: '$text' } } } },
  ]).toArray();

  return grouped
    .filter((g) => g.messages.length >= minTurns)
    .map((g) => JSON.stringify({ messages: g.messages }))
    .join('\n');
}

const csvCell = (v) => {
  const s = v instanceof Date ? v.toISOString() : String(v ?? '');
  // Guard against spreadsheet formula injection from attacker-controlled names.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function exportLeadsCsv({ channel } = {}) {
  const rows = await listLeads({ limit: 10000, channel });
  const header = ['wa_id', 'name', 'score', 'stage', 'user_messages', 'signals', 'handover', 'first_seen', 'last_seen'];
  const body = rows.map((l) => [
    l.waId, l.name, l.score, l.stage, l.userMessages,
    l.signals.map((s) => s.label).join('; '), l.handover ? 'yes' : 'no', l.firstSeen, l.lastSeen,
  ].map(csvCell).join(','));
  return [header.join(','), ...body].join('\n');
}
