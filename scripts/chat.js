import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { assertConfig } from '../src/config.js';
import { handleMessage } from '../src/handler.js';
import { ensureIndex } from '../src/kb.js';

// Local terminal chat - same brain as WhatsApp, no WATI credentials needed.
assertConfig({ requireWati: false });
await ensureIndex({ log: (m) => console.log(`[kb] ${m}`) });

const rl = readline.createInterface({ input, output });
const waId = 'cli-tester';
console.log('\nType a message ("exit" to quit, "/why" to see how the last reply was chosen)\n');

let lastMeta = null;

// Async iteration pauses the input stream between turns, so it works the same for a
// live terminal and for piped input (printf '...' | npm run chat).
output.write('you > ');
for await (const line of rl) {
  const text = line.trim();
  if (!text) {
    output.write('you > ');
    continue;
  }
  if (['exit', 'quit'].includes(text.toLowerCase())) break;
  if (text === '/why') {
    console.log(JSON.stringify(lastMeta, null, 2), '\n');
    output.write('you > ');
    continue;
  }

  try {
    const { replies, meta } = await handleMessage({ waId, name: 'Tester', text });
    lastMeta = meta;
    if (!replies.length) console.log('bot > (silent - handed over to a human)');
    for (const r of replies) console.log(`bot > ${r}`);
    console.log(`      [${meta.reason}${meta.trigger ? ` via ${meta.trigger}` : ''}]\n`);
  } catch (err) {
    console.error('error:', err.message, '\n');
  }
  output.write('you > ');
}
rl.close();
