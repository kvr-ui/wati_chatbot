import { config } from './config.js';

/**
 * In-memory conversation state, keyed by WhatsApp id.
 * Swap this module for Redis/Postgres if you run more than one instance.
 */
const sessions = new Map();
const seenMessageIds = new Map(); // messageId -> timestamp, for webhook de-duplication

export function getSession(waId, name) {
  const now = Date.now();
  let session = sessions.get(waId);

  if (session && now - session.lastSeen > config.bot.sessionTtlMs) {
    session = undefined; // expired: start a fresh conversation
  }
  if (!session) {
    session = { waId, name, history: [], pausedUntil: 0, createdAt: now, lastSeen: now };
    sessions.set(waId, session);
  }

  session.lastSeen = now;
  if (name) session.name = name;
  return session;
}

export function remember(session, role, content) {
  session.history.push({ role, content });
  if (session.history.length > 12) session.history = session.history.slice(-12);
}

export function pauseForHandover(session) {
  session.pausedUntil = Date.now() + config.bot.handoverPauseMs;
}

export function isPaused(session) {
  return session.pausedUntil > Date.now();
}

export function resume(session) {
  session.pausedUntil = 0;
}

/** True the first time a message id is seen; WATI can retry the same webhook. */
export function isNewMessage(messageId) {
  if (!messageId) return true;
  const now = Date.now();
  for (const [id, ts] of seenMessageIds) {
    if (now - ts > 10 * 60_000) seenMessageIds.delete(id);
  }
  if (seenMessageIds.has(messageId)) return false;
  seenMessageIds.set(messageId, now);
  return true;
}

export function stats() {
  return { activeSessions: sessions.size };
}

export function deleteSession(waId) {
  sessions.delete(waId);
}
