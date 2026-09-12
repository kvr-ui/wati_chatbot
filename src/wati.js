import { config } from './config.js';

const MAX_LEN = 4000; // WhatsApp hard limit is 4096 chars per message

function splitLongText(text) {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf('\n', MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = rest.lastIndexOf(' ', MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
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

export const wati = {
  sendSessionMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  addContactTags,
};
