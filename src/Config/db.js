const { MongoClient } = require('mongodb');
const { MONGO_URI } = require('./env');

if (!MONGO_URI) {
  console.warn('⚠️  MONGO_URI não definido no .env');
}

let client;

async function getClient() {
  if (!client) client = new MongoClient(MONGO_URI);
  if (!client.topology?.isConnected()) await client.connect();
  return client;
}

async function getDb(dbName = 'analista_digital_db') {
  const c = await getClient();
  return c.db(dbName);
}

module.exports = { getClient, getDb };
