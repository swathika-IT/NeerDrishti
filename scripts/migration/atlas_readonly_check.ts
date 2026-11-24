import { MongoClient } from 'mongodb';
import { validateMongoUri } from './importer_core';

const uri = (process.env.MONGODB_URI || '').trim();
const check = validateMongoUri(uri);
if (!check.ok) {
  console.error(`MONGODB_URI rejected: ${check.reason}`);
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
await client.connect();
try {
  const db = client.db();
  const ping = await db.command({ ping: 1 });
  const collections = await db.listCollections().toArray();
  const rows: Array<{ collection: string; documents: number }> = [];
  let totalDocuments = 0;
  for (const c of collections) {
    const documents = await db.collection(c.name).countDocuments();
    totalDocuments += documents;
    rows.push({ collection: c.name, documents });
  }
  console.log(JSON.stringify({
    database: db.databaseName,
    ping,
    collectionCount: collections.length,
    totalDocuments,
    empty: totalDocuments === 0,
    collections: rows,
  }, null, 2));
} finally {
  await client.close();
}
