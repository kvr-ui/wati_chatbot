import { config, normalizeWaId } from './config.js';
import { optins as optinsCollection } from './mongo.js';

/**
 * Campaign opt-ins.
 *
 * While WHATSAPP_ALLOWED_NUMBERS is set the bot ignores every contact that is
 * not on that list. A lead who sends the campaign phrase (WHATSAPP_UNLOCK_PHRASE
 * - the "Jan 2027" ad message) opts *itself* in: the bot answers that one
 * number, and still nobody else, until the lead has been silent for
 * WHATSAPP_OPTIN_HOURS (48 by default). Every message they send inside the
 * window restarts the clock. Once it closes the bot goes quiet for that lead
 * until they send the campaign phrase again, which opens a fresh window.
 *
 * Kept in a Map (number -> the lead's last message) for the hot path and
 * mirrored to MongoDB, so a restart does not drop a lead halfway through a
 * conversation or reopen a window that has already closed.
 */
const optedIn = new Map();

const windowMs = () => config.whatsappOptInHours * 60 * 60 * 1000;

/** True while a lead last heard from at `lastActiveAt` (ms) is still inside the window. */
const isOpen = (lastActiveAt, now = Date.now()) => now - lastActiveAt < windowMs();

/** Lowercase and punctuation-free, so "Jan-2027!" and "JAN  2027" match alike. */
const normalize = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when a message carries one of the configured campaign phrases, as whole
 * words. "Your last attempt kit" is a product name, not the ad: a lead asking
 * what is inside the kit must get an answer, not the campaign question.
 */
export function matchesUnlockPhrase(text) {
  const haystack = normalize(text);
  if (!haystack) return false;
  return config.whatsappUnlockPhrases
    .map(normalize)
    .filter(Boolean)
    .some((phrase) => new RegExp(`(^| )${escapeRe(phrase)}(?! kit)( |$)`).test(haystack));
}

/**
 * True when the message is nothing *but* a campaign phrase - the bare reply to
 * the ad, with no question attached. "Jan 2027 - what are the fees?" carries a
 * real question and must be answered as one, so it is deliberately excluded.
 */
export function isBareUnlockPhrase(text) {
  const haystack = normalize(text);
  if (!haystack) return false;
  return config.whatsappUnlockPhrases
    .map(normalize)
    .filter(Boolean)
    .some((phrase) => haystack === phrase);
}

/**
 * Is this number inside its opt-in window? Checks memory first, then the
 * database for opt-ins made before the last restart. A lead whose window has
 * closed is treated exactly like one who never opted in.
 *
 * Fails closed: if the database cannot be reached the number stays locked
 * rather than being guessed into the allowlist.
 */
export async function isOptedIn(waId) {
  const id = normalizeWaId(waId);
  if (!id) return false;
  if (optedIn.has(id)) return isOpen(optedIn.get(id));

  try {
    const found = await (await optinsCollection()).findOne({ waId: id });
    if (!found) return false;
    const lastActiveAt = lastActiveAtOf(found);
    optedIn.set(id, lastActiveAt);
    return isOpen(lastActiveAt);
  } catch (err) {
    console.error('opt-in lookup failed:', err.message);
    return false;
  }
}

/** The latest sign of life on record. Opt-ins saved before the window existed only have createdAt. */
const lastActiveAtOf = (doc) =>
  Math.max(...[doc.lastMessageAt, doc.unlockedAt, doc.createdAt].map((v) => (v ? new Date(v).getTime() : 0)));

/**
 * Records one lead's opt-in and (re)starts their window from now. Memory is
 * updated first so the message that triggered it is still answered when the
 * database is unavailable.
 */
export async function optIn(waId, { name = null, text = '' } = {}) {
  const id = normalizeWaId(waId);
  if (!id) return false;
  const now = new Date();
  optedIn.set(id, now.getTime());

  try {
    await (await optinsCollection()).updateOne(
      { waId: id },
      { $set: { unlockedAt: now, lastMessageAt: now }, $setOnInsert: { waId: id, name, text, createdAt: now } },
      { upsert: true }
    );
  } catch (err) {
    console.error('opt-in save failed:', err.message);
  }
  return true;
}

/**
 * Restarts the window of a lead who is inside it, because they just wrote to us.
 * Does nothing for a lead whose window has closed: only the phrase reopens that.
 */
export async function touchOptIn(waId) {
  const id = normalizeWaId(waId);
  if (!id || !optedIn.has(id) || !isOpen(optedIn.get(id))) return;
  const now = new Date();
  optedIn.set(id, now.getTime());

  try {
    await (await optinsCollection()).updateOne({ waId: id }, { $set: { lastMessageAt: now } });
  } catch (err) {
    console.error('opt-in touch failed:', err.message);
  }
}

/** Warms the cache at boot; returns how many leads are inside their window right now. */
export async function loadOptIns() {
  try {
    const docs = await (await optinsCollection())
      .find({}, { projection: { waId: 1, lastMessageAt: 1, unlockedAt: 1, createdAt: 1 } })
      .toArray();
    for (const doc of docs) optedIn.set(doc.waId, lastActiveAtOf(doc));
  } catch (err) {
    console.error('opt-in load failed:', err.message);
  }
  return activeOptInCount();
}

/** Every lead that has ever opted in. */
export const optInCount = () => optedIn.size;

/** Leads the bot is answering right now. */
export const activeOptInCount = () => [...optedIn.values()].filter((t) => isOpen(t)).length;
