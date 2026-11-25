// src/services/evidence.js
// Implementações leves e puramente síncronas/assíncronas para evitar ciclos de require.

/** Util: normaliza espaços/acentos básicos para busca ingênua */
function norm(s = '') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Extrai (heuristicamente) linhas de requisitos do texto do edital */
async function extractRequirementsFromBid(editalText = '') {
  if (!editalText) return [];

  const lines = String(editalText).split(/\r?\n/);
  const out = new Set();

  const needles = [
    /habilita[cç][aã]o/i,
    /documenta[cç][aã]o/i,
    /requisitos?/i,
    /condi[cç][oõ]es/i,
    /exig[eê]ncias?/i,
    /proposta/i,
    /certid[aã]o/i,
    /regularidade/i,
    /anvisa|mapa/i,
    /fgts|trabalhista|inss|fazenda/i,
    /atestado|capacidade t[eé]cnica/i,
    /respons[aá]vel t[eé]cnico|rt\b/i,
  ];

  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (needles.some(rx => rx.test(l))) {
      out.add(l);
    }
  }

  if (out.size === 0) {
    return [
      'Prova de regularidade para com a Fazenda Federal, Estadual, Distrital e Municipal.',
      'Certidões Negativas de Débitos (Trabalhista/INSS/Federal/Estadual/Municipal).',
      'Comprovante de Regularidade do Empregador (FGTS).',
      'Apresentação de proposta comercial discriminada.',
      'Apresentação de pelo menos um atestado de capacidade técnica.',
    ];
  }

  return Array.from(out).slice(0, 60);
}

/** Busca evidências indexadas da empresa e usa arquivos locais como fallback. */
async function findEvidenceOnTheFly(
  reqTxt,
  filesForEvidenceSearch = [],
  repository,
  opts = {}
) {
  const {
    tenantId = null,
    domainSet = [],
    limit = 8,
    minLen = 50,
    sources = null,
  } = opts || {};

  const hits = [];
  if (!reqTxt || typeof reqTxt !== 'string') return hits;

  const queryTokens = [...new Set(norm(reqTxt).split(/\W+/).filter(t => t.length > 3))].slice(0, 40);
  if (repository && tenantId && queryTokens.length) {
    const rows = await repository.searchChunks(tenantId, queryTokens, Math.max(limit * 2, 16), {
      domains: Array.isArray(domainSet) ? domainSet : [],
      sources: Array.isArray(sources) ? sources : [],
    });
    for (const row of rows) {
      const raw = String(row.text || '');
      const normalized = norm(raw);
      const token = queryTokens.find(word => normalized.includes(word));
      if (!token) continue;
      const at = normalized.indexOf(token);
      const snippet = raw.slice(Math.max(0, at - 250), at + 250).replace(/\s+/g, ' ').trim();
      if (snippet.length >= minLen) hits.push({ source: row.source, snippet });
      if (hits.length >= limit) break;
    }
    if (hits.length) return hits;
  }

  const key = norm(reqTxt).slice(0, 120);
  for (const f of filesForEvidenceSearch || []) {
    try {
      const txt = await f.getText();
      if (!txt) continue;
      const nTxt = norm(txt);
      if (!nTxt) continue;

      const tokens = key.split(/\W+/).filter(t => t && t.length > 3);
      const ok = tokens.length ? tokens.every(t => nTxt.includes(t)) : nTxt.includes(key);
      if (!ok) continue;

      const anchor = tokens.find(t => nTxt.includes(t)) || key;
      const idx = nTxt.indexOf(anchor);
      const start = Math.max(0, idx - 250);
      const end = Math.min(nTxt.length, idx + 250);
      const snippet = txt.substring(start, end).replace(/\s+/g, ' ').trim();

      if (snippet.length >= minLen) {
        hits.push({ source: f.source || 'edital', snippet });
      }
      if (hits.length >= limit) break;
    } catch {
      // ignora erros de OCR local
    }
  }

  return hits.slice(0, limit);
}


