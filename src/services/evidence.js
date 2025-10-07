// src/services/evidence.js
const { MAX_CHUNKS_PER_FILE } = require('../Config/env');
const { chatText, embedText, embedTexts } = require('./azure');
const { chunkTextGenerator, cosineSim } = require('../utils/text');

/* ============================================================
 * Regex de classificação de requisitos
 * ============================================================ */

// TÉCNICOS (CAT, capacidade técnica, RT, etc.)
const TECH_REQ_RX = /\b(cat(?:s)?|capacidade\s+t[eé]cnica|capacit[aã]o\s+t[eé]cnica|atestado(?:s)?\s+de?\s+capacidade|acervo\s+t[eé]cnico|experi[êe]ncia(?:\s+t[eé]cnica)?|respons[aá]vel\s+t[eé]cnico|RT)\b/i;

// ADMINISTRATIVOS (jurídico, fiscal, econômico e declarações)
const ADMIN_REQ_RX = /\b(cnpj|contrato\s+social|estatuto|procur[aã]o|preposto|credenciamento|regularidade\s+(?:federal|estadual|municipal)|receita|pgfn|d[ií]vida\s+ativa|fgts|crf|inss|previd[eê]ncia|fazenda\s+nacional|icms|iss|cndt|balan[çc]o\s+patrimonial|demonstra[cç][oõ]es?\s+cont[aá]beis|certid[aã]o\s+fal[eê]ncia|recupera[cç][aã]o\s+judicial|me\/epp|microempresa|empresa\s+de\s+pequeno\s+porte|simples\s+nacional|sicaf|habilita[cç][aã]o|capacidade\s+financeira|qualifica[cç][aã]o\s+econ[oô]mico[-\s]*financeira|declara[cç][oõ]es?|proposta\s+independente|fato\s+impeditivo|garantia\s+de\s+proposta|garantia\s+contratual|seguros?|vistoria\s+t[eé]cnica)\b/i;

/* ============================================================
 * Extrai requisitos – resposta deve ser apenas um array JSON
 * ============================================================ */
async function extractRequirementsFromBid(bidText = "") {
  const effectiveText = String(bidText || "");
  const trimmed = effectiveText.length > 40000 ? effectiveText.substring(0, 40000) : effectiveText;

  const prompt = `Analise o texto do edital e extraia os principais requisitos de habilitação técnica e administrativa.
Sua resposta deve ser **apenas** um array JSON de strings, válido, sem comentários e sem texto extra.

Exemplos:
["Apresentar documentos conforme Anexo XV.","Comprovar experiência em serviços de manutenção.","Apresentar CAT do responsável técnico."]

Texto:
---
${trimmed}
---`;

  const rawResponse = await chatText(prompt);

  const jsonMatch = String(rawResponse).match(/\[\s*(?:"[^"]*"(?:\s*,\s*"[^"]*")*\s*)\]/s);
  if (!jsonMatch) {
    console.error("Resposta da IA não continha um JSON array válido:", rawResponse);
    throw new Error('Não foi possível extrair um JSON array de requisitos da resposta da IA.');
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string')) {
      throw new Error('JSON retornado não é um array de strings.');
    }
    return parsed;
  } catch (err) {
    console.error("Falha ao fazer o parse do JSON extraído:", jsonMatch[0], err);
    throw new Error('O JSON de requisitos retornado pela IA está malformado.');
  }
}

/* ============================================================
 * Classificação de requisito
 * ============================================================ */
function classifyRequirement(req = "") {
  if (TECH_REQ_RX.test(req)) return "TECH";
  if (ADMIN_REQ_RX.test(req)) return "ADMIN";
  return /certid[aã]o|cnpj|contrato|estatuto|balan[çc]o|regularidade|sicaf|fgts|inss|fazenda|simples|procur[aã]o|preposto|garantia|vistoria/i.test(req)
    ? "ADMIN"
    : "TECH";
}

/* ============================================================
 * Adapter: converte complianceChecklist -> flags planas
 * ============================================================ */
