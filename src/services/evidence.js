// src/services/evidence.js
const { MAX_CHUNKS_PER_FILE } = require('../Config/env');
const { chatText, embedText, embedTexts } = require('./azure');
const { chunkTextGenerator, cosineSim } = require('../utils/text');

// perto do topo do arquivo
const TECH_REQ_RX = /\b(cat(?:s)?|capacidade\s+t[eé]cnica|capacit[aã]o\s+t[eé]cnica|atestado(?:s)?\s+de?\s+capacidade|acervo\s+t[eé]cnico|experi[êe]ncia(?:\s+t[eé]cnica)?|respons[aá]vel\s+t[eé]cnico|RT)\b/i;


/* ============================================================
 * Extrai requisitos – resposta deve ser apenas um array JSON de strings
 * ============================================================ */
async function extractRequirementsFromBid(bidText) {
  const effectiveText = bidText.length > 40000 ? bidText.substring(0, 40000) : bidText;

  const prompt = `Analise o texto do edital e extraia os principais requisitos de habilitação técnica e administrativa.
Sua resposta deve ser **apenas** um array JSON de strings, válido, sem comentários e sem texto extra.

Exemplos:
["Apresentar documentos conforme Anexo XV.","Comprovar experiência em serviços de manutenção.","Apresentar CAT do responsável técnico."]

Texto:
---
${effectiveText}
---`;

  const rawResponse = await chatText(prompt);

  const jsonMatch = rawResponse.match(/\[\s*(?:"[^"]*"(\s*,\s*"[^"]*")*\s*)\]/s);
  if (!jsonMatch) {
    console.error("Resposta da IA não continha um JSON array válido:", rawResponse);
    throw new Error('Não foi possível extrair um JSON array de requisitos da resposta da IA.');
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Falha ao fazer o parse do JSON extraído:", jsonMatch[0]);
    throw new Error('O JSON de requisitos retornado pela IA está malformado.');
  }
}

/* ============================================================
 * Analisa um requisito com base em evidências
 * ============================================================ */
async function analyzeSingleRequirement(requirement, evidence) {
  const ev = (evidence || []).map(e =>
    `- Trecho do arquivo '${e.source}' (similaridade: ${typeof e.score === 'number' ? e.score.toFixed(3) : e.score}): "${e.text}"`
  ).join('\n');

  const prompt = `Você é um analista de licitações sênior. Avalie o requisito abaixo **apenas** com base nas evidências.

Requisito:
"${requirement}"

Evidências:
${ev || 'Nenhuma evidência foi encontrada para este requisito.'}

Responda iniciando com o status em negrito: **ATENDIDO**, **ATENDIDO PARCIALMENTE** ou **NÃO ATENDIDO**, seguido de uma justificativa curta.`;

  const analysisText = await chatText(prompt);
  return `Requisito: ${requirement}\n\n${analysisText}`;
}

/* ============================================================
 * Helpers para o Controller (sumário 60/40 e normalização)
 * ============================================================ */

