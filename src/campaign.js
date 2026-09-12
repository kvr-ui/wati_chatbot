import { normalizeWaId } from './config.js';
import { campaign as campaignCollection } from './mongo.js';
import { matchesUnlockPhrase, isBareUnlockPhrase } from './optin.js';

/**
 * The January 2027 campaign script.
 *
 * A lead who arrives from the ad (the "Jan 2027" message) is asked one
 * qualifying question before anything else, and the group they name decides
 * the follow-up. Once they have answered, the bot goes back to answering
 * freely from the knowledge base and never asks again.
 *
 * State lives in MongoDB as well as memory: a lead may answer minutes or days
 * later, long after the in-memory session in sessions.js has expired, and the
 * answer must still be understood as the answer to this question.
 */

/* ------------------------------- the copy ------------------------------ */
/* Edit the wording here. GROUPS drives both the options offered and the      */
/* answer matching below, so adding an option only means adding it here.      */

export const GROUPS = ['Group 1', 'Group 2', 'Both Groups', 'Unit 2D'];

export const GROUP_QUESTION = [
  'Which group are you planning to take the exam in January 2027?',
  '',
  ...GROUPS.map((group, i) => `${i + 1}. ${group}`),
].join('\n');

/** Sent once the lead names a group; {group} is echoed back to them. */
export const groupPitch = (group) => [
  `At FOCAS Edu, we offer classes for ${group}`,
  'We have work to do! And less than 3.5 months to do it in.',
  'We offer Recorded lectures, Live Tutor Study-along sessions, an Infinite Question Bank, Test Series with video reviews and a Planner and Manual to go along with.',
  'If you have any questions about any specific offering, feel free to ask!',
].join('\n');

/**
 * Sent when a lead who has already been through the script replies to the ad
 * again. It greets them by the group they picked rather than asking anew.
 */
export const returningWelcome = ({ name = null, group = null } = {}) => [
  `Welcome back${name ? `, ${name}` : ''}! 👋`,
  group
    ? `You already told us you're taking ${group} in January 2027.`
    : 'Good to hear from you again about January 2027.',
  'Ask me anything about classes, fees, timings or the Last Attempt Kit.',
].join('\n');

const REASK = [
  "Sorry, I didn't catch that - please reply with the number or the name of your group.",
  '',
  GROUP_QUESTION,
].join('\n');

/** The question is asked at most twice; after that the lead is let through. */
const MAX_ASKS = 2;

/* ---------------------------- answer matching -------------------------- */

const normalize = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A bare digit is read as a pick from the numbered list above. */
const byNumber = Object.fromEntries(GROUPS.map((group, i) => [String(i + 1), group]));

/**
 * Reads a group out of a free-text reply: "2", "grp 2", "both", "unit 2d".
 * Returns null when the reply names no group, which is what triggers the
 * single re-ask.
 */
export function matchGroup(text) {
  const t = normalize(text);
  if (!t) return null;

  if (/^[1-9][0-9]*$/.test(t)) return byNumber[t] ?? null;

  // "Both" and "2D" are checked first: "group 1 and group 2" contains both
  // single groups, and "unit 2d" contains a bare 2.
  if (/\bboth\b/.test(t) || /\b1\s*(and|n|plus)?\s*2\b/.test(t) || /\bgroup\s*1\s*(and|n|plus)?\s*group\s*2\b/.test(t)) {
    return 'Both Groups';
  }
  if (/\b(unit\s*)?2\s*d\b/.test(t)) return 'Unit 2D';
  if (/\b(group|grp|gp|g)\s*(1|one)\b/.test(t) || /\b1\b/.test(t)) return 'Group 1';
  if (/\b(group|grp|gp|g)\s*(2|two)\b/.test(t) || /\b2\b/.test(t)) return 'Group 2';
  return null;
}

/* ------------------------------- the state ----------------------------- */

const memory = new Map();

/** Browser preview sessions keep their prefix; WhatsApp ids reduce to digits. */
const keyFor = (waId) => {
  const raw = String(waId ?? '').trim();
  return raw.startsWith('preview:') ? raw : normalizeWaId(raw);
};

