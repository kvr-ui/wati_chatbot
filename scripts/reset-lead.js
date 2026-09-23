import { config, normalizeWaId } from '../src/config.js';
import { getDb, closeMongo } from '../src/mongo.js';

/**
 * Puts one number back to being an unknown lead, so the campaign script runs
 * from the top the next time they send an ad phrase.
 *
 * Only the state that gates the flow is cleared - the campaign answer, the
 * opt-in window, a STOP and a handover pause. Their conversation history and
 * lead score are kept, because the logged turns are the record the scores are
 * rebuilt from; pass --history to drop those too.
 *
 *   npm run reset-lead -- 8807154473
 *   npm run reset-lead -- 8807154473 --history
 *
 * The bot keeps this state in memory as well, so restart it afterwards -
 * otherwise the running process answers from the copy it already has.
 */
const args = process.argv.slice(2);
const withHistory = args.includes('--history');
const numbers = args.filter((a) => !a.startsWith('--')).map(normalizeWaId).filter(Boolean);

if (!numbers.length) {
  console.error('Usage: npm run reset-lead -- <number> [--history]');
  process.exit(1);
}

/** WATI may send a number with or without the country code; clear either spelling. */
const spellings = (digits) => [...new Set([digits, digits.replace(/^91/, ''), `91${digits}`])];

const stateCollections = [
  ['campaign', config.mongo.campaign],
  ['opt-in', config.mongo.optins],
  ['opt-out', config.mongo.optouts],
  ['handover', config.mongo.handovers],
];

const historyCollections = [
  ['messages', config.mongo.messages],
  ['lead', config.mongo.leads],
];

const db = await getDb();

for (const number of numbers) {
  const waId = { $in: spellings(number) };
  console.log(`\n${number}:`);

  for (const [label, name] of [...stateCollections, ...(withHistory ? historyCollections : [])]) {
    const { deletedCount } = await db.collection(name).deleteMany({ waId });
    console.log(`  ${label.padEnd(9)} ${deletedCount ? `cleared (${deletedCount})` : 'nothing to clear'}`);
  }

  if (!withHistory) {
    const kept = await db.collection(config.mongo.messages).countDocuments({ waId });
    console.log(`  history   ${kept} turns kept (--history to drop them)`);
  }
}

console.log('\nDone. Restart the bot so it drops its in-memory copy of this state.');
await closeMongo();
