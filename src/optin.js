import { config, normalizeWaId } from './config.js';
import { optins as optinsCollection } from './mongo.js';

/**
 * Campaign opt-ins.
 *
 * While WHATSAPP_ALLOWED_NUMBERS is set the bot ignores every contact that is
 * not on that list. A lead who sends the campaign phrase (WHATSAPP_UNLOCK_PHRASE
 * - the "Jan 2027" ad message) opts *itself* in: from that message on the bot
 * answers that one number, and still nobody else.
 *
 * Kept in a Set for the hot path and mirrored to MongoDB, so a restart does not
 * drop a lead halfway through a conversation.
 */
const optedIn = new Set();

/** Lowercase and punctuation-free, so "Jan-2027!" and "JAN  2027" match alike. */
const normalize = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** True when a message carries one of the configured campaign phrases. */
export function matchesUnlockPhrase(text) {
  const haystack = normalize(text);
  if (!haystack) return false;
  return config.whatsappUnlockPhrases
    .map(normalize)
    .filter(Boolean)
    .some((phrase) => haystack.includes(phrase));
}

/**
 * Has this number already opted in? Checks memory first, then the database for
 * opt-ins made before the last restart.
 *
 * Fails closed: if the database cannot be reached the number stays locked
 * rather than being guessed into the allowlist.
 */
export async function isOptedIn(waId) {
  const id = normalizeWaId(waId);
  if (!id) return false;
  if (optedIn.has(id)) return true;

  try {
    const found = await (await optinsCollection()).findOne({ waId: id });
    if (found) optedIn.add(id);
    return Boolean(found);
  } catch (err) {
    console.error('opt-in lookup failed:', err.message);
    return false;
  }
}

/**
 * Records one lead's opt-in. Memory is updated first so the message that
 * triggered it is still answered when the database is unavailable.
 */
export async function optIn(waId, { name = null, text = '' } = {}) {
  const id = normalizeWaId(waId);
  if (!id) return false;
  optedIn.add(id);

  try {
    await (await optinsCollection()).updateOne(
      { waId: id },
      { $setOnInsert: { waId: id, name, text, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('opt-in save failed:', err.message);
  }
  return true;
}

/** Warms the cache at boot; returns how many leads have opted in. */
export async function loadOptIns() {
  try {
    const docs = await (await optinsCollection()).find({}, { projection: { waId: 1 } }).toArray();
    for (const doc of docs) optedIn.add(doc.waId);
  } catch (err) {
    console.error('opt-in load failed:', err.message);
  }
  return optedIn.size;
}

export const optInCount = () => optedIn.size;