/**
 * Memory first, database second. If the database is unreachable the lead is
 * simply treated as not yet asked - the bot answers them normally instead of
 * going silent.
 */
async function getState(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const doc = await (await campaignCollection()).findOne({ waId: key });
    if (!doc) return null;
    const state = { status: doc.status, asked: doc.asked ?? 0, group: doc.group ?? null, name: doc.name ?? null };
    memory.set(key, state);
    return state;
  } catch (err) {
    console.error('campaign lookup failed:', err.message);
    return null;
  }
}

/** Memory is written first so the current message is still answered correctly. */
async function save(key, patch) {
  const next = { ...(memory.get(key) ?? {}), ...patch };
  memory.set(key, next);
  try {
    await (await campaignCollection()).updateOne(
      { waId: key },
      { $set: { waId: key, ...next, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error('campaign save failed:', err.message);
  }
  return next;
}

/* -------------------------------- the flow ----------------------------- */

/**
 * One step of the script.
 *
 * @returns {{replies: string[], meta: object} | null} null when this message is
 *   not part of the script and should be answered the usual way.
 */
export async function campaignStep({ waId, name = null, text }) {
  const key = keyFor(waId);
  if (!key) return null;

  const state = await getState(key);

  if (state?.status === 'awaiting') {
    const group = matchGroup(text);
    if (group) {
      await save(key, { status: 'answered', group, answer: String(text), answeredAt: new Date() });
      return {
        replies: [groupPitch(group)],
        meta: { trigger: 'campaign_group', reason: 'campaign_group_answered', group },
      };
    }

    const asked = state.asked ?? 1;
    if (asked < MAX_ASKS) {
      await save(key, { asked: asked + 1 });
      return { replies: [REASK], meta: { reason: 'campaign_group_reask' } };
    }

    // Asked twice and still no group: stop scripting and let the bot answer.
    await save(key, { status: 'unanswered' });
    return null;
  }

  // A lead who has been through the script sometimes replies to the ad a second
  // time. The question is never repeated - but a bare "Jan 2027" carries no
  // question either, so answer it as the returning lead it is instead of
  // letting the knowledge base greet them like a stranger.
  if (state && isBareUnlockPhrase(text)) {
    return {
      replies: [returningWelcome({ name: name || state.name, group: state.group })],
      meta: { reason: 'campaign_returning_lead', group: state.group ?? null },
    };
  }

  // Only an untouched lead starts the script, so a lead who answered once (or
  // was let through) is never asked again, however often the ad phrase recurs.
  if (!state && matchesUnlockPhrase(text)) {
    await save(key, { status: 'awaiting', asked: 1, name, group: null, startedAt: new Date() });
    return { replies: [GROUP_QUESTION], meta: { reason: 'campaign_group_asked' } };
  }

  return null;
}

/** Warms the cache at boot; returns how many leads have named their group. */
export async function loadCampaignState() {
  try {
    const docs = await (await campaignCollection()).find({}).toArray();
    for (const doc of docs) {
      memory.set(doc.waId, { status: doc.status, asked: doc.asked ?? 0, group: doc.group ?? null, name: doc.name ?? null });
    }
  } catch (err) {
    console.error('campaign load failed:', err.message);
  }
  return [...memory.values()].filter((s) => s.group).length;
}

/**
 * Forgets one contact's progress so the script can run again. Used by the
 * "new chat" button in the browser playground, so the flow can be retested
 * without hand-editing the database.
 */
export async function resetCampaign(waId) {
  const key = keyFor(waId);
  if (!key) return false;
  memory.delete(key);
  try {
    await (await campaignCollection()).deleteOne({ waId: key });
  } catch (err) {
    console.error('campaign reset failed:', err.message);
  }
  return true;
}

/** Counts per group, for /health. */
export function groupCounts() {
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  for (const state of memory.values()) if (state.group && state.group in counts) counts[state.group] += 1;
  return counts;
}
