// scripts/migrate_cats_normalize.js
/**
 * Normaliza documentos da coleção `cats`:
 * - domainsFromFile: [eletrica|civil|incendio|clima|agua]
 * - yearFromFile: Number
 * - catNumFromFile: String
 * - orgaoFromFile: String
 * - domainsFromFullText: [ ... ]
 * - domainsFromDoc: união (filename + fullText)
 *
 * Execução:
 *   MONGODB_URI="mongodb+srv://..." DB_NAME="sua_db" node scripts/migrate_cats_normalize.js
 *
 * Opções:
 *   --dry        Faz dry-run (não grava)
 *   --limit N    Limita a N documentos
 *   --since ISO  Atualiza apenas docs com processedAt >= since (ex.: 2025-09-01)
 */

const { MongoClient } = require("mongodb");

const DOMAIN_LEXICON = {
  eletrica: [
    'subesta', 'kva', '\\bkv\\b', 'transformador', 'disjuntor', 'qgbt',
    'cabine primária', 'baixa tensão', 'média tensão', 'proteção elétrica',
    'religadores?', 'seccionadoras?', 'barramentos?', '\\bLT\\b', '\\bLD\\b'
  ],
  clima: [
    'climatiza', 'ar condicionado', 'chiller', 'fan ?coil', 'vrf', '\\btr\\b', 'split', 'self contained'
  ],
  incendio: [
    'inc[êe]ndio', 'sdai', 'sprinkler', 'hidrante', 'bomba de incêndio',
    'endere[cç]a', 'alarme', 'detec[çc][aã]o'
  ],
  agua: [
    'micromedi', 'hidr[oó]metro', 'adu[cç][aã]o', '\\beta\\b', '\\bete\\b', '\\betap\\b',
    'po[çc]o', 'submers[ií]vel', 'per[íi]metros de irriga', 'bomba d[\' ]?água'
  ],
  civil: [
    'edifica', 'paviment', 'obra civil', 'concreto', 'alvenaria', 'fund[aá]cao', 'creche', 'escola', 'pr[eé]dio',
    'manuten[çc][aã]o predial', 'reforma'
  ],
};

const EXTRA_DOMAIN_SYNONYMS = {
  eletrica: [
    '\\bLT\\b', '\\bLD\\b', 'linha viva', 'linha morta', '\\b69\\s*kV\\b', '\\b138\\s*kV\\b', '\\b230\\s*kV\\b',
    'subesta[cç][aã]o', '\\bSE\\b', 'alimentador', 'barramento', 'disjuntor', 'religador', 'transformador'
  ],
  civil: [
    'reforma', 'manuten[cç][aã]o predial', 'edifica[cç][aã]o', 'escola', 'creche', 'obra civil', 'alvenaria', 'concreto'
  ],
  incendio: [
    'hidrante', 'sprinkler', 'SDAI', 'alarme de inc[êe]ndio', 'endere[cç][aá]vel', 'detec[çc][aã]o'
  ],
  clima: [
    'ar condicionado', 'VRF', 'chiller', 'fan ?coil', '\\bTR\\b', 'self contained', 'split'
  ],
  agua: [
    'adu[cç][aã]o', '\\beta\\b', '\\bete\\b', '\\betap\\b', 'po[çc]o', 'hidr[oó]metro'
  ]
};

function detectDomains(str = '') {
  const s = String(str || '').toLowerCase();
  const hits = new Set();
  for (const [dom, terms] of Object.entries(DOMAIN_LEXICON)) {
    if (terms.some(rx => new RegExp(rx, 'i').test(s))) hits.add(dom);
  }
  // extras
  for (const [dom, syns] of Object.entries(EXTRA_DOMAIN_SYNONYMS)) {
    if (syns.some(rx => new RegExp(rx, 'i').test(s))) hits.add(dom);
  }
  return Array.from(hits);
}

