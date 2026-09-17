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
 * start messaging a lead who asked us to stop.
 */
const optedOut = new Set();

/**
 * Has this contact opted out? Memory first, then the database for opt-outs made
 * before the last restart. A failed lookup is logged and falls back to memory,
 * which {@link loadOptOuts} fills at boot.
 */
export async function isOptedOut(waId) {
  const id = String(waId ?? '');
  if (!id) return false;
  if (optedOut.has(id)) return true;

  try {
    const found = await (await optoutsCollection()).findOne({ waId: id });
    if (found) optedOut.add(id);
    return Boolean(found);
  } catch (err) {
    console.error('opt-out lookup failed:', err.message);
    return false;
  }
}

/** Records one opt-out. Memory first, so the lead is silenced even if the save fails. */
export async function optOut(waId, { name = null, text = '' } = {}) {
  const id = String(waId ?? '');
  if (!id) return;
  optedOut.add(id);

  try {
    await (await optoutsCollection()).updateOne(
      { waId: id },
      { $setOnInsert: { waId: id, name, text, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('opt-out save failed:', err.message);
  }
}

/** Lets a playground tester run a chat from the top again. Never used for WhatsApp numbers. */
export async function resetOptOut(waId) {
  const id = String(waId ?? '');
  optedOut.delete(id);
  await (await optoutsCollection()).deleteOne({ waId: id }).catch(() => {});
}

/** Warms the cache at boot; returns how many leads have opted out. */
export async function loadOptOuts() {
  try {
    const docs = await (await optoutsCollection()).find({}, { projection: { waId: 1 } }).toArray();
    for (const doc of docs) optedOut.add(doc.waId);
  } catch (err) {
    console.error('opt-out load failed:', err.message);
  }
  return optedOut.size;
}

export const optOutCount = () => optedOut.size;
