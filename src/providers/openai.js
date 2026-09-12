import OpenAI from 'openai';
import { config } from '../config.js';

let client;
const openai = () =>
  (client ??= new OpenAI({
    apiKey: config.openai.apiKey,
    timeout: 30_000,
    maxRetries: 0,
    ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
  }));

/**
 * @param {{ system: string[], history: object[], question: string }} req
 * @returns {Promise<{ text: string, usage: object, model: string, refused: boolean }>}
 */
export async function complete({ system, history, question }) {
  const res = await openai().chat.completions.create({
    model: config.openai.chatModel,
    messages: [
      ...system.map((content) => ({ role: 'system', content })),
      ...history,
      { role: 'user', content: question },
    ],
    temperature: 0.2,
    max_tokens: 400,
  });

  const text = res.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty answer. Please try again.');
  return {
    text,
    usage: res.usage,
    model: res.model,
    refused: false,
  };
}

export const name = 'openai';