/** Analisa um requisito com base nas "evidências" (heurística leve) */
async function analyzeRequirementWithContext(reqTxt = '', evidence = [], companyProfile = {}, opts = {}) {
  const positiveHints = ['apresentar', 'deverá', 'obrigatório', 'exigir', 'exigido', 'comprovação', 'comprovante', 'certidão', 'regularidade'];
  const negativeHints = ['dispensa', 'não se aplica', 'inexigível'];

  const hasEv = evidence && evidence.length > 0;
  const hasPositive = hasEv && evidence.some(e => positiveHints.some(h => norm(e.snippet).includes(h)));
  const hasNegative = hasEv && evidence.some(e => negativeHints.some(h => norm(e.snippet).includes(h)));

  let status = '🟡 ATENDIDO PARCIALMENTE.';
  if (hasNegative) status = '🟢 ATENDIDO.';
  else if (hasEv && hasPositive) status = '🟢 ATENDIDO.';
  else if (!hasEv) status = '🔴 NÃO ATENDIDO.';

  const bullets = (evidence || []).map(e => `- **${e.source}:** ${e.snippet}`).join('\n');

  return [
    `Requisito: ${reqTxt}`,
    '',
    status,
    hasEv ? `**Evidências encontradas:**\n${bullets}` : '_Nenhuma evidência localizada._'
  ].join('\n');
}

/** Gera um sumário executivo simples com base nos blocos de análise */
async function generateExecutiveSummary(analysesMd = []) {
  const text = analysesMd.join('\n\n');
  const ok = (text.match(/🟢/g) || []).length;
  const parcial = (text.match(/🟡/g) || []).length;
  const nao = (text.match(/🔴/g) || []).length;
  const total = ok + parcial + nao || 1;
  const pct = Math.round(((ok + 0.5 * parcial) / total) * 100);

  const recomendacao = pct >= 75
    ? '🟢 PARTICIPAÇÃO RECOMENDADA'
    : pct >= 60
      ? '🟡 PARTICIPAÇÃO RECOMENDADA COM AJUSTES'
      : pct >= 40
        ? '🟠 AVALIAR E REGISTRAR RISCOS'
        : '🔴 PARTICIPAÇÃO NÃO RECOMENDADA';

  return [
    '### Recomendação Final',
    recomendacao,
    '',
    '### Pontos Fortes',
    '- Requisitos analisados com base nas evidências indexadas (Mongo-first).',
    '',
    '### Pontos de Atenção / GAPs',
    nao ? `- Há ${nao} requisito(s) com **NÃO ATENDIDO**.` : '- Sem “NÃO ATENDIDO” identificado.',
    parcial ? `- Há ${parcial} requisito(s) com **ATENDIDO PARCIALMENTE**.` : '- Sem “ATENDIDO PARCIALMENTE”.',
    '',
    `Score estimado: **${pct}%**`
  ].join('\n');
}

/** Conta requisitos eliminatórios não atendidos (heurística) */
function countEliminatoryFailures(analysesMd = []) {
  const t = Array.isArray(analysesMd) ? analysesMd.join('\n') : String(analysesMd || '');
  const nao = (t.match(/🔴/g) || []).length;
  const elim = (t.match(/eliminat[óo]ri/gi) || []).length;
  return nao + Math.min(elim, 3);
}

/** Probabilidade de sucesso ponderando técnico/documental e penalizando eliminatórios */
function computeSuccessProbability(techScore = 0.5, docScore = 0.5, eliminatorios = 0) {
  const base = 0.7 * techScore + 0.3 * docScore;
  const penalty = Math.min(0.5, eliminatorios * 0.12);
  return Math.max(0, Math.min(1, base - penalty));
}

/** Banner superior (markdown) */
function renderSuccessBanner(prob = 0.5, eliminatorios = 0) {
  const pct = Math.round(prob * 100);
  const cor = pct >= 75 ? '🟢' : pct >= 60 ? '🟡' : pct >= 40 ? '🟠' : '🔴';
  const elimTxt = eliminatorios ? ` • Eliminatórios não atendidos: ${eliminatorios}` : '';
  return `> ${cor} **Probabilidade de êxito estimada: ${pct}%**${elimTxt}`;
}

module.exports = {
  extractRequirementsFromBid,
  analyzeRequirementWithContext,
  generateExecutiveSummary,
  findEvidenceOnTheFly, // Mongo-first (companyId), suporta text/content; fallback local
  countEliminatoryFailures,
  computeSuccessProbability,
  renderSuccessBanner,
};
