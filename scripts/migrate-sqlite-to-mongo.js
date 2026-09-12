import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { messages as messagesCollection, leads as leadsCollection, closeMongo } from '../src/mongo.js';
import { rescoreAll } from '../src/conversations.js';

/**
 * One-off import of conversations recorded while the bot used SQLite.
 *
 * Safe to re-run: messages are matched on (waId, createdAt, role, text) so a
 * second run inserts nothing rather than duplicating history.
 *
 *   npm run migrate:mongo
 *   npm run migrate:mongo -- path/to/conversations.sqlite
 */
const file = process.argv[2] || path.join(config.root, 'data', 'conversations.sqlite');

if (!existsSync(file)) {
  console.log(`Nothing to migrate: ${file} does not exist.`);
  process.exit(0);
}

const db = openDatabase(file);
const rows = db.prepare('SELECT * FROM messages ORDER BY id').all();
db.close();

if (!rows.length) {
  console.log('SQLite database has no messages. Nothing to migrate.');
  await closeMongo();
  process.exit(0);
}

const collection = await messagesCollection();
let inserted = 0;
let skipped = 0;

for (const row of rows) {
  // SQLite stored "YYYY-MM-DD HH:MM:SS" in UTC.
  const createdAt = new Date(`${row.created_at.replace(' ', 'T')}Z`);
  const key = { waId: row.wa_id, role: row.role, text: row.text, createdAt };

  if (await collection.findOne(key)) {
    skipped += 1;
    continue;
  }

  await collection.insertOne({
    ...key,
    name: row.name ?? null,
    channel: row.channel,
    triggerId: row.trigger_id ?? null,
    reason: row.reason ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    sources: row.sources ? JSON.parse(row.sources) : null,
    elapsedMs: row.elapsed_ms ?? null,
  });
  inserted += 1;
}

console.log(`Messages: ${inserted} imported, ${skipped} already present.`);

// Leads are derived, so rebuild them from the imported turns rather than
// copying the old rows - this also backfills firstSeen/lastSeen correctly.
const byLead = new Map();
for (const row of rows) {
  const at = new Date(`${row.created_at.replace(' ', 'T')}Z`);
  const entry = byLead.get(row.wa_id) ?? { first: at, last: at, name: null, channel: row.channel };
  if (at < entry.first) entry.first = at;
  if (at > entry.last) entry.last = at;
  if (row.name) entry.name = row.name;
  byLead.set(row.wa_id, entry);
}

const leads = await leadsCollection();
for (const [waId, { first, last, name, channel }] of byLead) {
  await leads.updateOne(
    { waId },
    { $set: { name, lastSeen: last }, $setOnInsert: { waId, channel, firstSeen: first } },
    { upsert: true }
  );
}

const rescored = await rescoreAll();
console.log(`Leads: ${byLead.size} imported and rescored.`);
for (const lead of rescored) {
  console.log(`  ${lead.waId}  score ${lead.score} (${lead.stage})  ${lead.userMessages} questions`);
}

await closeMongo();
