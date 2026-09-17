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
      db.collection(config.mongo.feedback).createIndex({ createdAt: -1 }),
      db.collection(config.mongo.optins).createIndex({ waId: 1 }, { unique: true }),
      db.collection(config.mongo.optouts).createIndex({ waId: 1 }, { unique: true }),
      db.collection(config.mongo.campaign).createIndex({ waId: 1 }, { unique: true }),
      db.collection(config.mongo.handovers).createIndex({ waId: 1 }, { unique: true }),
      db.collection(config.mongo.webhookEvents).createIndex({ messageId: 1 }, { unique: true }),
      // WATI retries within minutes; a week of ids is plenty and the collection stays small.
      db.collection(config.mongo.webhookEvents).createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86_400 }),
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
export const feedback = async () => (await connect()).collection(config.mongo.feedback);
export const optins = async () => (await connect()).collection(config.mongo.optins);
export const optouts = async () => (await connect()).collection(config.mongo.optouts);
export const campaign = async () => (await connect()).collection(config.mongo.campaign);
export const handovers = async () => (await connect()).collection(config.mongo.handovers);
export const webhookEvents = async () => (await connect()).collection(config.mongo.webhookEvents);

export async function closeMongo() {
  const open = client;
  client = undefined;
  connecting = undefined;
  await open?.close();
}
