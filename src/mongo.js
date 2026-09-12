import { MongoClient } from 'mongodb';
import { config } from './config.js';

/**
 * Lazy singleton connection, following the same shape as focasvsl/lib/mongodb.ts
 * so both projects behave the same way.
 *
 * Indexes are created once on first connect; createIndex is idempotent, so this
 * is safe to run on every boot.
 */
let client;
let connecting;

async function connect() {
  client ??= new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 5000 });
  connecting ??= client.connect().then(async (connected) => {
    const db = connected.db(config.mongo.dbName);
    await Promise.all([
      db.collection(config.mongo.messages).createIndex({ waId: 1, _id: 1 }),
      db.collection(config.mongo.messages).createIndex({ createdAt: -1 }),
      db.collection(config.mongo.leads).createIndex({ waId: 1 }, { unique: true }),
      db.collection(config.mongo.leads).createIndex({ score: -1, lastSeen: -1 }),
    ]);
    console.log(`MongoDB connected: ${config.mongo.dbName}`);
    return connected;
  }).catch((err) => {
    // Let the next call retry rather than caching a failed connection forever.
    connecting = undefined;
    client = undefined;
    throw err;
  });

  return (await connecting).db(config.mongo.dbName);
}

export const getDb = () => connect();

export const messages = async () => (await connect()).collection(config.mongo.messages);
export const leads = async () => (await connect()).collection(config.mongo.leads);

export async function closeMongo() {
  const open = client;
  client = undefined;
  connecting = undefined;
  await open?.close();
}
