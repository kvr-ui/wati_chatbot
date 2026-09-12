/**
 * Leads dashboard. Every value rendered here originates from a WhatsApp
 * contact, so nodes are built with textContent - never innerHTML.
 */
const listEl = document.getElementById('lead-list');
const statsEl = document.getElementById('lead-stats');
const transcriptEl = document.getElementById('transcript');
const transcriptMetaEl = document.getElementById('transcript-meta');
const signalsEl = document.getElementById('signals');
const stageFilter = document.getElementById('stage-filter');
const channelFilter = document.getElementById('channel-filter');
const csvLink = document.getElementById('csv-link');
const jsonlLink = document.getElementById('jsonl-link');

let selectedWaId = null;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const message = (parent, text) => {
  parent.replaceChildren(el('p', 'no-reviews', text));
};

function formatWhen(value) {
  if (!value) return '';
  // SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC.
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function query() {
  const params = new URLSearchParams();
  if (channelFilter.value) params.set('channel', channelFilter.value);
  if (stageFilter.value) params.set('stage', stageFilter.value);
  return params;
}

/* ------------------------------ lead list ------------------------------ */

function renderLeads(leads) {
  if (!leads.length) {
    message(listEl, 'No conversations recorded yet. Message the bot on WhatsApp and refresh.');
    return;
  }

  const cards = leads.map((lead) => {
    const card = el('button', 'lead-card');
    card.type = 'button';
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-current', String(lead.waId === selectedWaId));

    const score = el('span', `score ${lead.stage}`, String(lead.score));
    score.append(el('small', null, lead.stage));

    const main = el('span', 'lead-main');
    main.append(el('strong', null, lead.name || lead.waId));

    const phone = lead.waId.replace(/^preview:/, '');
    const parts = [phone, `${lead.userMessages} question${lead.userMessages === 1 ? '' : 's'}`];
    if (lead.handover) parts.push('wants an agent');
    main.append(el('p', 'lead-sub', parts.join(' · ')));
    main.append(el('p', 'lead-last', lead.signals.map((s) => s.label).join(' · ') || 'No buying signals yet'));

    card.append(score, main);
    card.addEventListener('click', () => selectLead(lead.waId));
    return card;
  });

  listEl.replaceChildren(...cards);
}

async function loadLeads() {
  try {
    const res = await fetch(`/api/leads?${query()}`);
    if (!res.ok) throw new Error('request failed');
    const { leads, stats } = await res.json();

    statsEl.textContent =
      `${stats.leads} lead${stats.leads === 1 ? '' : 's'} · ${stats.hotLeads} hot · ${stats.messages} messages stored`;
    renderLeads(leads);
  } catch {
    message(listEl, 'Could not load leads. Is the server running?');
    statsEl.textContent = 'Offline';
  }
}

/* ------------------------------ transcript ----------------------------- */

function renderTranscript(lead) {
  const signals = lead.signals.map((s) => el('span', 'tag', s.label));
  if (lead.handover) signals.push(el('span', 'tag handover', 'Asked for a human agent'));
  signalsEl.replaceChildren(...signals);

  transcriptMetaEl.textContent =
    `${lead.waId.replace(/^preview:/, '')} · score ${lead.score} (${lead.stage}) · ` +
    `first seen ${formatWhen(lead.firstSeen)} · last ${formatWhen(lead.lastSeen)}`;

  const turns = lead.messages.map((m) => {
    const turn = el('div', `turn ${m.role}`);
    turn.append(el('div', 'bubble', m.text));

    const bits = [formatWhen(m.createdAt)];
    if (m.role === 'assistant') {
      if (m.model) bits.push(m.model);
      if (m.reason) bits.push(m.reason);
      if (m.elapsedMs != null) bits.push(`${(m.elapsedMs / 1000).toFixed(1)}s`);
    } else if (m.trigger) {
      bits.push(`matched: ${m.trigger}`);
    }
    turn.append(el('p', 'turn-meta', bits.filter(Boolean).join(' · ')));
    return turn;
  });

  transcriptEl.replaceChildren(...turns);
}

async function selectLead(waId) {
  selectedWaId = waId;
  for (const card of listEl.querySelectorAll('.lead-card')) card.setAttribute('aria-current', 'false');

  message(transcriptEl, 'Loading conversation…');
  try {
    const res = await fetch(`/api/leads/${encodeURIComponent(waId)}`);
    if (!res.ok) throw new Error('not found');
    renderTranscript((await res.json()).lead);
    await loadLeads();
  } catch {
    message(transcriptEl, 'Could not load that conversation.');
  }
}

/* -------------------------------- wiring ------------------------------- */

function syncExportLinks() {
  const channel = channelFilter.value || 'whatsapp';
  csvLink.href = `/api/export/leads.csv?channel=${channel}`;
  jsonlLink.href = `/api/export/training.jsonl?channel=${channel}`;
}

for (const control of [stageFilter, channelFilter]) {
  control.addEventListener('change', () => {
    syncExportLinks();
    loadLeads();
  });
}

syncExportLinks();
loadLeads();
// New WhatsApp messages arrive while the page is open; keep the list current.
setInterval(loadLeads, 15_000);
