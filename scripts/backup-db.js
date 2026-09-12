import { readdirSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';

/**
 * Snapshots the databases while the bot keeps running.
 *
 * Uses VACUUM INTO rather than copying the file: a plain `cp` of a live SQLite
 * database can capture a half-written transaction (and misses the -wal file),
 * producing a backup that only fails when you finally need it.
 *
 *   npm run backup                  # snapshot, keep 7 days
 *   BACKUP_KEEP_DAYS=30 npm run backup
 */
const backupDir = process.env.BACKUP_DIR || path.join(config.root, 'backups');
const keepDays = Number(process.env.BACKUP_KEEP_DAYS || 7);

mkdirSync(backupDir, { recursive: true });

// "2026-09-12T07-42-11"
const stamp = new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-');

const targets = [
  { name: 'conversations', file: config.conversations.dbFile },
  { name: 'feedback', file: config.feedback.dbFile },
];

let failed = false;

for (const { name, file } of targets) {
  const out = path.join(backupDir, `${name}-${stamp}.sqlite`);
  try {
    const db = openDatabase(file);
    // VACUUM INTO needs a path literal; quotes doubled to escape.
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    db.close();
    console.log(`[ok]   ${name} -> ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
  } catch (err) {
    failed = true;
    console.error(`[fail] ${name}: ${err.message}`);
  }
}

/* ----------------------------- retention ------------------------------- */

const cutoff = Date.now() - keepDays * 86_400_000;
let removed = 0;

for (const entry of readdirSync(backupDir)) {
  if (!/^(conversations|feedback)-.*\.sqlite$/.test(entry)) continue;
  const full = path.join(backupDir, entry);
  if (statSync(full).mtimeMs < cutoff) {
    unlinkSync(full);
    removed += 1;
  }
}

console.log(`Retention: keeping ${keepDays} days, removed ${removed} old snapshot(s).`);
process.exit(failed ? 1 : 0);
