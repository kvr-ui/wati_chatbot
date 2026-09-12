import { assertConfig } from '../src/config.js';
import { ensureIndex, indexStats } from '../src/kb.js';

assertConfig({ requireWati: false });

await ensureIndex({ force: true, log: (m) => console.log(m) });
console.log('Done:', indexStats());
