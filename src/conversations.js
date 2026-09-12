import { config } from './config.js';
import { openDatabase } from './db.js';

/**
 * Durable conversation log.
 *
 * Every turn is stored raw and verbatim. Scores are *derived* from those turns
 * and recomputed on demand, so the scoring rules below can change at any time
 * without losing or corrupting history - the messages table is the source of
 * truth, and the leads table is a cache you can always rebuild.
 */

const db = openDatabase(config.conversations.dbFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL,
    name TEXT,
    channel TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    trigger_id TEXT,
    reason TEXT,
    provider TEXT,
    model TEXT,
    sources TEXT,
    elapsed_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages (wa_id, id);

  CREATE TABLE IF NOT EXISTS leads (
    wa_id TEXT PRIMARY KEY,
    name TEXT,
    channel TEXT NOT NULL,
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    user_messages INTEGER NOT NULL DEFAULT 0,
    signals TEXT NOT NULL DEFAULT '[]',
    score INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'new',
    handover INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_leads_score ON leads (score DESC);
`);

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

const insertMessage = db.prepare(`
  INSERT INTO messages (wa_id, name, channel, role, text, trigger_id, reason, provider, model, sources, elapsed_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Records one exchange: what the lead asked and what the bot answered.
 * Never throws into the caller - losing a reply because logging failed would
 * be a far worse outcome than losing the log line.
 */
export function logTurn({ waId, name, channel = 'whatsapp', text, replies = [], meta = {}, elapsedMs = null }) {
  try {
    const triggerId = meta.trigger ?? null;

    insertMessage.run(waId, name ?? null, channel, 'user', text, triggerId, meta.reason ?? null, null, null, null, null);
    for (const reply of replies) {
      insertMessage.run(
        waId, name ?? null, channel, 'assistant', reply, triggerId, meta.reason ?? null,
        meta.provider ?? null, meta.model ?? null,
        meta.sources ? JSON.stringify(meta.sources) : null,
        elapsedMs
      );
    }

    updateLead({ waId, name, channel, triggerId, handover: Boolean(meta.handover) });
  } catch (err) {
    console.error('conversation log failed:', err.message);
  }
}

function updateLead({ waId, name, channel, triggerId, handover }) {
  const existing = db.prepare('SELECT * FROM leads WHERE wa_id = ?').get(waId);

  const signals = new Set(existing ? JSON.parse(existing.signals) : []);
  if (triggerId && SIGNALS[triggerId]) signals.add(triggerId);

  const userMessages = (existing?.user_messages ?? 0) + 1;
  const list = [...signals];
  const score = scoreLead({ signals: list, userMessages });
  const hadHandover = Boolean(existing?.handover) || handover;

  if (existing) {
    db.prepare(`
      UPDATE leads SET name = COALESCE(?, name), last_seen = datetime('now'), user_messages = ?,
        signals = ?, score = ?, stage = ?, handover = ?
      WHERE wa_id = ?
    `).run(name ?? null, userMessages, JSON.stringify(list), score, stageFor(score), hadHandover ? 1 : 0, waId);
  } else {
    db.prepare(`
      INSERT INTO leads (wa_id, name, channel, user_messages, signals, score, stage, handover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(waId, name ?? null, channel, userMessages, JSON.stringify(list), score, stageFor(score), hadHandover ? 1 : 0);
  }
}

/* ------------------------------- reading ------------------------------- */

const leadRow = (r) => ({
  waId: r.wa_id,
  name: r.name,
  channel: r.channel,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  userMessages: Number(r.user_messages),
  signals: JSON.parse(r.signals).map((id) => ({ id, label: SIGNALS[id]?.label ?? id })),
  score: Number(r.score),
  stage: r.stage,
  handover: Boolean(r.handover),
});

const messageRow = (r) => ({
  id: Number(r.id),
  role: r.role,
  text: r.text,
  trigger: r.trigger_id,
  reason: r.reason,
  provider: r.provider,
  model: r.model,
  sources: r.sources ? JSON.parse(r.sources) : null,
  elapsedMs: r.elapsed_ms,
  createdAt: r.created_at,
});

export function listLeads({ limit = 100, channel, stage } = {}) {
  const where = [];
  const args = [];
  if (channel) (where.push('channel = ?'), args.push(channel));
  if (stage) (where.push('stage = ?'), args.push(stage));
  const sql = `SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY score DESC, last_seen DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(leadRow);
}

export function getLead(waId) {
  const lead = db.prepare('SELECT * FROM leads WHERE wa_id = ?').get(waId);
  if (!lead) return null;
  const messages = db.prepare('SELECT * FROM messages WHERE wa_id = ? ORDER BY id').all(waId);
  return { ...leadRow(lead), messages: messages.map(messageRow) };
}

export function conversationStats() {
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM leads) AS leads,
           (SELECT COUNT(*) FROM leads WHERE stage = 'hot') AS hot
  `).get();
  return { messages: Number(totals.messages), leads: Number(totals.leads), hotLeads: Number(totals.hot) };
}

/** Recompute every score from the stored turns - safe to run after changing SIGNALS. */
export function rescoreAll() {
  const leads = db.prepare('SELECT wa_id FROM leads').all();
  for (const { wa_id: waId } of leads) {
    const rows = db.prepare(
      "SELECT DISTINCT trigger_id FROM messages WHERE wa_id = ? AND role = 'user' AND trigger_id IS NOT NULL"
    ).all(waId);
    const signals = rows.map((r) => r.trigger_id).filter((id) => SIGNALS[id]);
    const { c: userMessages } = db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE wa_id = ? AND role = 'user'"
    ).get(waId);
    const score = scoreLead({ signals, userMessages: Number(userMessages) });
    db.prepare('UPDATE leads SET signals = ?, score = ?, stage = ?, user_messages = ? WHERE wa_id = ?')
      .run(JSON.stringify(signals), score, stageFor(score), Number(userMessages), waId);
  }
  return listLeads({ limit: 1000 });
}

/* ------------------------------ exporting ------------------------------ */

/**
 * Conversations as JSONL in chat fine-tuning format - one training example per
 * lead. Defaults to real WhatsApp chats only; preview traffic is your own
 * testing and would teach the model your test phrasing.
 */
export function exportTrainingJsonl({ channel = 'whatsapp', minTurns = 2 } = {}) {
  const leads = db.prepare('SELECT wa_id FROM leads WHERE channel = ?').all(channel);
  const lines = [];

  for (const { wa_id: waId } of leads) {
    const rows = db.prepare('SELECT role, text FROM messages WHERE wa_id = ? ORDER BY id').all(waId);
    if (rows.length < minTurns) continue;
    lines.push(JSON.stringify({
      messages: rows.map((r) => ({ role: r.role, content: r.text })),
    }));
  }
  return lines.join('\n');
}

const csvCell = (v) => {
  const s = String(v ?? '');
  // Guard against spreadsheet formula injection from attacker-controlled names.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function exportLeadsCsv({ channel } = {}) {
  const leads = listLeads({ limit: 10000, channel });
  const header = ['wa_id', 'name', 'score', 'stage', 'user_messages', 'signals', 'handover', 'first_seen', 'last_seen'];
  const rows = leads.map((l) => [
    l.waId, l.name, l.score, l.stage, l.userMessages,
    l.signals.map((s) => s.label).join('; '), l.handover ? 'yes' : 'no', l.firstSeen, l.lastSeen,
  ].map(csvCell).join(','));
  return [header.join(','), ...rows].join('\n');
}
