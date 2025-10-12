const { MAX_CHUNKS_PER_FILE } = require('../Config/env');
const { chatText, embedText, embedTexts } = require('./azure');
const { chunkTextGenerator, cosineSim } = require('../utils/text');

/* ============================ Regex de classificação ============================ */
// TÉCNICO (sempre usar CAT/RT/atestado como base)
const TECH_REQ_RX = /\b(cat(?:s)?|capacidade\s+t[eé]cnica|capacit[aã]o\s+t[eé]cnica|atestado(?:s)?\s+de?\s+capacidade|acervo\s+t[eé]cnico|experi[êe]ncia(?:\s+t[eé]cnica)?|respons[aá]vel\s+t[eé]cnico|RT)\b/i;

// ADMIN (jurídico/fiscal/econ/declar.) – abrangente
const ADMIN_REQ_RX = /\b(cnpj|contrato\s+social|estatuto|registro\s+comercial|procur[aá]c[aã]o|regularidade\s+(?:federal|estadual|municipal)|pgfn|fazenda\s+nacional|fgts|inss|cndt|certid(?:[ãa]o|[oõ]es)\s+negativ[ao]s?.*d[eé]bitos?|sicaf|balan[çc]o\s+patrimonial|dre|demonstra[cç][oõ]es?\s+cont[aá]beis|fal[eê]ncia|recupera[cç][aã]o\s+judicial|me\/epp|microempresa|empresa\s+de\s+pequeno\s+porte|simples\s+nacional|capacidade\s+financeira|qualifica[cç][aã]o\s+econ[oô]mico[-\s]*financeira|declara[çc][aã]o|vistoria|garantia|seguro|inmetro|anvisa|entidade\s+profissional\s+competente|conselho|crea|cau)\b/i;

/* ============================================================
 * 1) Extração dos requisitos do edital (JSON array)
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
 * 2) Classificação TECH vs ADMIN
 * ============================================================ */
function classifyRequirement(req = "") {
  if (TECH_REQ_RX.test(req)) return "TECH";
  if (ADMIN_REQ_RX.test(req)) return "ADMIN";
  // fallback heurístico (inclui plural de certidões)
  return /certid(?:[ãa]o|[oõ]es)|cnpj|contrato|estatuto|balan[çc]o|regularidade|sicaf|fgts|inss|fazenda|simples|declara[çc][aã]o/i.test(req)
    ? "ADMIN"
    : "TECH";
}

/* ============================================================
 * 3) Flatten do perfil da empresa (complianceChecklist) → flags
 * ============================================================ */
function flattenCompanyProfile(company = {}) {
  const cc = company?.complianceChecklist || {};
  const hj = cc.habilitacaoJuridica || {};
  const rf = cc.regularidadeFiscalTrabalhista || {};
  const ef = cc.econFinanceira || {};
  const qt = cc.qualificacaoTecnica || {};
  const dc = cc.declaracoes || {};
  const ad = cc.adicionais || {};

  const px = {
    // habilitação jurídica
    cnpjAtivo: !!hj.cnpjAtivo,
    contratoSocial: !!hj.contratoSocial,
    registroComercial: !!hj.contratoSocial, // proxy p/ empresa individual
    procuracao: !!hj.procuracao,

    // regularidade fiscal/trabalhista
    receitaPgfn: !!rf.receitaPgfn,      // Federal
    cndPrevidenciaria: !!rf.cndPrevidenciaria, // INSS
    crfFgts: !!rf.crfFgts,              // FGTS
    icms: !!rf.icms,                    // Estadual
    iss: !!rf.iss,                      // Municipal
    cndt: !!rf.cndt,                    // Trabalhista
    sicafHabilitado: company?.sicafHabilitado || false,

    // econômico-financeira
    balancoPatrimonial: !!ef.balancoPatrimonial,
    certidaoFalencia: !!ef.certidaoFalencia,
    capitalMinimoOuPL: !!ef.capitalMinimoOuPL,

    // qualificação técnica (documental)
    atestadosCapacidade: !!qt.atestadosCapacidade,
    artRrtCat: !!qt.artRrtCat,
    registroConselho: !!qt.registroConselho,
    responsavelTecnico: !!qt.responsavelTecnico,

    // declarações
    propostaIndependente: !!dc.propostaIndependente,
    inexistenciaFatoImped: !!dc.inexistenciaFatoImped,
    menorAprendizRegras: !!dc.menorAprendizRegras,
    enquadramentoME_EPP: !!dc.enquadramentoMeEpp,
    cumprimentoEditalAnticorrupcao: !!dc.cumprimentoEditalAnticorrupcao,
    credenciamentoPreposto: !!dc.credenciamentoPreposto,

    // adicionais
    vistoriaTecnica: !!ad.vistoriaTecnica,
    certificacoesRegulatorios: !!ad.certificacoesRegulatorios,
    planoTrabalhoMetodologia: !!ad.planoTrabalhoMetodologia,
    garantiaProposta: !!ad.garantiaProposta,
    garantiaContratual: !!ad.garantiaContratual,
    seguros: !!ad.seguros,
  };

  px.cnpj = px.cnpjAtivo; // alias
  return px;
}

