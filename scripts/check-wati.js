import { config } from '../src/config.js';

/**
 * Verifies WATI credentials with read-only calls, then optionally sends a
 * real test message:   npm run check:wati -- 919812345678
 */
const target = process.argv[2];

const base = config.wati.endpoint;
const token = config.wati.token;

if (!base || !token) {
  console.error('Missing WATI credentials. Set WATI_API_ENDPOINT and WATI_ACCESS_TOKEN in .env');
  process.exit(1);
}

const mask = (t) => `${t.slice(0, 12)}...${t.slice(-6)} (${t.length} chars)`;

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, json };
}

console.log('Endpoint :', base);
console.log('Tenant   :', base.split('/').pop());
console.log('Token    :', mask(token));
console.log('');

const contacts = await call('/api/v1/getContacts?pageSize=1&pageNumber=0');
console.log(`[${contacts.ok ? 'PASS' : 'FAIL'}] auth / read contacts  -> HTTP ${contacts.status}`);
if (!contacts.ok) {
  console.error(JSON.stringify(contacts.json).slice(0, 400));
  process.exit(1);
}
console.log('       contacts in account:', contacts.json.link?.total ?? contacts.json.total ?? 'n/a');

const templates = await call('/api/v1/getMessageTemplates?pageSize=100&pageNumber=0');
console.log(`[${templates.ok ? 'PASS' : 'FAIL'}] read message templates -> HTTP ${templates.status}`);
if (templates.ok) {
  const list = templates.json.messageTemplates || [];
  const approved = list.filter((t) => /approved/i.test(t.status || ''));
  console.log(`       ${list.length} templates, ${approved.length} approved`);
  for (const t of approved.slice(0, 10)) console.log(`         - ${t.elementName} (${t.category})`);
}

if (!target) {
  console.log('\nRead-only checks passed. To send a real test message:');
  console.log('  npm run check:wati -- 919812345678   (number with country code, no +)');
  process.exit(0);
}

console.log(`\nSending a session message to ${target} ...`);
const send = await call(
  `/api/v1/sendSessionMessage/${encodeURIComponent(target)}?messageText=${encodeURIComponent(
    'Test message from the WATI bot setup check.'
  )}`,
  { method: 'POST' }
);
console.log(`[${send.ok && send.json.result !== false ? 'PASS' : 'FAIL'}] send session message -> HTTP ${send.status}`);
console.log('      ', JSON.stringify(send.json).slice(0, 400));
if (send.json?.info || send.json?.result === false) {
  console.log(
    '\nNote: free-form messages only deliver if that number messaged your WhatsApp\n' +
      'business number within the last 24 hours. Otherwise use an approved template.'
  );
}
