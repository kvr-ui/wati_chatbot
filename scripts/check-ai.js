import { config } from '../src/config.js';
import { answer, pickProvider } from '../src/ai.js';
import { ensureIndex, indexStats } from '../src/kb.js';

/**
 * Verifies the AI provider actually answers:  npm run check:ai
 * Force one provider:                         npm run check:ai -- claude
 */
const forced = process.argv[2];
const question = process.argv[3] || 'What courses do you offer?';

console.log('Configured provider :', config.ai.provider);
console.log('Anthropic key       :', config.anthropic.apiKey ? `set (model ${config.anthropic.model})` : 'not set');
console.log('Anthropic endpoint  :', `${config.anthropic.baseUrl || 'https://api.anthropic.com'}/v1/messages (auth: ${config.anthropic.authStyle})`);
console.log('OpenAI key          :', config.openai.apiKey ? `set (model ${config.openai.chatModel})` : 'not set');

let impl;
try {
  impl = pickProvider(forced);
} catch (err) {
  console.error('\nFAIL:', err.message);
  process.exit(1);
}
if (forced && impl.name !== forced) {
  console.log(`\nNote: "${forced}" has no API key - falling back to ${impl.name}.`);
}

// A custom gateway may expose a different model list - show it before failing on a bad name.
if (impl.name === 'claude' && config.anthropic.baseUrl) {
  try {
    const res = await fetch(`${config.anthropic.baseUrl}/v1/models`, {
      headers:
        config.anthropic.authStyle === 'bearer'
          ? { authorization: `Bearer ${config.anthropic.apiKey}` }
          : { 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
    });
    const body = await res.json().catch(() => ({}));
    const ids = (body.data || body.models || []).map((m) => m.id).filter(Boolean);
    console.log('Gateway models      :', ids.length ? ids.join(', ') : `(${res.status}) ${JSON.stringify(body).slice(0, 120)}`);
  } catch (err) {
    console.log('Gateway models      : could not list -', err.message);
  }
}

await ensureIndex({ log: (m) => console.log('[kb]', m) });
console.log('Retrieval mode      :', indexStats().mode);

console.log(`\nAsking ${impl.name}: "${question}"\n`);
const started = Date.now();
try {
  const res = await answer(question, { provider: impl.name });
  console.log(res.text);
  console.log(`\n[PASS] provider=${res.provider} model=${res.model} in ${Date.now() - started}ms`);
  if (res.refused) console.log('[warn] the model declined this request (stop_reason: refusal)');
  console.log('sources:', res.sources.length ? res.sources.map((s) => `${s.section} (${s.score})`).join(', ') : 'none matched');
  console.log('usage  :', JSON.stringify(res.usage));
} catch (err) {
  console.error(`[FAIL] ${err.constructor?.name || 'Error'}: ${err.message}`);
  if (err.status === 401) console.error('       The API key was rejected.');
  process.exit(1);
}
