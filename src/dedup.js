import { webhookEvents as webhookEventsCollection } from './mongo.js';

/**
 * WATI retries a webhook it thinks went unanswered, and a retry that lands just
 * after a restart used to be answered a second time because the seen ids only
 * lived in memory. Ids are now also written to MongoDB (kept a week by a TTL
 * index), and the unique index makes the database the arbiter.
 */
const seen = new Map(); // messageId -> timestamp
const MEMORY_MS = 10 * 60_000;

/** True the first time a message id is seen. */
export async function isNewMessage(messageId) {
  if (!messageId) return true;
  const id = String(messageId);
  const now = Date.now();
  for (const [key, ts] of seen) {
    if (now - ts > MEMORY_MS) seen.delete(key);
  }
  if (seen.has(id)) return false;
  seen.set(id, now);

  try {
    await (await webhookEventsCollection()).insertOne({ messageId: id, createdAt: new Date(now) });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // already handled before the last restart
    // Database down: memory has already ruled out a retry within this process.
    console.error('webhook de-duplication save failed:', err.message);
    return true;
  }
}