function mapChecklistToAdminFlags(checklist = {}) {
  const cj = checklist.habilitacaoJuridica || {};
  const rf = checklist.regularidadeFiscalTrabalhista || {};
  const ef = checklist.econFinanceira || {};
  const qt = checklist.qualificacaoTecnica || {};
  const dc = checklist.declaracoes || {};
  const ad = checklist.adicionais || {};

  const regularidadeFazenda =
    (rf.receitaPgfn === true) &&
    (rf.cndPrevidenciaria === true) &&
    (rf.crfFgts === true) &&
    ((rf.icms === true) || (rf.iss === true) || (rf.cndt === true) || true);

  return {
    cnpjAtivo: cj.cnpjAtivo === true,
    contratoSocial: cj.contratoSocial === true,
    estatuto: false,
    procuracao: cj.procuracao === true,
    regularidadeFGTS: rf.crfFgts === true,
    regularidadeINSS: rf.cndPrevidenciaria === true,
    regularidadeFazenda,
    balancoPatrimonial: ef.balancoPatrimonial === true,
    certidaoFalencia: ef.certidaoFalencia === true,
    qualificacaoEconomicoFinanceira: ef.capitalMinimoOuPL === true,
    enquadramentoME_EPP: dc.enquadramentoMeEpp === true,
    simplesNacional: false,
    propostaIndependente: dc.propostaIndependente === true,
    inexistenciaFatoImped: dc.inexistenciaFatoImped === true,
    credenciamentoPreposto: dc.credenciamentoPreposto === true,
    garantiaProposta: ad.garantiaProposta === true,
    garantiaContratual: ad.garantiaContratual === true,
    seguros: ad.seguros === true,
    vistoriaTecnica: ad.vistoriaTecnica === true,
    atestadosCapacidade: qt.atestadosCapacidade === true,
    artRrtCat: qt.artRrtCat === true,
    registroConselho: qt.registroConselho === true,
    responsavelTecnico: qt.responsavelTecnico === true,
  };
}

/* ============================================================
 * Análise ADMIN com checklist
 * ============================================================ */
function analyzeAdminRequirementAgainstProfile(requirement, companyProfile = {}) {
  const checklist = companyProfile.complianceChecklist || {};
  const px = mapChecklistToAdminFlags(checklist);
  const want = (rx) => rx.test(requirement);

  const rules = [
    { rx: /cnpj/i, flag: () => px.cnpjAtivo },
    { rx: /contrato\s+social|estatuto/i, flag: () => px.contratoSocial || px.estatuto },
    { rx: /procur[aã]o/i, flag: () => px.procuracao },
    { rx: /preposto|credenciamento/i, flag: () => px.credenciamentoPreposto },
    { rx: /fgts|crf/i, flag: () => px.regularidadeFGTS },
    { rx: /inss|previd[eê]ncia/i, flag: () => px.regularidadeINSS },
    { rx: /fazenda|pgfn|receita|d[ií]vida\s+ativa|regularidade\s+(federal|estadual|municipal)|icms|iss|cndt/i, flag: () => px.regularidadeFazenda },
    { rx: /balan[çc]o|demonstra[cç][oõ]es?\s+cont[aá]beis/i, flag: () => px.balancoPatrimonial },
    { rx: /fal[eê]ncia|recupera[cç][aã]o\s+judicial/i, flag: () => px.certidaoFalencia },
    { rx: /capacidade\s+financeira|qualifica[cç][aã]o\s+econ[oô]mico/i, flag: () => px.qualificacaoEconomicoFinanceira },
    { rx: /me\/epp|microempresa|empresa\s+de\s+pequeno\s+porte/i, flag: () => px.enquadramentoME_EPP },
    { rx: /simples\s+nacional/i, flag: () => px.simplesNacional },
    { rx: /proposta\s+independente/i, flag: () => px.propostaIndependente },
    { rx: /fato\s+impeditivo|inexist[eê]ncia\s+de\s+fato/i, flag: () => px.inexistenciaFatoImped },
    { rx: /garantia\s+de\s+proposta/i, flag: () => px.garantiaProposta },
    { rx: /garantia\s+contratual/i, flag: () => px.garantiaContratual },
    { rx: /seguros?/i, flag: () => px.seguros },
    { rx: /vistoria\s+t[eé]cnica/i, flag: () => px.vistoriaTecnica },
    { rx: /atestado(?:s)?\s+de?\s+capacidade/i, flag: () => px.atestadosCapacidade },
    { rx: /\b(cat|art|rrt)\b/i, flag: () => px.artRrtCat },
    { rx: /registro\s+no?\s+conselho|crea|caus|crbio|crq/i, flag: () => px.registroConselho },
    { rx: /respons[aá]vel\s+t[eé]cnico/i, flag: () => px.responsavelTecnico },
  ];

  const r = rules.find(r => want(r.rx));
  if (!r) {
    return {
      status: 'partial',
      text: `Requisito: ${requirement}\n\n**ATENDIDO PARCIALMENTE** — Item administrativo sem mapeamento explícito no checklist.`,
    };
  }

  const ok = typeof r.flag === 'function' ? r.flag() : Boolean(r.flag);
  const label = ok ? '**ATENDIDO**' : '**NÃO ATENDIDO**';
  return {
    status: ok ? 'ok' : 'no',
    text: `Requisito: ${requirement}\n\n${label} — Avaliado com base no checklist de compliance da empresa.`,
  };
}

/* ============================================================
 * Analisa requisito técnico (IA + evidências)
 * ============================================================ */
async function analyzeSingleRequirement(requirement, evidence) {
  const ev = (evidence || []).map(e =>
    `- Trecho do arquivo '${e.source}' (similaridade: ${typeof e.score === 'number' ? e.score.toFixed(3) : e.score}): "${e.text}"`)
    .join('\n');

  const prompt = `Você é um analista de licitações sênior. Avalie o requisito abaixo **apenas** com base nas evidências.

Requisito:
"${requirement}"

Evidências:
${ev || 'Nenhuma evidência foi encontrada.'}

Responda iniciando com: **ATENDIDO**, **ATENDIDO PARCIALMENTE** ou **NÃO ATENDIDO**, seguido de justificativa curta.`;

  const analysisText = await chatText(prompt);
  return `Requisito: ${requirement}\n\n${analysisText}`;
}

