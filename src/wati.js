import { config } from './config.js';

const MAX_LEN = 4000; // WhatsApp hard limit is 4096 chars per message
// The text travels in the query string, where one emoji or non-Latin letter
// grows to 6-12 characters. Servers commonly reject URLs past about 8 KB.
const MAX_ENCODED = 6000;
const TIMEOUT_MS = 15_000;

/** Never cut between the two halves of an emoji: a lone half is invalid text. */
const safeCut = (s, i) => (i > 0 && i < s.length && /[\uD800-\uDBFF]/.test(s[i - 1]) ? i - 1 : i);
const fits = (s) => s.length <= MAX_LEN && encodeURIComponent(s).length <= MAX_ENCODED;

export function splitLongText(text) {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (!fits(rest)) {
    let limit = Math.min(rest.length, MAX_LEN);
    limit = safeCut(rest, limit);
    while (!fits(rest.slice(0, limit))) limit = safeCut(rest, Math.floor(limit * 0.9));
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function watiRequest(pathname, { method = 'POST', query = {}, body } = {}) {
  const url = new URL(`${config.wati.endpoint}${pathname}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.wati.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Replies to one lead go out in order, so a hung request would hold up every later one.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    throw new Error(`WATI ${method} ${pathname} failed (${res.status}): ${raw.slice(0, 500)}`);
  }
  return data;
}

/** Send a free-form session message (only valid inside the 24h customer service window). */
export async function sendSessionMessage(waId, text) {
  const chunks = splitLongText(text);
  const results = [];
  for (const chunk of chunks) {
    results.push(
      await watiRequest(`/api/v1/sendSessionMessage/${encodeURIComponent(waId)}`, {
        query: { messageText: chunk },
      })
    );
  }
  return results;
}

/**
 * Send an approved template message - required to start a conversation
 * outside the 24h window.
 * params: [{ name: 'name', value: 'Sandy' }]
 */
export async function sendTemplateMessage(waId, templateName, params = [], broadcastName) {
  return watiRequest('/api/v1/sendTemplateMessage', {
    query: { whatsappNumber: waId },
    body: {
      template_name: templateName,
      broadcast_name: broadcastName || `${templateName}_${Date.now()}`,
      parameters: params,
    },
  });
}

/** Send an interactive button list (max 3 buttons per WhatsApp). */
export async function sendInteractiveButtons(waId, bodyText, buttons, header) {
  return watiRequest('/api/v1/sendInteractiveButtonsMessage', {
    query: { whatsappNumber: waId },
    body: {
      header: header ? { type: 'Text', text: header } : undefined,
      body: bodyText,
      buttons: buttons.slice(0, 3).map((b) => ({ text: typeof b === 'string' ? b : b.text })),
    },
  });
}

/** Assign the chat to a human operator / flag it for takeover. */
export async function addContactTags(waId, tags) {
  return watiRequest(`/api/v1/updateContactAttributes/${encodeURIComponent(waId)}`, {
    body: { customParams: tags.map((t) => ({ name: t.name, value: t.value })) },
  });
}

/** Assign the chat to a WATI user, which puts it in that person's inbox. */
export async function assignOperator(waId, email) {
  return watiRequest('/api/v1/assignOperator', { query: { email, whatsappNumber: waId } });
}

export const wati = {
  sendSessionMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  addContactTags,
  assignOperator,
};
