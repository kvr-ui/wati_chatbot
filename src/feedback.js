import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const dbFile = config.feedback.dbFile;
if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const row = (review) => ({
  id: Number(review.id),
  sessionId: review.session_id,
  reviewer: review.reviewer,
  content: review.content,
  createdAt: review.created_at,
});

export function saveFeedback({ sessionId, reviewer, content }) {
  const result = db.prepare(
    'INSERT INTO feedback (session_id, reviewer, content) VALUES (?, ?, ?)'
  ).run(sessionId, reviewer, content);
  return row(db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid));
}

export function listFeedback(limit = 50) {
  return db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?').all(limit).map(row);
}
