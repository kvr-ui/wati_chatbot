import { contactKey } from './config.js';
import { optouts as optoutsCollection } from './mongo.js';

/**
 * Leads who replied STOP.
 *
 * A lead who opts out is never answered again - not the STOP message itself and
 * nothing after it, whatever they send. Unlike the handover pause this does not
 * expire and cannot be undone from the chat; delete the lead's document from the
 * opt-outs collection and restart to let the bot talk to them again.
 *
 * Kept in a Set for the hot path and mirrored to MongoDB, so a restart cannot
 * start messaging a lead who asked us to stop. Stored under the same digits-only
 * key as opt-ins and campaign state, so "+91 98…" and "9198…" are one lead.
 */
const optedOut = new Set();

/** Opt-outs held only in memory because the save failed; retried on the lead's next message. */
const unsaved = new Map();

/** Lowercase, apostrophes dropped ("don't" -> "dont"), everything else that is not a letter or digit a space. */
const normalize = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Politeness around the request: "please stop", "stop it sir", "ok stop now thanks". */
const FILLER = '(?:please|pls|plz|plzz|kindly|ok|okay|sir|madam|mam|maam|bro|now|just|thanks|thank you|thankyou|immediately|right now|asap)';

/** The request itself, as the whole message once the filler is stripped. */
const REQUEST = [
  'stop',
  'stop (?:it|this|that|now|all)',
  'stop (?:messaging|texting|sending|spamming|contacting|msging|msg|message|calling|bothering|disturbing)(?: (?:me|us|messages|msgs|texts|this|these))?(?: (?:again|anymore|any more))?',
  'stop (?:the|these|this|your|all|all these|all the|sending me|sending)? ?(?:whatsapp )?(?:messages|message|msgs|msg|texts|spam)',
  '(?:unsubscribe|unsub)(?: me)?',
  'opt ?out',
  'opt me out',
  '(?:dont|do not|never) (?:message|msg|text|contact|call|disturb|send) (?:me|us)(?: (?:again|anymore|any more|messages))?',
  'no more (?:messages|message|msgs|texts|spam)',
  'remove (?:me|my number)(?: from (?:this|your|the) (?:list|group|messages))?',
].join('|');

const OPT_OUT_RE = new RegExp(`^(?:${FILLER} )*(?:${REQUEST})(?: ${FILLER})*$`);

/**
 * True when the whole message asks us to stop: "STOP", "please stop", "stop
 * messaging me", "don't text me again". A message that only mentions stopping
 * - "which bus stop is near the centre?", "can I stop the course midway?" - is a
 * question and must be answered, so the request has to be all the message says.
 */
export function isOptOutRequest(text) {
  return OPT_OUT_RE.test(normalize(text));
}

/** Saves one opt-out; true once MongoDB has it. */
async function persist(id) {
  const details = unsaved.get(id) ?? {};
  try {
    await (await optoutsCollection()).updateOne(
      { waId: id },
      { $setOnInsert: { waId: id, name: details.name ?? null, text: details.text ?? '', createdAt: details.createdAt ?? new Date() } },
      { upsert: true }
    );
    unsaved.delete(id);
    return true;
  } catch (err) {
    console.error('opt-out save failed:', err.message);
    return false;
  }
}

/**
 * Has this contact opted out? Memory first, then the database for opt-outs made
 * before the last restart.
 *
 * Fails closed for WhatsApp contacts, like the opt-in check: if the database
 * cannot be reached the lead is treated as opted out rather than risking a
 * message to someone who asked us to stop. Playground sessions fail open - there
 * is no real person behind them, and the tester still needs a working chat.
 */
export async function isOptedOut(waId) {
  const id = contactKey(waId);
  if (!id) return false;
  if (optedOut.has(id)) {
    if (unsaved.has(id)) persist(id);
    return true;
  }

  try {
    // Documents saved before ids were normalized may still carry the raw WhatsApp id.
    const raw = String(waId ?? '').trim();
    const found = await (await optoutsCollection()).findOne({ waId: { $in: [...new Set([id, raw])] } });
    if (found) optedOut.add(id);
    return Boolean(found);
  } catch (err) {
    console.error('opt-out lookup failed:', err.message);
    return !id.startsWith('preview:');
  }
}

/** Records one opt-out. Memory first, so the lead is silenced even if the save fails. */
export async function optOut(waId, { name = null, text = '' } = {}) {
  const id = contactKey(waId);
  if (!id) return;
  optedOut.add(id);
  unsaved.set(id, { name, text, createdAt: new Date() });
  await persist(id);
}

/** Lets a playground tester run a chat from the top again. Never used for WhatsApp numbers. */
export async function resetOptOut(waId) {
  const id = contactKey(waId);
  optedOut.delete(id);
  unsaved.delete(id);
  await (await optoutsCollection()).deleteOne({ waId: id }).catch(() => {});
}

/** Warms the cache at boot; returns how many leads have opted out. */
export async function loadOptOuts() {
  try {
    const docs = await (await optoutsCollection()).find({}, { projection: { waId: 1 } }).toArray();
    for (const doc of docs) {
      const id = contactKey(doc.waId);
      if (id) optedOut.add(id);
    }
  } catch (err) {
    console.error('opt-out load failed:', err.message);
  }
  return optedOut.size;
}

export const optOutCount = () => optedOut.size;