// Remove títulos repetidos como "Sumário Executivo"
function normalizeSummary(md = '') {
  let s = String(md || '').trim();
  // remove variações de "Sumário Executivo" no topo
  s = s.replace(/^\s*(?:#{1,6}\s*)?\**\s*sum[áa]rio\s+executivo\s*\**\s*:?\s*\n+/i, '');
  return s.trim();
}

// Deduz status (ok|partial|no) a partir de um bloco de análise
function statusFromText(txt = '') {
  const t = String(txt).toLowerCase();
  if (/\bn[aã]o\s+atendido\b/.test(t)) return 'no';
  if (/atendido\s+parcialmente/.test(t)) return 'partial';
  if (/\batendido\b/.test(t)) return 'ok';
  return null;
}

// Resume contagens e score (0..1) de uma lista de análises
function summarize(blocks = []) {
  let ok = 0, partial = 0, no = 0, tot = 0;
  for (const b of blocks) {
    const st = statusFromText(b);
    if (!st) continue;
    tot++;
    if (st === 'ok') ok++;
    else if (st === 'partial') partial++;
    else no++;
  }
  const score = tot ? (ok + 0.5 * partial) / tot : 0;
  return { ok, partial, no, tot, score };
}

// Gera recomendação final com ponderação 60% técnico / 40% documental
function buildRecommendation({ tech, admin, hasAlignedCAT }) {
  // Se não houver itens técnicos (casos raros), usa a presença de CAT aderente como proxy
  if (tech.tot === 0) {
    tech.ok = hasAlignedCAT ? 1 : 0;
    tech.partial = 0;
    tech.no = hasAlignedCAT ? 0 : 1;
    tech.tot = 1;
    tech.score = hasAlignedCAT ? 1 : 0;
  } else if (hasAlignedCAT) {
    // Se há CAT aderente, impõe piso técnico razoável
    tech.score = Math.max(tech.score, 0.70);
  }

  const wT = 0.60, wA = 0.40;
  const global = (tech.score * wT) + (admin.score * wA);

  let label = 'PARTICIPAÇÃO NÃO RECOMENDADA';
  let bullet = '🔴';
  if (global >= 0.75) { label = 'PARTICIPAÇÃO RECOMENDADA'; bullet = '🟢'; }
  else if (global >= 0.55) { label = 'PARTICIPAÇÃO POSSÍVEL (CONDICIONADA)'; bullet = '🟡'; }

  const pct = (x) => Math.round(x * 100);
  const markdown = [
    `${bullet} **${label}**`,
    '',
    `**Indicadores:** Técnico: ${tech.ok} OK • ${tech.partial} PARCIAL • ${tech.no} NÃO • Score: ${pct(tech.score)}%`,
    `Documental: ${admin.ok} OK • ${admin.partial} PARCIAL • ${admin.no} NÃO • Score: ${pct(admin.score)}%`,
    `**Atendimento global (ponderado 60/40): ${pct(global)}%**`
  ].join('\n');

  return { label, bullet, globalScore: global, markdown };
}

/* ============================================================
 * Gera conteúdo do Sumário Executivo (sem o H2 e sem “Recomendação Final”)
 * ============================================================ */
async function generateExecutiveSummary(detailedAnalyses) {
  const getStatus = (txt = "") => {
    const t = txt.toLowerCase();
    if (/\b(n[aã]o\s+atendido)\b/.test(t) || /🔴/.test(txt)) return "NAO";
    if (/\batendido parcialmente\b/.test(t) || /🟡/.test(txt)) return "PARCIAL";
    if (/\batendido\b/.test(t) || /🟢/.test(txt)) return "OK";
    return "PARCIAL";
  };
  const getTitle = (txt = "") => {
    // aceita "Requisito:" normal ou em negrito (**Requisito:**)
    const m = txt.match(/^\s*\**Requisito:\**\s*(.+?)\n/i);
    return (m?.[1] || "").trim();
  };

  const items = (Array.isArray(detailedAnalyses) ? detailedAnalyses : [])
    .map(raw => ({ title: getTitle(raw), status: getStatus(raw), raw }))
    .filter(i => i.title || i.raw);

  // Pontos fortes: top 5 OK
  const strengths = items.filter(i => i.status === "OK")
    .slice(0, 5)
    .map(i => `- ${i.title || "(requisito atendido)"}`);

  // GAPs: NÃO > PARCIAL (top 6)
  const gaps = [
    ...items.filter(i => i.status === "NAO"),
    ...items.filter(i => i.status === "PARCIAL")
  ].slice(0, 6).map(i => {
    const tag = i.status === "NAO" ? "NÃO ATENDIDO" : "ATENDIDO PARCIALMENTE";
    return `- **${tag}** — ${i.title || "(requisito)"}`;
  });

  const pf = strengths.length ? ["### Pontos Fortes", ...strengths].join("\n")
    : "### Pontos Fortes\n- (sem destaques)";
  const gap = gaps.length ? ["### Pontos de Atenção / GAPs", ...gaps].join("\n")
    : "### Pontos de Atenção / GAPs\n- (sem lacunas relevantes)";

  // Sem "## Sumário Executivo" aqui — o controller já coloca.
  return [pf, gap].join("\n\n");
}

/* ============================================================
 * Busca híbrida (local + vetorial Mongo) de evidências por requisito
 * ============================================================ */
async function findEvidenceOnTheFly(requirement, filesMeta, mongoCollection) {
  const qv = await embedText(requirement);

  // Embedding em lote no local
  let localHits = [];
  for (const fm of filesMeta) {
    const { source, getText } = fm;
    const text = await getText();
    if (!text?.trim()) continue;

    const chunks = Array.from(chunkTextGenerator(text)).slice(0, MAX_CHUNKS_PER_FILE);
    if (chunks.length === 0) continue;

    const chunkVectors = await embedTexts(chunks);
    chunks.forEach((ctext, i) => {
      const chVec = chunkVectors[i];
      if (!chVec || chVec.length === 0) return;

      let score = cosineSim(qv, chVec);

      // leve boost se o requisito citar um anexo específico e o chunk mencionar
      const anexMatch = requirement.match(/anexo\s+([xivlcdm0-9]+)/i);
      if (anexMatch) {
        const anexHint = String(anexMatch[1]).toUpperCase();
        const rxAnexo = new RegExp(`anexo\\s*${anexHint}`, 'i');
        if (rxAnexo.test(ctext)) score += 0.10;
      }

      localHits.push({ source, text: ctext, score });
    });
  }

  // Vetorial no Mongo (opcional)
  let mongoHits = [];
  if (mongoCollection) {
    try {
      const pipeline = [{
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: qv,
          numCandidates: 100,
          limit: 5
        }
      }, { $project: { _id: 0, text: 1, source: 1, score: { $meta: 'vectorSearchScore' } } }];
      mongoHits = await mongoCollection.aggregate(pipeline).toArray();
    } catch (e) {
      console.log('-> Aviso: Busca no MongoDB falhou.', e.message);
    }
  }

  const allHits = [...localHits, ...mongoHits];
  const sortedUniqueHits = allHits
    .sort((a, b) => b.score - a.score)
    .filter((v, i, a) => a.findIndex(t => (t.text === v.text)) === i);

  return sortedUniqueHits.slice(0, 4);
}

module.exports = {
  extractRequirementsFromBid,
  analyzeSingleRequirement,
  generateExecutiveSummary,
  findEvidenceOnTheFly,
  // helpers expostos para o controller
  normalizeSummary,
  summarize,
  buildRecommendation,
};
