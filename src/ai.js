import { config } from './config.js';
import { search } from './kb.js';
import * as openai from './providers/openai.js';

const BASE_SYSTEM_PROMPT = `You are ${config.bot.name}, the WhatsApp assistant for our team.

Reading the KNOWLEDGE BASE below - each entry is laid out the same way:
- "Asked as:" lists the words students use to reach that entry. It is a search aid: never repeat it.
- The middle lines are the facts, plus any instruction addressed to you. Follow those instructions, never send them to the user (for example "Then leave the conversation UNREAD").
- "Send:" is a ready reply. When an entry matches, send its "Send:" text, adjusted only to the user's wording and language.

Rules:
- Answer ONLY from the KNOWLEDGE BASE. Never invent or estimate a price, date, link, phone number or address.
- If nothing in the knowledge base matches, never say you do not know, cannot help, or do not have something. Instead tell the user we have raised it with our team and an executive will get back to them shortly.
- Speak as a member of the team: "we", "us", "our team". Never refer to the team in the third person.
- You are always talking to a student, never to our own staff. Never discuss setup, configuration, what you have or have not been given, or what you are able to do - just help the student.
- Reply in the same language and script as the user's latest message, even if earlier messages in the conversation were in a different one.
- Keep replies short and WhatsApp friendly: under 90 words, plain sentences, no markdown headings or tables.
- Use *single asterisks* for bold (WhatsApp style) and "- " for short lists. Never use ** or #.
- Do not mention the knowledge base, documents, context or that you are an AI model.`;

function buildContext(chunks) {
  // An empty context used to read as "the bot has no data", and the model would talk about
  // its own setup instead of to the student. Spell out what to do instead.
  if (!chunks.length) {
    return [
      'KNOWLEDGE BASE:',
      'Nothing matched this message.',
      'Do not comment on that, and do not answer from your own knowledge. If the message is small talk, a greeting or unclear, reply warmly in one line and ask what they would like to know about our classes, fees, timings or the Last Attempt Kit. Otherwise tell them we have raised it with our team and an executive will get back to them shortly.',
    ].join('\n');
  }
  return [
    'KNOWLEDGE BASE:',
    ...chunks.map((c, i) => `[${i + 1}] ${c.section ? `${c.section}\n` : ''}${c.text}`),
  ].join('\n\n');
}

/** OpenAI is the only model provider; say so plainly when its key is missing. */
export function assertAiConfigured() {
  if (!config.openai.apiKey) throw new Error('Set OPENAI_API_KEY in .env, then restart the server.');
}

/**
 * Answers a question using knowledge-base retrieval.
 * history: [{ role: 'user'|'assistant', content }]
 */
export async function answer(question, { history = [], extraInstruction, kbFilter } = {}) {
  assertAiConfigured();
  // Short follow-ups such as "and both groups?" need the previous question's topic.
  const previousQuestion = history.filter((m) => m.role === 'user').at(-1)?.content;
  const refersBack = /^(and\b|also\b|what about\b|how about\b)|\b(it|that|those|they|them)\b/i.test(question);
  const followup = !kbFilter && previousQuestion && refersBack && question.trim().split(/\s+/).length <= 8;
  const chunks = await search(followup ? `${previousQuestion}\n${question}` : question, { filter: kbFilter });

  const res = await openai.complete({
    system: [BASE_SYSTEM_PROMPT, ...(extraInstruction ? [extraInstruction] : []), buildContext(chunks)],
    history: history.slice(-8),
    question,
  });

  return {
    text: res.text || config.bot.fallbackMessage,
    provider: openai.name,
    model: res.model,
    refused: res.refused,
    sources: chunks.map((c) => ({ source: c.source, section: c.section, score: Number(c.score.toFixed(3)) })),
    usage: res.usage,
  };
}

/** Renders a static trigger reply, substituting {{name}} style placeholders. */
export function renderTemplate(template, vars = {}) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}
