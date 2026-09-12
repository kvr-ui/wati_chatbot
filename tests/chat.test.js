import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

// Import the application only after overriding credentials: tests never use real services.
let server, mock, base, config, getSession, closeMongo, getDb;
// Conversation tests run against a throwaway database, dropped in after().
const TEST_DB = `wati_bot_test_${process.pid}`;
let calls = [];
let fail = false;
let delay = false;
let requestArrived;
const listen = async (app) => { const s = app.listen(0, '127.0.0.1'); await once(s, 'listening'); return s; };
const post = async (text, sessionId = 'test', extra = {}) => {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, text, ...extra }) });
  return { status: res.status, data: await res.json() };
};
before(async () => {
  mock = await listen(http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls.push({ url: req.url, body: JSON.parse(raw) });
    requestArrived?.();
    if (delay) await new Promise((resolve) => setTimeout(resolve, 100));
    res.setHeader('content-type', 'application/json');
    if (fail) { res.writeHead(401); res.end(JSON.stringify({error:{message:'secret-test-token must never appear in browser',type:'authentication_error'}})); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: 'One group is ₹30,000 and both groups are ₹55,000, including the kit.' } }], model: 'gpt-4o-mini-test', usage: {} }));
  }));
  Object.assign(process.env, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-only', OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, WHATSAPP_ENABLED: 'false', KB_SEARCH_MODE: 'lexical', FEEDBACK_DB_FILE: ':memory:', MONGODB_DB_NAME: TEST_DB, ANTHROPIC_API_KEY: '', WATI_ACCESS_TOKEN: '', WATI_API_TOKEN: '', WATI_TOKEN: '' });
  ({ config } = await import('../src/config.js'));
  ({ getSession } = await import('../src/sessions.js'));
  ({ closeMongo, getDb } = await import('../src/mongo.js'));
  const { app } = await import('../src/app.js');
  server = await listen(app);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  try { await (await getDb()).dropDatabase(); } catch {}
  await closeMongo?.();
  await Promise.all([server, mock].filter(Boolean).map((s) => new Promise((resolve) => s.close(resolve))));
});

test('playground loads without WATI credentials; no secrets in configuration', async () => {
  const html = await (await fetch(base)).text();
  assert.match(html, /FOCASEdu Chat Test/);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.provider, 'openai');
  assert.equal(health.whatsappEnabled, false);
  assert.ok(!JSON.stringify(health).includes('test-only'));
  const kb = await (await fetch(`${base}/api/knowledge`)).json();
  assert.ok(kb.documents.some((d) => d.source === '30-fees-class-pricing.md' && d.text.includes('₹30,000')));
  assert.ok(kb.documents.some((d) => d.source === '33-fees-individual-subjects.md' && d.text.includes('₹10,000')));
  assert.ok(kb.documents.some((d) => d.source === '15-course-levels-and-subjects.md' && d.text.includes('Advanced Auditing')));
  const webhook = await fetch(`${base}/webhook/wati`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventType: 'message', owner: false, waId: '12345', text: 'fees' }) });
  assert.equal(webhook.status, 503);
});

test('questions send actual retrieved facts to OpenAI and preserve follow-up memory', async () => {
  calls = [];
  const first = await post('What are the fees for one group?', 'conversation');
  assert.equal(first.status, 200);
  assert.equal(first.data.meta.provider, 'openai');
  assert.ok(first.data.meta.sources.some((s) => s.source === '30-fees-class-pricing.md'));
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.ok(calls[0].body.messages.some((m) => m.role === 'system' && m.content.includes('₹30,000')));
  const second = await post('And both groups?', 'conversation');
  assert.equal(second.status, 200);
  assert.ok(calls[1].body.messages.some((m) => m.role === 'user' && m.content === 'What are the fees for one group?'));
  assert.ok(second.data.meta.sources.some((s) => s.source === '30-fees-class-pricing.md'));
});

test('level-specific corrections are retrieved for CA Final and Foundation questions', async () => {
  calls = [];
  const final = await post('What do you offer for CA Final?', 'ca-final');
  assert.equal(final.status, 200);
  assert.ok(final.data.meta.sources.some((s) => s.source === '15-course-levels-and-subjects.md'));
  assert.ok(calls.at(-1).body.messages.some((m) => m.role === 'system' && m.content.includes('Advanced Auditing')));

  const foundation = await post('What classes do you offer for Foundation?', 'foundation');
  assert.equal(foundation.status, 200);
  assert.ok(foundation.data.meta.sources.some((s) => s.source === '15-course-levels-and-subjects.md'));
  assert.ok(calls.at(-1).body.messages.some((m) => m.role === 'system' && m.content.includes('Business Laws')));
});

test('new chat clears history and previews cannot modify WhatsApp sessions', async () => {
  const live = getSession('conversation');
  live.history = [{ role: 'user', content: 'Live WhatsApp history' }];
  const reset = await fetch(`${base}/api/chat/conversation`, { method: 'DELETE' });
  assert.equal(reset.status, 200);
  await post('What are the fees?', 'conversation');
  const history = calls.at(-1).body.messages.filter((m) => m.role !== 'system');
  assert.equal(history.length, 1);
  assert.equal(getSession('conversation').history[0].content, 'Live WhatsApp history');
  await post('What courses do you offer?', 'another-tab');
  assert.equal(calls.at(-1).body.messages.filter((m) => m.role !== 'system').length, 1);
});