function parseFilenameMeta(fileName = '') {
  const fn = String(fileName || '');
  const lower = fn.toLowerCase();
  const catNum = (lower.match(/cat\s*(?:n[ºo]\s*)?[\-:\s]*([\d]{2,}\/?\d{0,4})/) || [])[1] || null;
  const year = (fn.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || null;
  const orgMatch = fn.match(/\b(CELPE|CHESF|PM\s+DE\s+[A-ZÇÃÕ ]+|PREFEITURA\s+DE\s+[A-ZÇÃÕ ]+|CREA-?[A-Z]{2})\b/i);
  const orgao = orgMatch ? orgMatch[0] : null;
  const domainsFromFile = detectDomains(fn);
  return { catNumFromFile: catNum, yearFromFile: year ? Number(year) : null, orgaoFromFile: orgao, domainsFromFile };
}

async function main() {
  const uri = process.env.MONGO_URI || "mongodb+srv://heliow:22021419@analises-ia.illxueq.mongodb.net/?retryWrites=true&w=majority&appName=analises-ia";
  const dbName = process.env.DB_NAME || "analises-ia";
  if (!uri || !dbName) {
    console.error('Defina MONGODB_URI e DB_NAME nas variáveis de ambiente.');
    process.exit(1);
  }

  const DRY = process.argv.includes('--dry');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

  const sinceArg = process.argv.indexOf('--since');
  const since = sinceArg > -1 ? new Date(process.argv[sinceArg + 1]) : null;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const cats = db.collection('cats');

  const q = {};
  if (since && !isNaN(since.getTime())) q.processedAt = { $gte: since };

  const cursor = cats.find(q, { projection: { _id: 1, fileName: 1, fullText: 1 } });
  const total = await cursor.count();
  let done = 0;

  console.log(`[migrate_cats_normalize] Iniciando. Total de candidatos: ${total}${limit ? ` (limit ${limit})` : ''}${since ? ` | since=${since.toISOString()}` : ''}${DRY ? ' | DRY-RUN' : ''}`);

  const bulk = [];
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const { fileName = '', fullText = '' } = doc;

    const meta = parseFilenameMeta(fileName);
    const domainsFromFullText = detectDomains(fullText);
    const domainsFromDoc = Array.from(new Set([...(meta.domainsFromFile || []), ...domainsFromFullText]));

    const set = {
      ...(meta.catNumFromFile ? { catNumFromFile: meta.catNumFromFile } : {}),
      ...(meta.yearFromFile ? { yearFromFile: meta.yearFromFile } : {}),
      ...(meta.orgaoFromFile ? { orgaoFromFile: meta.orgaoFromFile } : {}),
      domainsFromFile: meta.domainsFromFile || [],
      domainsFromFullText,
      domainsFromDoc,
      // carimbo de migração (opcional)
      _normalizedAt: new Date()
    };

    bulk.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: set }
      }
    });

    done++;
    if (bulk.length >= 500) {
      if (!DRY) await cats.bulkWrite(bulk, { ordered: false });
      bulk.length = 0;
      console.log(`[migrate_cats_normalize] ${done}/${total} atualizados...`);
    }
    if (limit && done >= limit) break;
  }

  if (bulk.length) {
    if (!DRY) await cats.bulkWrite(bulk, { ordered: false });
    console.log(`[migrate_cats_normalize] ${done}/${total} finalizados.`);
  }

  // índices úteis (caso não tenha rodado via shell)
  try {
    await cats.createIndex({ fileName: "text", fullText: "text" }, { default_language: "portuguese", weights: { fileName: 8, fullText: 1 }, name: "cats_text_file_full" });
    await cats.createIndex({ fileName: 1 }, { name: "cats_fileName_1" });
    await cats.createIndex({ domainsFromDoc: 1, yearFromFile: -1 }, { name: "cats_domains_year" });
    await cats.createIndex({ catNumFromFile: 1 }, { name: "cats_catnum_1" });
    await cats.createIndex({ orgaoFromFile: 1 }, { name: "cats_orgao_1" });
  } catch (e) {
    console.warn('Aviso ao criar índices (ignorar se já existem):', e.message);
  }

  await client.close();
  console.log('[migrate_cats_normalize] OK.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
