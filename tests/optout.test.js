import { test } from 'node:test';
import assert from 'node:assert/strict';

// Nothing listens on port 1: every database call fails, as it does when MongoDB is down.
Object.assign(process.env, { MONGODB_URI: 'mongodb://127.0.0.1:1', MONGODB_DB_NAME: `wati_bot_down_${process.pid}` });
const { isOptedOut } = await import('../src/optout.js');
const { closeMongo } = await import('../src/mongo.js');

test('with MongoDB down, a WhatsApp lead is treated as opted out, not answered', { timeout: 30_000 }, async () => {
  try {
    assert.equal(await isOptedOut('919800000002'), true);
    // The playground has no real person behind it, so it keeps working.
    assert.equal(await isOptedOut('preview:tester'), false);
  } finally {
    await closeMongo?.();
  }
});
