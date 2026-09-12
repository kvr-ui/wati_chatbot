import { feedback as feedbackCollection } from './mongo.js';

const row = (doc) => ({
  id: String(doc._id),
  sessionId: doc.sessionId,
  reviewer: doc.reviewer,
  content: doc.content,
  createdAt: doc.createdAt,
});

export async function saveFeedback({ sessionId, reviewer, content }) {
  const createdAt = new Date();
  const { insertedId } = await (await feedbackCollection()).insertOne({
    sessionId, reviewer, content, createdAt,
  });
  return row({ _id: insertedId, sessionId, reviewer, content, createdAt });
}

export async function listFeedback(limit = 50) {
  const docs = await (await feedbackCollection())
    .find({}).sort({ _id: -1 }).limit(limit).toArray();
  return docs.map(row);
}
