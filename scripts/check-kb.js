import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { buildChunks } from '../src/kb.js';
import { loadTriggers } from '../src/keywords.js';

/**
 * Sanity-checks the knowledge folder after an edit:  npm run check:kb
 * Reports any file that splits into more than one chunk, any file missing its
 * Asked as / Send lines, and any keywords.json kbFilter that matches nothing.
 */
const chunks = buildChunks();
const byFile = new Map();
for (const c of chunks) {
  if (!byFile.has(c.source)) byFile.set(c.source, []);
  byFile.get(c.source).push(c);
}

let problems = 0;
console.log(`knowledge/  ${byFile.size} files, ${chunks.length} chunks\n`);

for (const [file, list] of [...byFile].sort()) {
  const chars = list.reduce((n, c) => n + c.text.length, 0);
  const raw = fs.readFileSync(path.join(config.kb.dir, file), 'utf8');
  const notes = [];

  if (list.length > 1) notes.push(`SPLIT into ${list.length} chunks - trim it under ${config.kb.chunkSize}`);
  else if (chars > config.kb.chunkSize - 60) notes.push(`${chars} chars - close to the ${config.kb.chunkSize} limit`);
  // A file marked reference-only is background the bot may draw on, not a reply to send.
  const referenceOnly = /<!--\s*reference-only/i.test(raw);
  if (!referenceOnly) {
    if (!/^\s*(Also )?[Aa]sked as:/m.test(raw)) notes.push('no "Asked as:" line - students will struggle to reach it');
    if (!/^\s*Send:/m.test(raw)) notes.push('no "Send:" line - the model has to compose the reply itself');
  }

  problems += notes.filter((n) => !n.includes('close to')).length;
  const status = notes.length ? notes.map((n) => `\n      ! ${n}`).join('') : '';
  console.log(`  ${String(chars).padStart(4)}  ${file}${status}`);
}

console.log('\nkeywords.json routes:');
const seen = new Set();
for (const t of loadTriggers().triggers) {
  if (!t.kbFilter || seen.has(t.kbFilter)) continue;
  seen.add(t.kbFilter);
  const hits = chunks.filter((c) => `${c.source} ${c.section}`.toLowerCase().includes(t.kbFilter.toLowerCase()));
  if (!hits.length) problems++;
  console.log(`  ${t.kbFilter.padEnd(11)} ${hits.length ? `${hits.length} file(s)` : 'MATCHES NOTHING - the trigger falls back to a whole-index search'}`);
}

console.log(problems ? `\n${problems} problem(s) to fix.` : '\nAll good.');
process.exit(problems ? 1 : 0);
