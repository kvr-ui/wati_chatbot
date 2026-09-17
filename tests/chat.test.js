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
    res.end(JSON.stringify({ choices: [{ message: { content: 'One of our executives will reach out to you shortly with the pricing details.' } }], model: 'gpt-4o-mini-test', usage: {} }));
  }));
  Object.assign(process.env, { OPENAI_API_KEY: 'test-only', OPENAI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, WHATSAPP_ENABLED: 'false', KB_SEARCH_MODE: 'lexical', MONGODB_DB_NAME: TEST_DB, WATI_ACCESS_TOKEN: '', WATI_API_TOKEN: '', WATI_TOKEN: '' });
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
  assert.ok(kb.documents.some((d) => d.source === '30-fees-pricing.md' && d.text.includes('One of our executives will reach out')));
  // Pricing is shared only by an executive, so no amount may sit anywhere the bot can retrieve it.
  assert.ok(!kb.documents.some((d) => /₹|\d{1,2},\d{3}|\d+\s?k\b/i.test(d.text)), 'a price is in the knowledge base');
  assert.ok(kb.documents.some((d) => d.source === '15-course-levels-and-subjects.md' && d.text.includes('Advanced Auditing')));
  const webhook = await fetch(`${base}/webhook/wati`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventType: 'message', owner: false, waId: '12345', text: 'fees' }) });
  assert.equal(webhook.status, 503);
});

test('a quoted reply to the campaign image is read as text, not turned away as media', async () => {
  // WhatsApp lets a lead answer the JAN 2027 ad by quoting it; WATI then stamps
  // the message with a type of its own even though real words came through.
  const { parseWatiEvent } = await import('../src/app.js');
  const quoted = parseWatiEvent({
    eventType: 'message', owner: false, waId: '12345', senderName: 'Lead',
    type: 'quoted', text: 'JAN 2027',
  });
  assert.equal(quoted.type, 'text');
  assert.equal(quoted.text, 'JAN 2027');

  // A photo with no caption still has nothing to answer.
  const photo = parseWatiEvent({ eventType: 'message', owner: false, waId: '12345', type: 'image' });
  assert.equal(photo.type, 'image');
});

test('questions send actual retrieved facts to OpenAI and preserve follow-up memory', async () => {
  calls = [];
  const first = await post('What are the fees for one group?', 'conversation');
  assert.equal(first.status, 200);
  assert.equal(first.data.meta.provider, 'openai');
  assert.ok(first.data.meta.sources.some((s) => s.source === '30-fees-pricing.md'));
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.ok(calls[0].body.messages.some((m) => m.role === 'system' && m.content.includes('NEVER share any price')));
  const second = await post('And both groups?', 'conversation');
  assert.equal(second.status, 200);
  assert.ok(calls[1].body.messages.some((m) => m.role === 'user' && m.content === 'What are the fees for one group?'));
  assert.ok(second.data.meta.sources.some((s) => s.source === '30-fees-pricing.md'));
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
  const broken = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  assert.equal(broken.status, 400);
  assert.match(broken.headers.get('content-type'), /json/);
  assert.equal(calls.length, count);
});

