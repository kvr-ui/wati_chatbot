import { config } from '../src/config.js';
import { answer, assertAiConfigured } from '../src/ai.js';
import { ensureIndex, indexStats } from '../src/kb.js';

/**
 * Verifies OpenAI actually answers:  npm run check:ai
 * Ask something specific:            npm run check:ai -- "what are the fees"
 */
const question = process.argv[2] || 'What courses do you offer?';

console.log('OpenAI key          :', config.openai.apiKey ? 'set' : 'not set');
console.log('OpenAI endpoint     :', config.openai.baseUrl || 'https://api.openai.com/v1');
console.log('Chat model          :', config.openai.chatModel);

try {
  assertAiConfigured();
} catch (err) {
  console.error('\nFAIL:', err.message);
  process.exit(1);
}

await ensureIndex({ log: (m) => console.log('[kb]', m) });
console.log('Retrieval mode      :', indexStats().mode);

console.log(`\nAsking OpenAI: "${question}"\n`);
const started = Date.now();
try {
  const res = await answer(question);
  console.log(res.text);
  console.log(`\n[PASS] provider=${res.provider} model=${res.model} in ${Date.now() - started}ms`);
  console.log('sources:', res.sources.length ? res.sources.map((s) => `${s.section} (${s.score})`).join(', ') : 'none matched');
  console.log('usage  :', JSON.stringify(res.usage));
} catch (err) {
  console.error(`[FAIL] ${err.constructor?.name || 'Error'}: ${err.message}`);
  if (err.status === 401) console.error('       The API key was rejected.');
  process.exit(1);
}