/* ============================================================
 * Decide se analisa com IA (TECH) ou checklist (ADMIN)
 * ============================================================ */
async function analyzeRequirementWithContext(requirement, evidence, companyProfile) {
  const kind = classifyRequirement(requirement);
  if (kind === 'ADMIN') {
    const res = analyzeAdminRequirementAgainstProfile(requirement, companyProfile);
    return res.text;
  }
  return await analyzeSingleRequirement(requirement, evidence);
}

/* ============================================================
 * Helpers, resumo e recomendação
 * ============================================================ */
function normalizeSummary(md = '') {
  let s = String(md || '').trim();
  s = s.replace(/^\s*(?:#{1,6}\s*)?\**\s*sum[áa]rio\s+executivo\s*\**\s*:?\s*\n+/i, '');
  return s.trim();
}

function statusFromText(txt = '') {
  const t = String(txt).toLowerCase();
  if (/\bn[aã]o\s+atendido\b/.test(t)) return 'no';
  if (/atendido\s+parcialmente/.test(t)) return 'partial';
  if (/\batendido\b/.test(t)) return 'ok';
  return null;
}

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

function buildRecommendation({ tech, admin, hasAlignedCAT }) {
  if (tech.tot === 0) {
    tech.ok = hasAlignedCAT ? 1 : 0;
    tech.no = hasAlignedCAT ? 0 : 1;
    tech.tot = 1;
    tech.score = hasAlignedCAT ? 1 : 0;
  } else if (hasAlignedCAT) {
    tech.score = Math.max(tech.score, 0.70);
  }

  const wT = 0.6, wA = 0.4;
  const global = (tech.score * wT) + (admin.score * wA);

  let label = 'PARTICIPAÇÃO NÃO RECOMENDADA';
  let bullet = '🔴';
  if (global >= 0.75) { label = 'PARTICIPAÇÃO RECOMENDADA'; bullet = '🟢'; }
  else if (global >= 0.55) { label = 'PARTICIPAÇÃO POSSÍVEL (CONDICIONADA)'; bullet = '🟡'; }

  const pct = (x) => Math.round(x * 100);
  const markdown = [
    `${bullet} **${label}**`,
    '',
    `**Técnico:** ${tech.ok} OK • ${tech.partial} PARCIAL • ${tech.no} NÃO (${pct(tech.score)}%)`,
    `**Documental:** ${admin.ok} OK • ${admin.partial} PARCIAL • ${admin.no} NÃO (${pct(admin.score)}%)`,
    `**Global (60/40): ${pct(global)}%**`
  ].join('\n');

  return { label, bullet, globalScore: global, markdown };
}

/* ============================================================
 * Busca híbrida (local + vetorial)
 * ============================================================ */
async function findEvidenceOnTheFly(requirement, filesMeta, mongoCollection) {
  const qv = await embedText(requirement);

  let localHits = [];
  for (const fm of filesMeta) {
    const { source, getText } = fm;
    const text = await getText();
    if (!text?.trim()) continue;

    const chunks = Array.from(chunkTextGenerator(text)).slice(0, MAX_CHUNKS_PER_FILE);
    if (!chunks.length) continue;

    const chunkVectors = await embedTexts(chunks);
    chunks.forEach((ctext, i) => {
      const chVec = chunkVectors[i];
      if (!chVec?.length) return;
      let score = cosineSim(qv, chVec);
      const anexMatch = requirement.match(/anexo\s+([xivlcdm0-9]+)/i);
      if (anexMatch) {
        const rxAnexo = new RegExp(`anexo\\s*${String(anexMatch[1]).toUpperCase()}`, 'i');
        if (rxAnexo.test(ctext)) score += 0.1;
      }
      localHits.push({ source, text: ctext, score });
    });
  }

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
      console.log('-> Aviso: Busca vetorial Mongo falhou.', e.message);
    }
  }

  const allHits = [...localHits, ...mongoHits];
  return allHits.sort((a, b) => b.score - a.score)
    .filter((v, i, a) => a.findIndex(t => t.text === v.text) === i)
    .slice(0, 4);
}

/* ============================================================
 * Exports
 * ============================================================ */
module.exports = {
  TECH_REQ_RX,
  ADMIN_REQ_RX,
  extractRequirementsFromBid,
  classifyRequirement,
  mapChecklistToAdminFlags,
  analyzeAdminRequirementAgainstProfile,
  analyzeRequirementWithContext,
  analyzeSingleRequirement,
  findEvidenceOnTheFly,
  normalizeSummary,
  statusFromText,
  summarize,
  buildRecommendation,
};
