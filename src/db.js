import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Opens a SQLite file with the settings a long-running server needs.
 *
 * WAL matters here because the leads dashboard polls while the WATI webhook is
 * writing; in the default rollback journal those block each other, and a busy
 * database would throw SQLITE_BUSY rather than wait.
 */
export function openDatabase(file) {
  const onDisk = file !== ':memory:';
  if (onDisk) mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  if (onDisk) {
    db.exec('PRAGMA journal_mode = WAL');
    // Durable across process crashes; only a host power-loss can lose the last
    // commits, which is the right trade for chat logs.
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
