#!/usr/bin/env node
/**
 * Testador de match de CAT por domínio (ex.: Iluminação Pública)
 * Uso:
 *   node testCatMatch.js "<OBJETO_DO_EDITAL>"
 *   MONGODB_URI="mongodb+srv://user:pass@cluster/db" DB_NAME="realenergy" node testCatMatch.js "<OBJETO_DO_EDITAL>"
 */

const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.DB_NAME || "realenergy";
const CATS_COLL = process.env.CATS_COLL || "cats"; // ajuste ao nome real

// ===== util =====
function normalize(s = "") {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // tira acento
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // só letras/números/espaço
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(arr) { return Array.from(new Set(arr)); }

/**
 * Score simples: soma de pesos por termo encontrado.
 * Também avalia bigrams/phrases para melhorar domínio.
 */
function scoreByKeywords(text, keywordDefs) {
  const hits = [];
  let score = 0;

  for (const { terms, weight } of keywordDefs) {
    // termos pode ser 1 palavra ou frase (ex: "iluminacao publica")
    const matched = terms.some(t => text.includes(t));
    if (matched) {
      score += weight;
      hits.push(terms[0]); // loga o principal termo
    }
  }

  return { score, hits: uniq(hits) };
}

// ===== dicionário de domínio: Iluminação Pública (ajuste à vontade) =====
const LIGHTING_DOMAIN = [
  { terms: ["iluminacao publica"], weight: 5 },
  { terms: ["parque de iluminacao"], weight: 4 },
  { terms: ["modernizacao"], weight: 2 },
  { terms: ["eficientizacao"], weight: 3 },
  { terms: ["led"], weight: 2 },
  { terms: ["relamping"], weight: 2 },
  { terms: ["rede de iluminacao"], weight: 3 },
  { terms: ["poste"], weight: 1 },
  { terms: ["braço de luz", "braco de luz"], weight: 2 },
  { terms: ["manutencao eletrica"], weight: 2 },
  { terms: ["publica"], weight: 1 },
  { terms: ["praças", "pracas"], weight: 1 },
  { terms: ["eficiencia energetica"], weight: 2 },
];

// Campos típicos de CAT (ajuste ao seu schema real)
const CANDIDATE_FIELDS = [
  "descricao",
  "objeto",
  "escopo",
  "palavrasChave",
  "observacoes",
  "orgao",
  "servicos",
  "cnae",
  "modalidade",
  "atividade",
];

// Estratégias de busca: progressively relaxed
function buildQueries(normTerms) {
  // 1) Regex OR nos principais termos/frases de domínio
  const rx = normTerms.map(t => ({ $regex: t.replace(/\s+/g, ".*"), $options: "i" })); // frase ~ bigram-flexível

  return [
    // A: todos os campos com $or de frases fortes
    { $or: CANDIDATE_FIELDS.map(f => ({ [f]: { $in: rx } })) },

    // B: fallback por termos menores (palavras isoladas relevantes)
    {
      $or: CANDIDATE_FIELDS.map(f => ({
        [f]: {
          $in: [
            /ilumin(a|á)cao/i, /public(a|o)/i, /moderniza/i, /eficientiza/i,
            /led/i, /relamp/i, /post(e|es)/i, /manuten(c|ç)ao/i
          ]
        }
      }))
    },

    // C: Se houver text index, deixe este passo opcional (não falha se não houver)
    //   Você pode criar no Mongo:
    //   db.cats.createIndex({ descricao: "text", objeto: "text", escopo: "text", palavrasChave: "text" }, { default_language: "portuguese" })
    { $text: { $search: "\"iluminação pública\" iluminação LED modernização eficientização" } },
  ];
}

function fieldText(doc) {
  const parts = [];
  for (const f of CANDIDATE_FIELDS) {
    if (doc[f]) parts.push(String(doc[f]));
  }
  return parts.join(" | ");
}

(async function main() {
  const input = (process.argv[2] || "").trim();
  if (!input) {
    console.error("Passe o OBJETO do edital entre aspas. Ex.: node testCatMatch.js \"Modernização do parque de iluminação pública...\"");
    process.exit(1);
  }

  const objetoNorm = normalize(input);
  const normTerms = uniq([
    "iluminacao publica",
    "parque de iluminacao",
    "modernizacao",
    "eficientizacao",
    "led",
    "relamping",
    "rede de iluminacao",
    "poste",
    "manutencao eletrica",
    "pracas",
    "eficiencia energetica",
  ]);

  // Scora o próprio objeto para confirmar domínio
  const objetoScore = scoreByKeywords(objetoNorm, LIGHTING_DOMAIN);

  console.log("=== OBJETO NORMALIZADO ===");
  console.log(objetoNorm);
  console.log("\n=== DETECÇÃO DE DOMÍNIO (iluminação pública) ===");
  console.log("Score:", objetoScore.score, " | Hits:", objetoScore.hits.join(", ") || "nenhum");

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const cats = db.collection(CATS_COLL);

  // Estratégias de busca
  const queries = buildQueries(normTerms);

  // Executa buscas e agrega resultados com score
  const resultsMap = new Map(); // _id -> { doc, maxScore, reasons }
  for (let i = 0; i < queries.length; i++) {
    try {
      const q = queries[i];
      const cursor = cats.find(q).limit(200); // limite de segurança
      const batch = await cursor.toArray();

      batch.forEach(doc => {
        const text = normalize(fieldText(doc));
        const { score, hits } = scoreByKeywords(text, LIGHTING_DOMAIN);

        // bônus leve se houver “CREA/ART” ou “iluminacao publica” exato
        let bonus = 0;
        if (/art|crea|rt\b/i.test(fieldText(doc))) bonus += 1;
        if (text.includes("iluminacao publica")) bonus += 2;

        const total = score + bonus + (3 - i); // estratégia 0 > 1 > 2 recebe um pequeno peso
        const prev = resultsMap.get(String(doc._id));
        if (!prev || total > prev.maxScore) {
          resultsMap.set(String(doc._id), {
            doc,
            maxScore: total,
            reasons: uniq([...(prev?.reasons || []), ...hits, bonus ? "bonus" : ""])
              .filter(Boolean)
          });
        }
      });
    } catch (e) {
      // $text pode falhar se índice não existir — ignore
      // console.error("Estratégia", i, "falhou:", e.message);
    }
  }

  // Ordena Top-N
  const ranked = Array.from(resultsMap.values())
    .sort((a, b) => b.maxScore - a.maxScore)
    .slice(0, 15);

  console.log("\n=== TOP CATs CANDIDATAS ===");
  if (!ranked.length) {
    console.log("Nenhuma CAT encontrada pelas estratégias atuais.");
    console.log("Sugestões:");
    console.log("- Crie um text index nos campos de CAT (descricao/objeto/escopo/palavrasChave)");
    console.log("- Enriquecer CATs com palavras-chave: 'iluminação pública', 'LED', 'relamping', 'eficientização', 'rede de iluminação', 'manutenção elétrica pública'");
    console.log("- Relaxar filtros de ano/score; revisar pickReasonableYear/thresholds");
  } else {
    for (const { doc, maxScore, reasons } of ranked) {
      const linha = [
        `ID: ${doc._id}`,
        `Score: ${maxScore.toFixed(2)}`,
        `Razões: ${reasons.join(", ") || "-"}`,
        `Descrição/Objeto: ${(doc.objeto || doc.descricao || "").slice(0, 240).replace(/\s+/g, " ")}`
      ].join(" | ");
      console.log(linha);
    }
  }

  // Regras rápidas de elegibilidade temporal (opcional)
  // Exemplo de saneamento de ano: se existir doc.ano ou doc.dataConclusao
  // Você pode filtrar aqui se quiser:
  // const anoOK = (doc) => { ... }

  await client.close();
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
