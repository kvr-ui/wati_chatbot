import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client;
const anthropic = () =>
  (client ??= new Anthropic({
    ...(config.anthropic.authStyle === 'bearer'
      ? { authToken: config.anthropic.apiKey, apiKey: null }
      : { apiKey: config.anthropic.apiKey }),
    ...(config.anthropic.baseUrl ? { baseURL: config.anthropic.baseUrl } : {}),
  }));

// Server-side refusal fallback: if a safety classifier declines the request,
// the API re-runs it on a fallback model inside the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Not every deployment behind a custom ANTHROPIC_BASE_URL accepts the newest
// request fields. Each is dropped permanently the first time it draws a 400.
const supports = { fallbacks: true, effort: true };

/** Anthropic requires the first message to be from the user. */
function sanitize(history) {
  const trimmed = [...history];
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  return trimmed.map((m) => ({ role: m.role, content: String(m.content) }));
}

/** Returns the capability to disable for a 400, or null if it is a real error. */
function degradableFrom(err) {
  const message = String(err?.message || '').toLowerCase();
  if (supports.fallbacks && /fallback|beta/.test(message)) return 'fallbacks';
  if (supports.effort && /output_config|effort/.test(message)) return 'effort';
  // Unrecognised 400: drop the newest field still enabled and try once more.
  if (supports.fallbacks) return 'fallbacks';
  if (supports.effort) return 'effort';
  return null;
}

function buildRequest({ system, history, question }) {
  return {
    model: config.anthropic.model,
    // Thinking is on by default on Opus 5; low effort keeps a FAQ reply fast and
    // cheap, and max_tokens leaves room for the thinking tokens as well as the answer.
    max_tokens: 2000,
    ...(supports.effort ? { output_config: { effort: config.anthropic.effort } } : {}),
    system: system.map((text) => ({ type: 'text', text })),
    messages: [...sanitize(history), { role: 'user', content: question }],
  };
}

/**
 * @param {{ system: string[], history: object[], question: string }} req
 * @returns {Promise<{ text: string, usage: object, model: string, refused: boolean }>}
 */
export async function complete(req) {
  let res;
  let lastError;
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    const params = buildRequest(req);
    try {
      res = supports.fallbacks
        ? await anthropic().beta.messages.create({
            ...params,
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
          })
        : await anthropic().messages.create(params);
    } catch (err) {
      lastError = err;
      const isBadRequest = err instanceof Anthropic.BadRequestError || err?.status === 400;
      const drop = isBadRequest ? degradableFrom(err) : null;
      if (!drop) throw err;
      supports[drop] = false;
      console.warn(`Claude: endpoint rejected "${drop}", retrying without it.`);
    }
  }

  // Every degradation was exhausted and the request still failed.
  if (!res) throw lastError;

  const refused = res.stop_reason === 'refusal';
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return { text, usage: res.usage, model: res.model, refused };
}

export const name = 'claude';
