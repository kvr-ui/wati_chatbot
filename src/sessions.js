import { config } from './config.js';

/**
 * In-memory conversation state, keyed by WhatsApp id.
 * Swap this module for Redis/Postgres if you run more than one instance.
 *
 * Only short-lived memory lives here. Anything that must outlast
 * SESSION_TTL_MINUTES or a restart - handover pauses, STOP, opt-ins, campaign
 * answers, seen webhook ids - has its own module backed by MongoDB.
 */
const sessions = new Map();

export function getSession(waId, name) {
  const now = Date.now();
  let session = sessions.get(waId);

  if (session && now - session.lastSeen > config.bot.sessionTtlMs) {
    session = undefined; // expired: start a fresh conversation
  }
  if (!session) {
    session = { waId, name, history: [], createdAt: now, lastSeen: now };
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

export function stats() {
  return { activeSessions: sessions.size };
}

export function deleteSession(waId) {
  sessions.delete(waId);
}
