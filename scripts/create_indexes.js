// scripts/create_indexes.js
/**
 * Cria índices nas coleções cats e chunks.
 * Execução:
 *   MONGODB_URI="..." DB_NAME="..." node scripts/create_indexes.js
 */
const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGO_URI || "mongodb+srv://heliow:22021419@analises-ia.illxueq.mongodb.net/?retryWrites=true&w=majority&appName=analises-ia";
  const dbName = process.env.DB_NAME || "analises-ia";
  if (!uri || !dbName) {
    console.error('Defina MONGODB_URI e DB_NAME nas variáveis de ambiente.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const cats = db.collection('cats');
  const chunks = db.collection('chunks');

  // cats
  await cats.createIndex(
    { fileName: "text", fullText: "text" },
    { default_language: "portuguese", weights: { fileName: 8, fullText: 1 }, name: "cats_text_file_full" }
  );
  await cats.createIndex({ fileName: 1 }, { name: "cats_fileName_1" });
  await cats.createIndex({ domainsFromDoc: 1, yearFromFile: -1 }, { name: "cats_domains_year" });
  await cats.createIndex({ catNumFromFile: 1 }, { name: "cats_catnum_1" });
  await cats.createIndex({ orgaoFromFile: 1 }, { name: "cats_orgao_1" });
  await cats.createIndex({ processedAt: -1 }, { name: "cats_processedAt_-1" });

  // chunks
  await chunks.createIndex({ text: "text" }, { default_language: "portuguese", name: "chunks_text" });
  await chunks.createIndex({ source: 1 }, { name: "chunks_source_1" });

  await client.close();
  console.log('[create_indexes] Índices criados/confirmados.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
