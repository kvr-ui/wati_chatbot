import { config, contactKey } from './config.js';
import { handovers as handoversCollection } from './mongo.js';

/**
 * Human handover pauses.
 *
 * After a lead asks for a person the bot stays silent for HANDOVER_PAUSE_MINUTES
 * so an agent can take the chat. The pause used to live on the in-memory session,
 * which is dropped after SESSION_TTL_MINUTES of silence and on every restart - so
 * a lead who went quiet for half an hour, or a redeploy, put the bot back into a
 * chat an agent was handling. It is kept here instead, apart from the session,
 * and mirrored to MongoDB.
 */
const pausedUntil = new Map(); // contact key -> ms
let loaded = false;

async function save(key, until) {
  try {
    const collection = await handoversCollection();
    if (until) {
      await collection.updateOne(
        { waId: key },
        { $set: { waId: key, pausedUntil: new Date(until), updatedAt: new Date() } },
        { upsert: true }
      );
    } else {
      await collection.deleteOne({ waId: key });
    }
  } catch (err) {
    console.error('handover save failed:', err.message);
  }
}

/** Pauses the bot for this contact, starting now. */
export async function pauseForHandover(waId) {
  const key = contactKey(waId);
  if (!key) return;
  const until = Date.now() + config.bot.handoverPauseMs;
  pausedUntil.set(key, until);
  await save(key, until);
}

/**
 * Is a human handling this chat? Memory is complete once {@link loadHandovers}
 * has run; before that the database is asked. A failed lookup answers "no": a
 * bot reply in an agent's chat is a nuisance, silence towards a lead is a lost sale.
 */
export async function isPaused(waId) {
  const key = contactKey(waId);
  if (!key) return false;
  if (pausedUntil.has(key) || loaded) return (pausedUntil.get(key) ?? 0) > Date.now();

  try {
    const doc = await (await handoversCollection()).findOne({ waId: key });
    const until = doc ? new Date(doc.pausedUntil).getTime() : 0;
    pausedUntil.set(key, until);
    return until > Date.now();
  } catch (err) {
    console.error('handover lookup failed:', err.message);
    return false;
  }
}

/** The lead asked for the bot back, or a tester reset the chat. */
export async function resume(waId) {
  const key = contactKey(waId);
  if (!key) return;
  pausedUntil.set(key, 0);
  await save(key, 0);
}

/**
 * An agent is still writing in this chat: push the pause out again so the bot
 * does not come back mid-conversation. Only extends a pause that is running -
 * outgoing messages to anyone else, the bot's own included, change nothing.
 */
export async function extendHandover(waId) {
  if (!(await isPaused(waId))) return false;
  await pauseForHandover(waId);
  return true;
}

/** Warms the cache at boot; returns how many chats are with an agent right now. */
export async function loadHandovers() {
  try {
    const docs = await (await handoversCollection()).find({}).toArray();
    for (const doc of docs) pausedUntil.set(doc.waId, new Date(doc.pausedUntil).getTime());
    loaded = true;
  } catch (err) {
    console.error('handover load failed:', err.message);
  }
  return [...pausedUntil.values()].filter((until) => until > Date.now()).length;
}