test('test reviews are stored locally and returned newest first', async () => {
  const invalid = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'review-chat', reviewer: '', content: '' }) });
  assert.equal(invalid.status, 400);

  const saved = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'review-chat', reviewer: 'Asha', content: 'The fee answer was accurate and clear.' }) });
  assert.equal(saved.status, 201);
  const review = (await saved.json()).review;
  assert.equal(review.reviewer, 'Asha');
  assert.equal(review.content, 'The fee answer was accurate and clear.');
  assert.equal(review.sessionId, 'review-chat');

  const reviews = (await (await fetch(`${base}/api/feedback`)).json()).reviews;
  assert.deepEqual(reviews[0], review);
});

test('handover, pause and resume work in preview without sending messages', async () => {
  assert.equal((await post('agent', 'handover')).data.meta.reason, 'handover');
  assert.deepEqual((await post('fees', 'handover')).data.replies, []);
  assert.equal((await post('bot', 'handover')).data.meta.reason, 'resumed');
  assert.equal((await post('fees', 'handover')).data.meta.provider, 'openai');
});

test('invalid requests are rejected before calling the model', async () => {
  const count = calls.length;
  for (const text of ['', '   ', {}, 123, 'x'.repeat(4001)]) assert.equal((await post(text)).status, 400);
  assert.equal((await post('fees', '../invalid')).status, 400);
  assert.equal((await post('fees', 'test', { provider: 'invalid' })).status, 400);
  const broken = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  assert.equal(broken.status, 400);
  assert.match(broken.headers.get('content-type'), /json/);
  assert.equal(calls.length, count);
});

test('errors are redacted, failed turns are not remembered, selected provider never falls back', async () => {
  fail = true;
  const result = await post('fees', 'failure');
  fail = false;
  assert.equal(result.status, 502);
  assert.match(result.data.error, /API key/);
  assert.ok(!JSON.stringify(result).includes('secret-test-token'));
  assert.deepEqual(getSession('preview:failure').history, []);
  await post('fees', 'failure');
  assert.equal(calls.at(-1).body.messages.filter((m) => m.role === 'user').length, 1);
  const { pickProvider } = await import('../src/ai.js');
  config.openai.apiKey = '';
  config.anthropic.apiKey = 'test-claude-key';
  try { assert.throws(() => pickProvider(), /OPENAI_API_KEY/); }
  finally { config.openai.apiKey = 'test-only'; config.anthropic.apiKey = ''; }
});

test('overlapping requests and reset cannot race the same conversation', async () => {
  delay = true;
  const arrived = new Promise((resolve) => { requestArrived = resolve; });
  const pending = post('fees', 'concurrent');
  await arrived;
  requestArrived = undefined;
  assert.equal((await post('fees', 'concurrent')).status, 409);
  assert.equal((await fetch(`${base}/api/chat/concurrent`, { method: 'DELETE' })).status, 409);
  assert.equal((await pending).status, 200);
  delay = false;
});

test('every exchange is stored, scored, and exportable for training', async () => {
  // WATI sends senderName on every inbound message, so each turn carries the name.
  await post('hello', 'scored', { name: 'Priya' });
  await post('what are the fees', 'scored', { name: 'Priya' });
  await post('send me the payment link', 'scored', { name: 'Priya' });

  const { leads, stats } = await (await fetch(`${base}/api/leads?channel=preview`)).json();
  const lead = leads.find((l) => l.waId === 'preview:scored');
  assert.ok(lead, 'the lead was recorded');
  assert.equal(lead.name, 'Priya');
  assert.equal(lead.userMessages, 3);
  assert.ok(stats.messages >= 6, 'questions and answers are both stored');

  // fees (14) + payment_link (30) + engagement for 3 messages (8) = 52
  assert.equal(lead.score, 52);
  assert.equal(lead.stage, 'warm');
  assert.deepEqual(lead.signals.map((s) => s.id).sort(), ['fees', 'payment_link']);

  const { lead: full } = await (await fetch(`${base}/api/leads/preview%3Ascored`)).json();
  assert.deepEqual(
    full.messages.filter((m) => m.role === 'user').map((m) => m.text),
    ['hello', 'what are the fees', 'send me the payment link']
  );

  // Scores are derived, so recomputing from stored turns must not change them.
  await fetch(`${base}/api/leads/rescore`, { method: 'POST' });
  const after = await (await fetch(`${base}/api/leads?channel=preview`)).json();
  assert.equal(after.leads.find((l) => l.waId === 'preview:scored').score, 52);

  const jsonl = await (await fetch(`${base}/api/export/training.jsonl?channel=preview`)).text();
  const example = JSON.parse(jsonl.split('\n').find((line) => line.includes('what are the fees')));
  assert.equal(example.messages[0].role, 'user');
  assert.equal(example.messages[1].role, 'assistant');

  const csv = await (await fetch(`${base}/api/export/leads.csv?channel=preview`)).text();
  assert.match(csv, /"Priya","52","warm"/);

  assert.equal((await fetch(`${base}/api/leads?stage=bogus`)).status, 400);
  assert.equal((await fetch(`${base}/api/leads/preview%3Anobody`)).status, 404);
});
