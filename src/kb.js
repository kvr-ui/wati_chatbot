import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { config } from './config.js';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv']);
let openai;
let store = null; // { hash, model, chunks: [{ id, text, source, section, embedding }] }

const client = () => (openai ??= new OpenAI({
  apiKey: config.openai.apiKey,
  ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
  timeout: 20_000,
  maxRetries: 0,
}));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/* ------------------------------- loading ------------------------------- */

function readKnowledgeFiles() {
  const dir = config.kb.dir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
    .filter((f) => f !== 'keywords.json')
    .sort()
    .map((f) => ({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

function chunkMarkdown(rawContent, source) {
  const { chunkSize, chunkOverlap } = config.kb;
  // HTML comments are authoring notes, not knowledge - keep them out of the index.
  const content = rawContent.replace(/<!--[\s\S]*?-->/g, '');
  const chunks = [];
  const headings = [];
  let buffer = '';
  let section = '';

  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    if (text.length <= chunkSize) {
      chunks.push({ text, source, section });
      return;
    }
    for (let i = 0; i < text.length; i += chunkSize - chunkOverlap) {
      const slice = text.slice(i, i + chunkSize).trim();
      if (slice) chunks.push({ text: slice, source, section });
    }
  };

  for (const line of content.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      headings.length = level - 1;
      headings[level - 1] = heading[2].trim();
      section = headings.filter(Boolean).join(' > ');
      buffer += `${section}\n`;
      continue;
    }
    buffer += `${line}\n`;
    if (buffer.length >= chunkSize) flush();
  }
  flush();
  return chunks;
}

function chunkJson(content, source) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return [{ text: content.slice(0, config.kb.chunkSize), source, section: '' }];
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data.faqs) ? data.faqs : [data];
  return rows.map((row, i) => {
    const q = row.question ?? row.q ?? row.title ?? '';
    const a = row.answer ?? row.a ?? row.content ?? '';
    const text = q || a ? `Q: ${q}\nA: ${a}` : JSON.stringify(row);
    return { text, source, section: row.category || row.section || q || `item ${i + 1}` };
  });
}

export function buildChunks() {
  const chunks = [];
  for (const file of readKnowledgeFiles()) {
    const ext = path.extname(file.name).toLowerCase();
    const built = ext === '.json' ? chunkJson(file.content, file.name) : chunkMarkdown(file.content, file.name);
    chunks.push(...built);
  }
  return chunks.map((c, i) => ({ id: `c${i}`, ...c }));
}

/* ------------------------------ embedding ------------------------------ */

async function embedBatch(texts) {
  const out = [];
  const BATCH = 96;
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await client().embeddings.create({
      model: config.openai.embeddingModel,
      input: texts.slice(i, i + BATCH),
    });
    out.push(...res.data.map((d) => d.embedding));
  }
  return out;
}

function corpusHash(chunks) {
  return sha1(`${config.openai.embeddingModel}::${chunks.map((c) => c.text).join(' ')}`);
}

/** Semantic search needs OpenAI embeddings; Anthropic has no embeddings API. */
const embeddingsAvailable = () => !!config.openai.apiKey && config.kb.searchMode !== 'lexical';

/** Builds (or reuses) the embedding index. Set force to ignore the cache. */
export async function ensureIndex({ force = false, log = () => {} } = {}) {
  const chunks = buildChunks();
  if (!chunks.length) {
    store = { hash: 'empty', mode: 'none', chunks: [] };
    log('No knowledge files found in knowledge/ - the bot will answer from the system prompt only.');
    return store;
  }

  if (!embeddingsAvailable()) {
    // Claude-only setup: fall back to keyword search over the same chunks.
    store = { hash: corpusHash(chunks), mode: 'lexical', model: null, chunks };
    log(`Knowledge base ready: ${chunks.length} chunks, keyword search.`);
    return store;
  }

  const hash = corpusHash(chunks);
  if (!force && store?.hash === hash) return store;

  if (!force && fs.existsSync(config.kb.cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(config.kb.cacheFile, 'utf8'));
      if (cached.hash === hash) {
        store = cached;
        log(`Loaded ${cached.chunks.length} cached knowledge chunks.`);
        return store;
      }
    } catch {
      /* corrupt cache - rebuild below */
    }
  }

  log(`Embedding ${chunks.length} knowledge chunks with ${config.openai.embeddingModel}...`);
  let embeddings;
  try {
    embeddings = await embedBatch(chunks.map((c) => `${c.section}\n${c.text}`));
  } catch (err) {
    if (config.kb.searchMode !== 'auto') throw err;
    store = { hash, mode: 'lexical', model: null, chunks };
    log('Semantic search unavailable; using keyword search over the knowledge files.');
    return store;
  }
  store = {
    hash,
    mode: 'embedding',
    model: config.openai.embeddingModel,
    chunks: chunks.map((c, i) => ({ ...c, embedding: embeddings[i] })),
  };

  fs.mkdirSync(path.dirname(config.kb.cacheFile), { recursive: true });
  fs.writeFileSync(config.kb.cacheFile, JSON.stringify(store));
  log(`Knowledge base indexed: ${store.chunks.length} chunks.`);
  return store;
}