/* ============================================================
 * 4) ADMIN: análise contra o perfil (OK / PARCIAL / NÃO)
 * ============================================================ */
function analyzeAdminRequirementAgainstProfile(requirement, company = {}) {
  const px = flattenCompanyProfile(company);
  const want = (rx) => rx.test(requirement);

  // (A) CNDs compostas (Trabalhista/INSS/Federal/Estadual/Municipal)
  if (/certid(?:[ãa]o|[oõ]es)?\s+negativas?.*d[eé]bitos?/i.test(requirement)) {
    const parts = [px.cndt, px.cndPrevidenciaria, px.receitaPgfn, px.icms, px.iss];
    const okCount = parts.filter(Boolean).length;
    let status = 'no', label = '**NÃO ATENDIDO**';
    if (okCount >= 4) { status = 'ok'; label = '**ATENDIDO**'; }
    else if (okCount >= 2) { status = 'partial'; label = '**ATENDIDO PARCIALMENTE**'; }
    return {
      status,
      text: `Requisito: ${requirement}\n\n${label} — Avaliado contra as CNDs (trabalhista/INSS/federal/estadual/municipal) do cadastro.`,
    };
  }

  // (B) Prova de regularidade com a Fazenda (Fed/Est/Mun) com parcialidade
  if (/prova\s+de\s+regularidade.*fazenda/i.test(requirement)) {
    const parts = [px.receitaPgfn, px.icms, px.iss]; // federal, estadual, municipal
    const okCount = parts.filter(Boolean).length;
    let status = 'no', label = '**NÃO ATENDIDO**';
    if (okCount >= 3) { status = 'ok'; label = '**ATENDIDO**'; }
    else if (okCount === 2) { status = 'partial'; label = '**ATENDIDO PARCIALMENTE**'; }
    return {
      status,
      text: `Requisito: ${requirement}\n\n${label} — Avaliado contra Fazenda Federal/Estadual/Municipal do cadastro.`,
    };
  }

  // (C) Boa situação econômico-financeira (índices de liquidez) — proxy
  if (/(índices?\s+de\s+liquidez|boa\s+situa[cç][aã]o\s+econ[oô]mico[-\s]*financeira)/i.test(requirement)) {
    const parts = [px.balancoPatrimonial, px.capitalMinimoOuPL];
    const okCount = parts.filter(Boolean).length;
    const status = okCount === 2 ? 'ok' : 'partial';
    const label  = status === 'ok' ? '**ATENDIDO**' : '**ATENDIDO PARCIALMENTE**';
    return {
      status,
      text: `Requisito: ${requirement}\n\n${label} — Proxy com base em balanço/PL informado no cadastro.`,
    };
  }

  // Demais regras simples
  const rules = [
    // habilitação jurídica
    { rx: /registro\s+comercial|empresa\s+individual/i, flag: px.registroComercial },
    { rx: /ato\s+constitutivo|estatuto|contrato\s+social/i, flag: px.contratoSocial },
    { rx: /procur[aá]c[aã]o|poderes?\s+do\s+representante/i, flag: px.procuracao },
    { rx: /cnpj/i, flag: px.cnpj },

    // regularidade
    { rx: /pgfn|fazenda|regularidade\s+(federal|nacional)/i, flag: px.receitaPgfn },
    { rx: /inss|previd/i, flag: px.cndPrevidenciaria },
    { rx: /fgts/i, flag: px.crfFgts },
    { rx: /icms|estadual/i, flag: px.icms },
    { rx: /iss|municipal/i, flag: px.iss },
    { rx: /cndt|d[eê]bitos?\s+trabalhistas?/i, flag: px.cndt },
    { rx: /sicaf/i, flag: px.sicafHabilitado },

    // econômico-financeira
    { rx: /balan[çc]o|dre|demonstra[cç][oõ]es?\s+cont/i, flag: px.balancoPatrimonial },
    { rx: /fal[eê]ncia|recupera[cç][aã]o\s+judicial/i, flag: px.certidaoFalencia },
    { rx: /capital\s+m[ií]nimo|patrim[oô]nio\s+l[ií]quido/i, flag: px.capitalMinimoOuPL },

    // técnico (documental)
    { rx: /(registro|inscri[çc][aã]o).*(entidade\s+profissional\s+competente|conselho|cau|crea|ordem|crm|crmv|oab)/i,
      flag: (px.registroConselho || px.responsavelTecnico) },
    { rx: /respons[aá]vel\s+t[ée]cnico|v[ií]nculo/i, flag: px.responsavelTecnico },
    { rx: /atestados?\s+de?\s+capacidade|acervo\s+t[ée]cnico|cat\b/i, flag: (px.atestadosCapacidade && px.artRrtCat) },

    // declarações
    { rx: /proposta\s+independente/i, flag: px.propostaIndependente },
    { rx: /inexist[eê]ncia.*fato\s+impeditivo/i, flag: px.inexistenciaFatoImped },
    { rx: /menor\s+aprendiz/i, flag: px.menorAprendizRegras },
    { rx: /me\/epp|microempresa|empresa\s+de\s+pequeno\s+porte/i, flag: px.enquadramentoME_EPP },
    { rx: /anticorrup[cç][aã]o|cumprimento\s+do\s+edital/i, flag: px.cumprimentoEditalAnticorrupcao },
    { rx: /credenciamento.*preposto/i, flag: px.credenciamentoPreposto },

    // adicionais
    { rx: /vistoria\s+t[eé]cnica/i, flag: px.vistoriaTecnica },
    { rx: /inmetro|anvisa|regulat[óo]rios/i, flag: px.certificacoesRegulatorios },
    { rx: /plano\s+de\s+trabalho|metodolog/i, flag: px.planoTrabalhoMetodologia },
    { rx: /garantia\s+da?\s+proposta/i, flag: px.garantiaProposta },
    { rx: /garantia\s+contratual/i, flag: px.garantiaContratual },
    { rx: /seguros?/i, flag: px.seguros },
  ];

  const found = rules.find(r => want(r.rx));
  if (!found) {
    return {
      status: 'partial',
      text: `Requisito: ${requirement}\n\n**ATENDIDO PARCIALMENTE** — Item administrativo sem mapeamento explícito; verificar no cadastro.`,
    };
  }

  const ok = !!found.flag;
  const status = ok ? 'ok' : 'no';
  const label = ok ? '**ATENDIDO**' : '**NÃO ATENDIDO**';
  return {
    status,
    text: `Requisito: ${requirement}\n\n${label} — Avaliado contra o cadastro administrativo da empresa.`,
  };
}