test('errors are redacted, failed turns are not remembered, a missing OpenAI key is named', async () => {
  fail = true;
  const result = await post('fees', 'failure');
  fail = false;
  assert.equal(result.status, 502);
  assert.match(result.data.error, /API key/);
  assert.ok(!JSON.stringify(result).includes('secret-test-token'));
  assert.deepEqual(getSession('preview:failure').history, []);
  // Not remembered, but still on record, so the lead's message is not lost.
  const failed = await (await getDb()).collection(config.mongo.messages).findOne({ waId: 'preview:failure', reason: 'error' });
  assert.equal(failed?.text, 'fees');
  await post('fees', 'failure');
  assert.equal(calls.at(-1).body.messages.filter((m) => m.role === 'user').length, 1);
  const { assertAiConfigured } = await import('../src/ai.js');
  config.openai.apiKey = '';
  try { assert.throws(() => assertAiConfigured(), /OPENAI_API_KEY/); }
  finally { config.openai.apiKey = 'test-only'; }
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

test('the campaign phrase opts in one lead at a time and survives a restart', async () => {
  const { matchesUnlockPhrase, isOptedIn, optIn, loadOptIns } = await import('../src/optin.js');

  assert.ok(matchesUnlockPhrase('Hi, I saw the ad for the JAN-2027 batch'));
  assert.ok(matchesUnlockPhrase('interested in January 2027'));
  assert.ok(!matchesUnlockPhrase('what are the fees'));
  assert.ok(!matchesUnlockPhrase('is the jan 2026 batch still open'));
  assert.ok(matchesUnlockPhrase('YOUR LAST ATTEMPT'));
  assert.ok(matchesUnlockPhrase('Hi! Your Last Attempt - tell me more'));
  assert.ok(!matchesUnlockPhrase('what is inside your last attempt kit?'));

  const lead = '919000000001';
  const other = '919000000002';
  assert.equal(await isOptedIn(lead), false);
  await optIn(lead, { name: 'Lead', text: 'Jan 2027 batch details please' });

  // Only that one number is unlocked; the next contact is still ignored.
  assert.equal(await isOptedIn(lead), true);
  assert.equal(await isOptedIn(other), false);
  assert.equal(await isOptedIn('+91 90000 00001'), true);

  const stored = await (await getDb()).collection(config.mongo.optins).findOne({ waId: lead });
  assert.equal(stored.text, 'Jan 2027 batch details please');
  assert.ok((await loadOptIns()) >= 1);

  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health.whatsappUnlockPhrases, ['jan 2027', 'january 2027', 'your last attempt']);
  assert.equal(typeof health.whatsappOptIns, 'number');
  assert.equal(health.whatsappOptInHours, 48);
  assert.ok(!JSON.stringify(health).includes(lead)); // real numbers stay out of /health
});

test('a campaign opt-in keeps the bot on for 48 hours, then it goes quiet until the phrase comes again', async () => {
  const { isOptedIn, optIn, loadOptIns } = await import('../src/optin.js');
  const optins = (await getDb()).collection(config.mongo.optins);
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

  // Opted in 47 hours ago: still on. 49 hours ago: off. Both as read back after a restart.
  await optins.insertMany([
    { waId: '919000000011', text: 'your last attempt', createdAt: hoursAgo(47), unlockedAt: hoursAgo(47) },
    { waId: '919000000012', text: 'your last attempt', createdAt: hoursAgo(49), unlockedAt: hoursAgo(49) },
    // Saved before the window existed: only createdAt, which counts as the start.
    { waId: '919000000013', text: 'jan 2027', createdAt: hoursAgo(72) },
  ]);
  await loadOptIns();
  assert.equal(await isOptedIn('919000000011'), true);
  assert.equal(await isOptedIn('919000000012'), false);
  assert.equal(await isOptedIn('919000000013'), false);

  // Sending the phrase again opens a fresh window from now, in memory and in the database.
  await optIn('919000000012', { name: 'Lead', text: 'Your Last Attempt' });
  assert.equal(await isOptedIn('919000000012'), true);
  const reopened = await optins.findOne({ waId: '919000000012' });
  assert.ok(Date.now() - reopened.unlockedAt.getTime() < 60_000);
  assert.ok(Date.now() - reopened.createdAt.getTime() > 48 * 60 * 60 * 1000, 'the first opt-in date was overwritten');
});

test('the 48 hours run from the lead\'s last message, not from the phrase', async () => {
  const { isOptedIn, touchOptIn, loadOptIns } = await import('../src/optin.js');
  const optins = (await getDb()).collection(config.mongo.optins);
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

  // Phrase sent three days ago, but still chatting yesterday: the bot stays on.
  await optins.insertMany([
    { waId: '919000000021', createdAt: hoursAgo(72), unlockedAt: hoursAgo(72), lastMessageAt: hoursAgo(24) },
    { waId: '919000000022', createdAt: hoursAgo(72), unlockedAt: hoursAgo(72), lastMessageAt: hoursAgo(49) },
  ]);
  await loadOptIns();
  assert.equal(await isOptedIn('919000000021'), true);
  assert.equal(await isOptedIn('919000000022'), false);

  // Each message restarts the clock, and the database records it for the next restart.
  await touchOptIn('919000000021');
  const touched = await optins.findOne({ waId: '919000000021' });
  assert.ok(Date.now() - touched.lastMessageAt.getTime() < 60_000);

  // A message after the window has closed does not reopen it; only the phrase does.
  await touchOptIn('919000000022');
  assert.equal(await isOptedIn('919000000022'), false);
  assert.ok(Date.now() - (await optins.findOne({ waId: '919000000022' })).lastMessageAt.getTime() > 48 * 60 * 60 * 1000);
});

test('the Jan 2027 ad opens with the group question and answers with the matching pitch', async () => {
  const { matchGroup } = await import('../src/campaign.js');

  // Free-text answers are read as a group; anything else is not.
  assert.equal(matchGroup('2'), 'Group 2');
  assert.equal(matchGroup('grp-1'), 'Group 1');
  assert.equal(matchGroup('Group 1 and Group 2'), 'Both Groups');
  assert.equal(matchGroup('unit 2d'), 'Unit 2D');
  assert.equal(matchGroup('2d'), 'Unit 2D'); // the bare 2 must not win here
  assert.equal(matchGroup('not sure yet'), null);

  const session = 'campaign';
  // The ad message is answered with the question alone - nothing else.
  const asked = await post('Hi, I saw the ad for the JAN-2027 batch', session);
  assert.equal(asked.data.meta.reason, 'campaign_group_asked');
  assert.equal(asked.data.replies.length, 1);
  assert.match(asked.data.replies[0], /Which group are you planning to take the exam in January 2027\?/);
  assert.match(asked.data.replies[0], /4\. Unit 2D/);

  // A question in place of an answer is answered, and the group question stays open.
  const question = await post('what is the difference between them?', session);
  assert.notEqual(question.data.meta.reason, 'campaign_group_reask');
  assert.ok(!question.data.replies[0].includes('Which group'));

  // An unclear answer is re-asked exactly once.
  const reask = await post('not sure', session);
  assert.equal(reask.data.meta.reason, 'campaign_group_reask');
  assert.match(reask.data.replies[0], /Which group are you planning/);

  // Answering echoes the chosen group back inside the offerings message.
  const answered = await post('Group 2', session);
  assert.equal(answered.data.meta.reason, 'campaign_group_answered');
  assert.equal(answered.data.meta.group, 'Group 2');
  assert.match(answered.data.replies[0], /we offer classes for Group 2/);
  assert.match(answered.data.replies[0], /less than 3\.5 months/);
  assert.match(answered.data.replies[0], /Infinite Question Bank/);

  // The answer is stored, so a restart cannot lose it or re-ask the question.
  const stored = await (await getDb()).collection(config.mongo.campaign).findOne({ waId: `preview:${session}` });
  assert.equal(stored.group, 'Group 2');
  assert.equal(stored.status, 'answered');

  // From here the bot is back to normal answering, and never asks again. A
  // question that happens to carry the ad phrase is still answered as one.
  const after = await post('Jan 2027 - what are the fees?', session);
  assert.notEqual(after.data.meta.reason, 'campaign_group_asked');
  assert.match(after.data.replies[0], /pricing details/);

  // Replying to the ad a second time is met with the group already on file,
  // not the question again and not a stranger's welcome line.
  const again = await post('JAN 2027', session);
  assert.equal(again.data.meta.reason, 'campaign_returning_lead');
  assert.match(again.data.replies[0], /Welcome back/);
  assert.match(again.data.replies[0], /Group 2 in January 2027/);
  assert.ok(!again.data.replies[0].includes('Which group'));

  // Naming a group counts as a buying signal on the lead record.
  const { lead } = await (await fetch(`${base}/api/leads/preview%3A${session}`)).json();
  assert.ok(lead.signals.some((s) => s.id === 'campaign_group'));
});

test('a lead who never names a group is let through after the second ask', async () => {
  const session = 'campaign-giveup';
  assert.equal((await post('interested in January 2027', session)).data.meta.reason, 'campaign_group_asked');
  assert.equal((await post('hmm', session)).data.meta.reason, 'campaign_group_reask');

  // Asked twice is enough: the third message is answered normally, not scripted.
  const third = await post('what are the fees for one group?', session);
  assert.notEqual(third.data.meta.reason, 'campaign_group_reask');
  assert.match(third.data.replies[0], /pricing details/);

  // Resetting the playground chat lets a tester run the script from the top.
  assert.equal((await fetch(`${base}/api/chat/${session}`, { method: 'DELETE' })).status, 200);
  assert.equal((await post('jan 2027', session)).data.meta.reason, 'campaign_group_asked');
});

test('the installment offer never travels without its no-amounts rule', async () => {
  const { buildChunks, search, ensureIndex } = await import('../src/kb.js');
  await ensureIndex({ log: () => {} });

  // The offer and the restriction must land in the SAME chunk. They sit in one
  // file, and a file over KB chunkSize is split - which would let the model
  // retrieve "we can split this into 2 installments" with no rule attached.
  const offers = buildChunks().filter((c) => /2 installments/i.test(c.text));
  assert.ok(offers.length >= 2, 'expected the discount reply and the closing line');
  for (const chunk of offers) {
    assert.match(chunk.text, /NEVER state, split or confirm an installment amount/,
      `${chunk.source} offers installments without the no-amounts rule`);
  }

  // A lead hesitating on price reaches the closing line; the fees filter keeps it in scope.
  const hits = await search('can I pay in 2 parts', { filter: 'fee' });
  assert.equal(hits[0].source, '34-fees-installment-close.md');

  // The fees trigger carries the same rule, for the path that skips retrieval ranking.
  const { trigger } = await (await fetch(`${base}/match?text=${encodeURIComponent('emi available?')}`)).json();
  assert.equal(trigger.id, 'fees');
  assert.match(trigger.prompt, /Never state, split or confirm an installment amount/);
});

test('a lead who replies STOP gets no reply, now or ever, even after a restart', async () => {
  const session = 'stopped';
  // Mid-campaign too: STOP must not be read as an unclear group answer and re-asked.
  assert.equal((await post('jan 2027', session)).data.meta.reason, 'campaign_group_asked');

  const count = calls.length;
  const stop = await post('STOP', session);
  assert.deepEqual(stop.data.replies, []);
  assert.equal(stop.data.meta.reason, 'opted_out');

  for (const text of ['what are the fees?', 'bot', 'Jan 2027', 'hello']) {
    const later = await post(text, session);
    assert.deepEqual(later.data.replies, [], `"${text}" was answered after STOP`);
    assert.equal(later.data.meta.reason, 'opted_out');
  }
  assert.equal(calls.length, count, 'the model was called for an opted-out lead');

  // Stored, so the in-memory list is not the only record.
  const stored = await (await getDb()).collection(config.mongo.optouts).findOne({ waId: `preview:${session}` });
  assert.equal(stored.text, 'STOP');

  // "stop" inside a real question is not an opt-out.
  assert.notEqual((await post('which bus stop is near the centre?', 'not-stopped')).data.meta.reason, 'opted_out');
  assert.notEqual((await post('can I stop the course midway?', 'not-stopped')).data.meta.reason, 'opted_out');

  // A STOP in a sentence counts too.
  for (const [i, text] of ['please stop', 'Stop messaging me!', "don't text me again", 'remove my number'].entries()) {
    const said = await post(text, `stopped-phrase-${i}`);
    assert.deepEqual(said.data.replies, [], `"${text}" was answered`);
    assert.equal(said.data.meta.reason, 'opted_out', `"${text}" was not read as STOP`);
  }

  // Only the playground reset lifts it, so testers can run the chat again.
  assert.equal((await fetch(`${base}/api/chat/${session}`, { method: 'DELETE' })).status, 200);
  assert.notEqual((await post('what are the fees?', session)).data.meta.reason, 'opted_out');
});

test('the "Your Last Attempt" ad starts the same group question as Jan 2027', async () => {
  const session = 'last-attempt';
  const asked = await post('YOUR LAST ATTEMPT', session);
  assert.equal(asked.data.meta.reason, 'campaign_group_asked');
  assert.match(asked.data.replies[0], /Which group are you planning/);

  const answered = await post('1', session);
  assert.equal(answered.data.meta.reason, 'campaign_group_answered');
  assert.match(answered.data.replies[0], /we offer classes for Group 1/);

  // Asking about the kit by name is a question, not the ad.
  assert.notEqual((await post('what is in your last attempt kit?', 'kit-question')).data.meta.reason, 'campaign_group_asked');
});

test('a WhatsApp STOP is stored as digits, so any spelling of the number stays silenced', async () => {
  const { handleMessage } = await import('../src/handler.js');
  const { isOptedOut } = await import('../src/optout.js');
  const stop = await handleMessage({ waId: '+91 98000 00001', name: 'Lead', text: 'STOP' });
  assert.equal(stop.meta.reason, 'opted_out');

  const stored = await (await getDb()).collection(config.mongo.optouts).findOne({ waId: '919800000001' });
  assert.ok(stored, 'opt-out was not saved under the digits-only id');
  assert.equal(await isOptedOut('919800000001'), true);
  assert.equal(await isOptedOut('+919800000001'), true);
});

test('numbers inside a real sentence are not read as a group', async () => {
  const { matchGroup } = await import('../src/campaign.js');
  assert.equal(matchGroup('can I pay in 2 installments'), null);
  assert.equal(matchGroup('I paid 1 hour ago'), null);
  assert.equal(matchGroup('grp 1 pls'), 'Group 1');
  assert.equal(matchGroup('g1 and g2'), 'Both Groups');
  assert.equal(matchGroup('one'), 'Group 1');
  assert.equal(matchGroup('7'), null);
});

test('mid-campaign: asking for a person hands over, and a question with the ad phrase is answered too', async () => {
  const session = 'campaign-handover';
  assert.equal((await post('jan 2027', session)).data.meta.reason, 'campaign_group_asked');
  const handover = await post('I want to talk to a counsellor', session);
  assert.equal(handover.data.meta.reason, 'handover');
  assert.deepEqual((await post('hello?', session)).data.replies, []);

  // A new lead whose first message is a question gets the answer, then the group question.
  const both = await post('is the kit good for your last attempt?', 'campaign-question-first');
  assert.equal(both.data.meta.reason, 'campaign_group_asked');
  assert.equal(both.data.replies.length, 2);
  assert.match(both.data.replies[0], /pricing details/);
  assert.match(both.data.replies[1], /Which group are you planning/);

  // Naming the group and asking something in one message gets the pitch and the answer.
  const named = await post('Group 1, what are the fees?', 'campaign-question-first');
  assert.equal(named.data.meta.reason, 'campaign_group_answered');
  assert.equal(named.data.replies.length, 2);
  assert.match(named.data.replies[0], /we offer classes for Group 1/);
  assert.match(named.data.replies[1], /pricing details/);
});

test('"agent" inside a question is not a handover', async () => {
  for (const text of ['what agent fees', 'an executive will call?']) {
    assert.notEqual((await post(text, 'not-handover')).data.meta.reason, 'handover', text);
  }
});

test('a handover pause outlives the session and is stored, and an agent message extends it', async () => {
  const { isPaused, extendHandover } = await import('../src/handover.js');
  const session = 'handover-long';
  assert.equal((await post('agent', session)).data.meta.reason, 'handover');

  // The in-memory session expires (SESSION_TTL_MINUTES) - the bot must stay silent.
  const ttl = config.bot.sessionTtlMs;
  config.bot.sessionTtlMs = -1;
  try {
    assert.deepEqual((await post('fees', session)).data.replies, []);
  } finally {
    config.bot.sessionTtlMs = ttl;
  }

  const stored = await (await getDb()).collection(config.mongo.handovers).findOne({ waId: `preview:${session}` });
  assert.ok(stored.pausedUntil.getTime() > Date.now());

  assert.equal(await extendHandover(`preview:${session}`), true);
  assert.equal(await extendHandover('preview:nobody-paused'), false);
  assert.equal(await isPaused('preview:nobody-paused'), false);

  // A new chat in the playground clears it.
  assert.equal((await fetch(`${base}/api/chat/${session}`, { method: 'DELETE' })).status, 200);
  assert.equal(await isPaused(`preview:${session}`), false);
});

test('a photo gets one short notice, a reaction gets nothing, and nothing during a handover', async () => {
  const { handleMessage } = await import('../src/handler.js');
  const photo = await handleMessage({ waId: 'preview:media', type: 'image', text: '' });
  assert.equal(photo.meta.reason, 'non_text');
  assert.match(photo.replies[0], /type your question/);
  assert.deepEqual((await handleMessage({ waId: 'preview:media', type: 'image', text: '' })).replies, []);
  assert.deepEqual((await handleMessage({ waId: 'preview:media-2', type: 'reaction', text: '' })).replies, []);

  await post('agent', 'media-handover');
  assert.deepEqual((await handleMessage({ waId: 'preview:media-handover', type: 'image', text: '' })).replies, []);

  // The webhook parser lets media through, and marks what we sent as outgoing.
  const { parseWatiEvent } = await import('../src/app.js');
  assert.equal(parseWatiEvent({ eventType: 'message', owner: false, waId: '91', type: 'image' }).skip, false);
  const sent = parseWatiEvent({ eventType: 'sessionMessageSent', owner: true, waId: '91' });
  assert.equal(sent.outgoing, true);
  assert.equal(sent.skip, true);
});

test('a WATI retry is recognised even after the in-memory list is gone', async () => {
  const { isNewMessage } = await import('../src/dedup.js');
  assert.equal(await isNewMessage('wamid-test-1'), true);
  assert.equal(await isNewMessage('wamid-test-1'), false);
  const stored = await (await getDb()).collection(config.mongo.webhookEvents).findOne({ messageId: 'wamid-test-1' });
  assert.ok(stored);
});

test('long replies full of emoji are split to fit the URL as well as WhatsApp', async () => {
  const { splitLongText } = await import('../src/wati.js');
  const parts = splitLongText('🙏 नमस्ते '.repeat(500));
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(encodeURIComponent(part).length <= 6000 && part.length <= 4000);
  assert.deepEqual(splitLongText('short'), ['short']);
});

test('a lead back after 48 hours of silence is asked the group question again; inside the window, welcomed back', async () => {
  const campaign = (await getDb()).collection(config.mongo.campaign);
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
  await campaign.insertMany([
    { waId: 'preview:returns-late', status: 'answered', group: 'Group 1', name: 'Lead', lastSeenAt: hoursAgo(49) },
    { waId: 'preview:returns-soon', status: 'answered', group: 'Group 1', name: 'Lead', lastSeenAt: hoursAgo(1) },
    // Saved before lastSeenAt existed, answered days ago - like the leads already in production.
    { waId: 'preview:returns-legacy', status: 'answered', group: 'Group 1', name: 'Lead', answeredAt: hoursAgo(120), updatedAt: hoursAgo(120) },
  ]);

  for (const session of ['returns-late', 'returns-legacy']) {
    const asked = await post('Your Last Attempt', session);
    assert.equal(asked.data.meta.reason, 'campaign_group_asked', session);
    assert.match(asked.data.replies[0], /Which group are you planning/);

    const answered = await post('2', session);
    assert.equal(answered.data.meta.reason, 'campaign_group_answered');
    assert.match(answered.data.replies[0], /we offer classes for Group 2/);
  }
  const stored = await campaign.findOne({ waId: 'preview:returns-late' });
  assert.equal(stored.previousGroup, 'Group 1');
  assert.ok(Date.now() - stored.lastSeenAt.getTime() < 60_000);

  const soon = await post('Your Last Attempt', 'returns-soon');
  assert.equal(soon.data.meta.reason, 'campaign_returning_lead');
  assert.match(soon.data.replies[0], /Welcome back/);

  // Having just answered, the phrase again is inside the window: welcomed, not re-asked.
  assert.equal((await post('Your Last Attempt', 'returns-late')).data.meta.reason, 'campaign_returning_lead');
});
