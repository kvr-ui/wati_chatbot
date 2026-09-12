import { readdirSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../src/config.js';

/**
 * Snapshots every collection this bot owns from MongoDB, one gzipped
 * mongodump archive per collection, into backups/.
 *
 * One archive per collection rather than one dump of the whole database:
 * mongodump only honours the LAST --collection flag if you pass several
 * (silently skipping the rest), and the database also holds other FOCAS
 * projects' collections that this bot should not be backing up.
 *
 *   npm run backup
 *   BACKUP_KEEP_DAYS=30 BACKUP_DIR=/mnt/backups npm run backup
 */
const backupDir = process.env.BACKUP_DIR || path.join(config.root, 'backups');
const keepDays = Number(process.env.BACKUP_KEEP_DAYS || 7);

mkdirSync(backupDir, { recursive: true });

// "2026-09-12T07-42-11"
const stamp = new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-');
const size = (f) => `${(statSync(f).size / 1024).toFixed(0)} KB`;

let failed = false;

for (const collection of [config.mongo.messages, config.mongo.leads, config.mongo.feedback]) {
  const archive = path.join(backupDir, `${collection}-${stamp}.archive.gz`);
  try {
    execFileSync('mongodump', [
      `--uri=${config.mongo.uri}`,
      `--db=${config.mongo.dbName}`,
      `--collection=${collection}`,
      `--archive=${archive}`,
      '--gzip',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`[ok]   ${collection.padEnd(13)} -> ${archive} (${size(archive)})`);
  } catch (err) {
    failed = true;
    const detail = err.stderr?.toString().trim().split('\n').pop() || err.message;
    console.error(`[fail] ${collection}: ${detail}`);
    console.error('       mongodump comes from mongodb-database-tools.');
  }
}

/* ------------------------------ retention ------------------------------- */

const cutoff = Date.now() - keepDays * 86_400_000;
let removed = 0;

for (const entry of readdirSync(backupDir)) {
  if (!/-\d{4}-\d{2}-\d{2}T[\d-]+\.archive\.gz$/.test(entry)) continue;
  const full = path.join(backupDir, entry);
  if (statSync(full).mtimeMs < cutoff) {
    rmSync(full, { force: true });
    removed += 1;
  }
}

console.log(`Retention: keeping ${keepDays} days, removed ${removed} old snapshot(s).`);
process.exit(failed ? 1 : 0);
