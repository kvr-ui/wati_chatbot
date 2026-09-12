import fs from 'node:fs';
import { config } from './config.js';

const DEFAULT_PRIORITY = { exact: 100, starts_with: 60, regex: 40, contains: 20 };

let cache = { mtimeMs: 0, data: null };

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}\s'#+]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches the keyword plus a tolerated plural: "fee" also hits "fees". */
const pluralTolerant = (keyword) =>
  /(s|ss|sh|ch|x|z)$/i.test(keyword) ? escapeRe(keyword) : `${escapeRe(keyword)}(?:e?s)?`;

/** Reloads knowledge/keywords.json from disk whenever the file changes. */
export function loadTriggers() {
  const file = config.kb.keywordsFile;
  if (!fs.existsSync(file)) return { settings: {}, triggers: [] };

  const { mtimeMs } = fs.statSync(file);
  if (cache.data && cache.mtimeMs === mtimeMs) return cache.data;

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const triggers = (parsed.triggers || []).map((t, i) => ({
    id: t.id || `trigger_${i}`,
    match: t.match || 'contains',
    keywords: (t.keywords || []).map((k) => (t.match === 'regex' ? k : normalize(k))).filter(Boolean),
    action: t.action || (t.mode === 'ai' ? 'ai' : t.reply ? 'reply' : 'ai'),
    reply: t.reply,
    prompt: t.prompt,
    kbFilter: t.kbFilter,
    priority: t.priority ?? DEFAULT_PRIORITY[t.match || 'contains'] ?? 10,
  }));

  cache = { mtimeMs, data: { settings: parsed.settings || {}, triggers } };
  return cache.data;
}

function keywordHit(matchType, keyword, text) {
  switch (matchType) {
    case 'exact':
      return new RegExp(`^${pluralTolerant(keyword)}$`, 'i').test(text);
    case 'starts_with':
      return new RegExp(`^${pluralTolerant(keyword)}(\\s|$)`, 'i').test(text);
    case 'regex':
      try {
        return new RegExp(keyword, 'i').test(text);
      } catch {
        return false;
      }
    case 'contains':
    default:
      return new RegExp(`(^|\\s)${pluralTolerant(keyword)}(\\s|$)`, 'i').test(text);
  }
}

/**
 * Returns the best-matching trigger for an incoming message, or null.
 * Ties break on match specificity, then on keyword length (longest wins).
 */
export function matchTrigger(rawText) {
  const text = normalize(rawText);
  if (!text) return null;

  const { triggers } = loadTriggers();
  const hits = [];

  for (const trigger of triggers) {
    for (const keyword of trigger.keywords) {
      if (!keywordHit(trigger.match, keyword, text)) continue;
      hits.push({ trigger, keyword, score: trigger.priority * 1000 + keyword.length });
      break; // one hit per trigger is enough; the longest keyword already won on score
    }
  }
  if (!hits.length) return null;

  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];

  // One WhatsApp message often asks several things at once ("fees and timings?"). The
  // highest-scoring trigger decides the action, but every topic it touched is retrieved.
  const kbFilters = [...new Set(hits.map((h) => h.trigger.kbFilter).filter(Boolean))];

  return { ...best.trigger, matchedKeyword: best.keyword, kbFilters };
}

export function listTriggerIds() {
  return loadTriggers().triggers.map((t) => t.id);
}