/* ============================================================
 * 5) TECH: análise baseada nas evidências (fallback)
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
 * 6) Wrapper: decide ADMIN (perfil) vs TECH (CAT/evidência)
 * ============================================================ */
async function analyzeRequirementWithContext(requirement, evidence, companyProfile) {
  const kind = classifyRequirement(requirement);
  if (kind === 'ADMIN') {
    const res = analyzeAdminRequirementAgainstProfile(requirement, companyProfile || {});
    return res.text;
  }
  // TECH (CATs são usadas no core; aqui é apenas fallback textual)
  return await analyzeSingleRequirement(requirement, evidence);
}

/* ============================================================
 * 7) Helpers p/ Controller: normalização/summary/recomendação
 * ============================================================ */
function normalizeSummary(md = '') {
  let s = String(md || '').trim();
  s = s.replace(/^\s*(?:#{1,6}\s*)?\**\s*sum[áa]rio\s+executivo\s*\**\s*:?\s*\n+/i, '');
  return s.trim();
}

function statusFromText(txt = '') {
  const t = String(txt).toLowerCase();
  if (/\bn[aã]o\s+atendido\b/.test(t) || /🔴/.test(txt)) return 'no';
  if (/atendido\s+parcialmente/.test(t) || /🟡/.test(txt)) return 'partial';
  if (/\batendido\b/.test(t) || /🟢/.test(txt)) return 'ok';
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

// 70% técnico / 30% administrativo
function buildRecommendation({ tech, admin, hasAlignedCAT }) {
  if (tech.tot === 0) {
    tech.ok = hasAlignedCAT ? 1 : 0;
    tech.partial = 0;
    tech.no = hasAlignedCAT ? 0 : 1;
    tech.tot = 1;
    tech.score = hasAlignedCAT ? 1 : 0;
  } else if (hasAlignedCAT) {
    tech.score = Math.max(tech.score, 0.70);
  }

  const wT = 0.70, wA = 0.30;
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
    `**Atendimento global (ponderado 70/30): ${pct(global)}%**`
  ].join('\n');

  return { label, bullet, globalScore: global, markdown };
}

async function generateExecutiveSummary(detailedAnalyses) {
  const getStatus = (txt = "") => {
    const t = txt.toLowerCase();
    if (/\b(n[aã]o\s+atendido)\b/.test(t) || /🔴/.test(txt)) return "NAO";
    if (/\batendido parcialmente\b/.test(t) || /🟡/.test(txt)) return "PARCIAL";
    if (/\batendido\b/.test(t) || /🟢/.test(txt)) return "OK";
    return "PARCIAL";
  };
  const getTitle = (txt = "") => {
    const m = txt.match(/^\s*\**Requisito:\**\s*(.+?)\n/i);
    return (m?.[1] || "").trim();
  };

  const items = (Array.isArray(detailedAnalyses) ? detailedAnalyses : [])
    .map(raw => ({ title: getTitle(raw), status: getStatus(raw), raw }))
    .filter(i => i.title || i.raw);

  const strengths = items.filter(i => i.status === "OK")
    .slice(0, 5)
    .map(i => `- ${i.title || "(requisito atendido)"}`);

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

  return [pf, gap].join("\n\n");
}

/* ============================================================
 * 8) Busca de evidências (local + Mongo vetorial) — fallback
 * ============================================================ */
async function findEvidenceOnTheFly(requirement, filesMeta, mongoCollection) {
  const qv = await embedText(requirement);

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

      const anexMatch = requirement.match(/anexo\s+([xivlcdm0-9]+)/i);
      if (anexMatch) {
        const anexHint = String(anexMatch[1]).toUpperCase();
        const rxAnexo = new RegExp(`anexo\\s*${anexHint}`, 'i');
        if (rxAnexo.test(ctext)) score += 0.10;
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
      console.log('-> Aviso: Busca no MongoDB falhou.', e.message);
    }
  }

  const allHits = [...localHits, ...mongoHits];
  const sortedUniqueHits = allHits
    .sort((a, b) => b.score - a.score)
    .filter((v, i, a) => a.findIndex(t => (t.text === v.text)) === i);

  return sortedUniqueHits.slice(0, 4);
}

/* ============================================================
 * Exports
 * ============================================================ */
module.exports = {
  // classificação
  TECH_REQ_RX,
  ADMIN_REQ_RX,
  classifyRequirement,

  // admin + wrapper
  analyzeAdminRequirementAgainstProfile,
  analyzeRequirementWithContext,

  // técnico/evidências
  extractRequirementsFromBid,
  analyzeSingleRequirement,
  findEvidenceOnTheFly,

  // sumário e recomendação
  normalizeSummary,
  summarize,
  generateExecutiveSummary,
  buildRecommendation,
};