/* ------------------------------ retrieval ------------------------------ */

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Chat messages are full of filler. Anything left in here that is rare in the corpus gets
// a high IDF and can decide the ranking on its own - "I can give ONLY evening time" once
// out-ranked the price list by matching "only kit".
const STOP_WORDS = new Set(
  `a an and are as at be by can do does for from have how i in is it me my of on or our so
   that the to want we what when where which who why you your please tell give
   also already always any anything been before being but could did doing dont even ever
   every get getting going got had has having here him his into its just let like make may
   might more most must no not now off only other out over own said same see shall she
   should since some still such take than their them then there these they thing things
   this those through under until upon use very was way well were will with would yes
   hai hain kar karo mujhe mera meri mere aur bhi sir mam madam maam bhai bro yaar plz pls
   मुझे मेरा मेरी क्या कौन कैसे कहाँ कब है हैं में का के की को से पर और भी यह ये वो वह
   बताइए बताओ बताएं चाहिए करो कीजिए कृपया हो गया रहा
   என்ன எப்படி எங்கே எப்போது இருக்கு இருக்கிறது வேண்டும் சொல்லுங்கள் தயவு`
    .split(/\s+/)
    .filter(Boolean)
);

const terms = (s) =>
  String(s)
    .toLowerCase()
    // \p{M} matters: without it Unicode combining marks are stripped and Indic words
    // shatter into single letters that the length filter then throws away.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

/**
 * Keyword scoring used when no embedding model is configured.
 * Score is the share of the question's rare terms that the chunk covers (0-1),
 * so it stays comparable to the cosine scores KB_MIN_SCORE was tuned against.
 */
function lexicalScores(question, candidates) {
  const queryTerms = [...new Set(terms(question))];
  if (!queryTerms.length) return candidates.map((c) => ({ ...c, score: 0 }));

  const docs = candidates.map((c) => new Set(terms(`${c.section} ${c.text}`)));
  const idf = new Map(
    queryTerms.map((t) => {
      const hits = docs.reduce((n, d) => n + (d.has(t) ? 1 : 0), 0);
      return [t, Math.log(1 + candidates.length / (1 + hits))];
    })
  );
  const total = queryTerms.reduce((sum, t) => sum + idf.get(t), 0) || 1;

  return candidates.map((c, i) => {
    const matched = queryTerms.reduce((sum, t) => sum + (docs[i].has(t) ? idf.get(t) : 0), 0);
    return { ...c, score: matched / total };
  });
}

/** Returns the top-k relevant knowledge chunks for a question. */
export async function search(question, { topK = config.kb.topK, filter } = {}) {
  const index = await ensureIndex();
  if (!index.chunks.length) return [];

  // filter may be one topic or several, when a message asked about more than one.
  const needles = (Array.isArray(filter) ? filter : [filter])
    .filter(Boolean)
    .map((f) => String(f).toLowerCase());
  const inFilter = (c) => {
    const hay = `${c.source} ${c.section}`.toLowerCase();
    return needles.some((n) => hay.includes(n));
  };
  const narrowed = needles.length > 0 && index.chunks.some(inFilter);

  let scored;
  if (index.mode === 'lexical') {
    scored = lexicalScores(question, index.chunks);
  } else {
    try {
      const [queryEmbedding] = await embedBatch([question]);
      scored = index.chunks.map((c) => ({ ...c, score: cosine(queryEmbedding, c.embedding) }));
    } catch (err) {
      if (config.kb.searchMode !== 'auto') throw err;
      store = { ...index, mode: 'lexical', model: null };
      scored = lexicalScores(question, index.chunks);
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // A kbFilter comes from a matched keyword trigger, which has already established the
  // topic - so its sections come first and skip the score floor. The remaining slots stay
  // open to the rest of the index, because one message often asks two things at once
  // ("what are the fees and the timings?").
  const reserved = Math.max(1, topK - (needles.length > 1 ? 1 : 2));
  const picked = narrowed ? scored.filter(inFilter).slice(0, reserved) : [];

  // Scores are the share of the question's rare terms a chunk covers, so a long rambling
  // message spreads thin and every chunk lands under the floor. When a trigger has already
  // pinned the topic, judge the rest relative to the best match instead of absolutely.
  const floor = narrowed
    ? Math.min(config.kb.minScore, (scored[0]?.score ?? 0) * 0.6)
    : config.kb.minScore;

  for (const c of scored) {
    if (picked.length >= topK) break;
    if (c.score < floor) break;
    if (!picked.includes(c)) picked.push(c);
  }

  return picked.map(({ embedding, ...rest }) => rest);
}

export function indexStats() {
  return {
    chunks: store?.chunks.length ?? 0,
    mode: store?.mode ?? null,
    hash: store?.hash ?? null,
    model: store?.model ?? null,
  };
}
