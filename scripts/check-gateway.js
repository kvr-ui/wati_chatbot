import { config } from '../src/config.js';

/**
 * Probes an AI gateway and reports exactly which surface, auth header and models
 * it accepts:   npm run check:gateway [url] [key]
 */
const base = (process.argv[2] || config.anthropic.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
const key = process.argv[3] || config.anthropic.apiKey || config.openai.apiKey;

if (!key) {
  console.error('No key to test. Put one in ANTHROPIC_API_KEY or pass it: npm run check:gateway -- <url> <key>');
  process.exit(1);
}

console.log('Gateway :', base);
console.log('Key     :', `${key.slice(0, 8)}...${key.slice(-4)} (${key.length} chars)\n`);

const AUTH = {
  'x-api-key': { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  bearer: { authorization: `Bearer ${key}` },
};

async function probe(label, path, headers, body) {
  try {
    const res = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const verdict = res.ok ? 'PASS' : res.status === 401 ? 'AUTH' : 'FAIL';
    console.log(`[${verdict}] ${label.padEnd(38)} HTTP ${res.status}  ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    console.log(`[FAIL] ${label.padEnd(38)} ${err.message}`);
    return { ok: false, status: 0, text: '' };
  }
}

// What does the server say it serves?
const root = await probe('GET /  (server identity)', '/', {});
let advertised = [];
try {
  advertised = JSON.parse(root.text).endpoints || [];
} catch {
  /* not a JSON index */
}

const model = config.anthropic.model;
const anthropicBody = { model, max_tokens: 32, messages: [{ role: 'user', content: 'say ok' }] };
const openaiBody = { model, max_tokens: 32, messages: [{ role: 'user', content: 'say ok' }] };

console.log('');
const results = {
  'anthropic /v1/messages (x-api-key)': await probe(
    'POST /v1/messages  x-api-key',
    '/v1/messages',
    AUTH['x-api-key'],
    anthropicBody
  ),
  'anthropic /v1/messages (bearer)': await probe(
    'POST /v1/messages  bearer',
    '/v1/messages',
    AUTH.bearer,
    anthropicBody
  ),
  'openai /v1/chat/completions (bearer)': await probe(
    'POST /v1/chat/completions  bearer',
    '/v1/chat/completions',
    AUTH.bearer,
    openaiBody
  ),
  'openai /v1/chat/completions (x-api-key)': await probe(
    'POST /v1/chat/completions  x-api-key',
    '/v1/chat/completions',
    AUTH['x-api-key'],
    openaiBody
  ),
  'models (bearer)': await probe('GET  /v1/models  bearer', '/v1/models', AUTH.bearer),
};

const working = Object.entries(results).filter(([, r]) => r.ok);
const allAuth = Object.values(results).every((r) => r.status === 401);

console.log('\n---');
if (advertised.length) console.log('Server advertises:', advertised.join(', '));

if (working.length) {
  console.log('Working surfaces :', working.map(([k]) => k).join(', '));
  const anthropicWorks = working.some(([k]) => k.startsWith('anthropic'));
  console.log(
    `\nUse: AI_PROVIDER=${anthropicWorks ? 'claude' : 'openai'}` +
      (anthropicWorks
        ? `\n     ANTHROPIC_BASE_URL=${base}`
        : `\n     OPENAI_BASE_URL=${base}/v1\n     OPENAI_API_KEY=<this key>\n     OPENAI_CHAT_MODEL=${model}`)
  );
} else if (allAuth) {
  console.log('Every surface returned 401 - the key is not accepted by this gateway.');
  console.log('The endpoints exist and the server is reachable, so this is a key problem:');
  console.log('  - confirm the key is registered on the proxy (its api-keys config)');
  console.log('  - confirm you copied it whole, with no truncation');
} else {
  console.log('No surface answered successfully - see the statuses above.');
}
