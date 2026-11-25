// src/services/cats.js

/* ========================== Utils base ========================== */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tokenize(text = '') {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(aTokens = [], bTokens = []) {
  const A = new Set(aTokens), B = new Set(bTokens);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

function pickReasonableYear(text = '') {
  const yrs = (String(text).match(/\b(19\d{2}|20\d{2})\b/g) || [])
    .map(Number)
    .filter(y => y >= 1990 && y <= 2099);
  return yrs.length ? String(Math.max(...yrs)) : '';
}

/* ================ Taxonomias ================= */
/** Domínios TÉCNICOS (área de conhecimento/escopo) */
const TECH_DOMAINS = {
  eletrica: [
    'subestacao','subestacoes','lt','linha de transmissao','linhas de transmissao',
    'barramento','barramentos','isolador','isoladores','cadeia de suspensao','ferragens',
    'disjuntor','seccionadora','transformador','para-raios','para raios',
    'termografia','energizada','manobra','230kv','138kv','500kv','69kv','34,5kv','13,8kv',
    'painel eletrico','painel de protecao','rele','relé','cabos pba','cabos'
  ],
  engenharia_civil: [
    'obra civil','edificacao','edificacoes','alvenaria','argamassa','reboco',
    'concreto','fck','fundacao','fundacoes','estrutura','pilar','viga',
    'brita','areia lavada','revestimento','pavimentacao','terraplenagem'
  ],
  saneamento: [
    'eta','ete','estacao de tratamento','agua potavel','esgoto','adutora',
    'bomba de recalque','registro','valvula','cloracao','floculador','decantador'
  ],
  pet_suplies: [
    'areia higienica','areia sanitaria','litter','gato','gatos','felino','felinos',
    'pet shop','veterinaria','veterinario'
  ],
  hidraulica: [
    'rede de agua','rede de esgoto','tubulacao','hidraulica'
  ],
};

/** Modalidades (natureza da contratação) */
const MODALITIES = {
  fornecimento: [
    'fornecimento','aquisicao','aquisição','compra','suprimento','material','materiais','insumo','insumos'
  ],
  servico: [
    'servico','servicos','manutencao','manutenção','instalacao','instalação',
    'inspecao','substituicao','troca','intervencao','calibracao','comissionamento'
  ],
  obra: [
    'obra','execucao','execução','construcao','construção','ampliacao','ampliação','reforma'
  ],
};

/* ======= Detectores de domínios/modalidades ======= */
function detectTechnicalDomains(text = '') {
  const t = normalize(text);
  const hits = new Set();
  for (const [dom, kws] of Object.entries(TECH_DOMAINS)) {
    if (kws.some(kw => t.includes(kw))) hits.add(dom); // já minúsculo
  }
  // compat: se bater com padrões antigos genéricos, adiciona rótulo
  // (mantém aderência com bases legadas)
  if (/\beletric[a-o]|baixa\s+tensao|iluminacao|luminaria|quadro\s+eletrico|cabeamento\b/.test(t)) hits.add('eletrica');
  if (/\bobra|construcao|edificacao|pavimentacao|alvenaria|concreto|estrutura|fundacao\b/.test(t)) hits.add('engenharia_civil');
  if (/\bhidraulica|rede\s+de\s+agua|rede\s+de\s+esgoto|tubulacao|adutora\b/.test(t)) hits.add('saneamento');
  return hits;
}

function detectModalities(text = '') {
  const t = normalize(text);
  const hits = new Set();
  for (const [mod, kws] of Object.entries(MODALITIES)) {
    if (kws.some(kw => t.includes(kw))) hits.add(mod);
  }
  // Fallback heurístico: presença de quantidades/unidades tende a fornecimento
  if (!hits.size && /\b(un|unid|quantidade|item|kg|m2|m3|m|l|litro|saco|embalagem|peca|peça)\b/.test(t)) {
    hits.add('fornecimento');
  }
  return hits;
}

/**
 * Compat: função que teu código já consumia.
 * Agora retorna um Set com labels combinando DOMÍNIOS técnicos + MODALIDADES.
 */
function detectDomain(text = '') {
  const labels = new Set([
    ...detectTechnicalDomains(text),
    ...detectModalities(text),
  ]);
  return labels;
}

/** Interseção simples de Sets */
function hasIntersection(setA = new Set(), setB = new Set()) {
  for (const x of setA) if (setB.has(x)) return true;
  return false;
}

/** Modalidades compatíveis:
 * - fornecimento <> fornecimento
 * - servico/obra são compatíveis entre si e com servico
 * (ajuste conforme tua regra de negócio)
 */
function modalitiesAreCompatible(mA = new Set(), mB = new Set()) {
  if (!mA.size && !mB.size) return true; // desconhecido: não bloqueia
  if (mA.has('fornecimento') || mB.has('fornecimento')) {
    return mA.has('fornecimento') && mB.has('fornecimento');
  }
  // serviço/obra compatíveis bidirecionalmente
  const group = new Set(['servico','obra']);
  return hasIntersection(new Set([...mA].filter(x => group.has(x))), new Set([...mB].filter(x => group.has(x))));
}

/** Gate principal: precisa domínio técnico em comum + modalidades compatíveis */
function sameDomainGate(editalText = '', catText = '') {
  const dE = detectTechnicalDomains(editalText);
  const dC = detectTechnicalDomains(catText);
  if (!hasIntersection(dE, dC)) return false;

  const mE = detectModalities(editalText);
  const mC = detectModalities(catText);
  return modalitiesAreCompatible(mE, mC);
}

/** Compat com teu nome anterior (era permissivo demais):
 * agora usa o gate correto.
 */
function isEngineeringSet(domSet) {
  const arr = [...domSet];
  return arr.some(d => ['engenharia_civil','eletrica','saneamento','hidraulica'].includes(d));
}

function hasDomainOverlap(bidText = '', catRaw = '', catFileName = '') {
  const bid = [bidText].filter(Boolean).join(' ');
  const cat = [catRaw, catFileName].filter(Boolean).join(' ');
  return sameDomainGate(bid, cat);
}

/* ================ Scoring & ranking ================= */
function scoreCatToObjetoLote(catMeta, objeto = '', loteTexto = '') {
  const probe = [objeto, loteTexto].filter(Boolean).join(' ').trim();
  const catAll = [catMeta?.raw, catMeta?.escopo, catMeta?.fileName].filter(Boolean).join(' ');

  // 1) Gate duro: sem domínio/mod. compatíveis -> 0
  if (!sameDomainGate(probe, catAll)) return 0;

  // 2) Similaridade base (mantendo tua escala)
  const objTok = tokenize(probe);
  const catTok = tokenize(catMeta?.raw || catMeta?.escopo || catMeta?.fileName || '');
  let score = 0;
  score += jaccard(objTok, catTok) * 6;

  const objStr = normalize(probe);
  const catStr = normalize(catMeta?.raw || catMeta?.escopo || '');

  // 3) Bônus por correspondência específica por domínio
  // Civil
  if (/\balvenaria|edifica|constru/.test(objStr) && /\balvenaria|edifica|constru/.test(catStr)) score += 3;
  // Elétrica (inclui tensões e termos de LT/SE)
  if (/(subestac|linha de transmiss|isolador|ferragens|termografia|230kv|138kv|500kv|69kv|34,5kv|13,8kv)/.test(objStr)
   && /(subestac|linha de transmiss|isolador|ferragens|termografia|230kv|138kv|500kv|69kv|34,5kv|13,8kv)/.test(catStr)) score += 3;
  // Saneamento/Hidráulica
  if (/(hidr[aá]ul|esgoto|tubul|adutora|eta|ete|estacao de tratamento)/.test(objStr)
   && /(hidr[aá]ul|esgoto|tubul|adutora|eta|ete|estacao de tratamento)/.test(catStr)) score += 3;
  // PET
  if (/(areia higienica|areia sanitaria|litter|felino|gatos)/.test(objStr)
   && /(areia higienica|areia sanitaria|litter|felino|gatos)/.test(catStr)) score += 3;

  // 4) Evidências formais
  if (catMeta?.hasART)  score += 1;
  if (catMeta?.hasCREA) score += 1;

  // 5) Penalidades anti cross-domain forte (ex.: PET x Civil)
  const hasPET = /(areia higienica|areia sanitaria|litter|felino|gatos)/.test(catStr);
  const hasCivil = /(alvenaria|edifica|constru|concreto|fundac|estrutura)/.test(catStr);
  const hasEletrica = /(subestac|linha de transmiss|isolador|ferragens|230kv|138kv|500kv|69kv|34,5kv|13,8kv|painel eletrico|rele)/.test(catStr);
  const objIsPET = /(areia higienica|areia sanitaria|litter|felino|gatos)/.test(objStr);
  const objIsCivil = /(alvenaria|edifica|constru|concreto|fundac|estrutura)/.test(objStr);
  const objIsEletrica = /(subestac|linha de transmiss|isolador|ferragens|230kv|138kv|500kv|69kv|34,5kv|13,8kv|painel eletrico|rele)/.test(objStr);

  // Se objetivo é PET e CAT tem termos fortes de Civil/Elétrica -> penaliza
  if (objIsPET && (hasCivil || hasEletrica)) score -= 3;
  // Se objetivo é Civil/Elétrica e CAT é claramente PET -> penaliza
  if ((objIsCivil || objIsEletrica) && hasPET) score -= 3;

  return score;
}

/* ================ Normalização/extração ================= */
function parseCatMetaFromRaw(text = '', sourceName = '') {
  const ano     = pickReasonableYear(text) || '';
  const hasART  = /(^|\W)ART(\W|$)/i.test(text);
  const hasCREA = /(^|\W)(?:CREA|CAU)(\W|$)/i.test(text);
  const catNum  = ((text.match(/\bCAT\s*(?:n[ºo]\s*)?[:\-]?\s*([A-Z0-9.\-\/]{4,})/i) || [,''])[1] || '').trim() || null;

  const orgaoMatch = text.match(/\b(SECRETARIA(?:\s+DE)?|PREFEITURA(?:\s+MUNICIPAL)?|GOVERNO\s+DO\s+ESTADO|MINIST[EÉ]RIO|COMPANHIA|PORTO\s+DO\s+\w+|EMLURB|PM\s+DE\s+\w+)/i);
  const orgao = orgaoMatch ? orgaoMatch[0] : null;

  return {
    raw: text,
    escopo: text.slice(0, 2000),
    fileName: sourceName || 'local',
    nomeCAT: sourceName || 'local',
    orgao,
    catNum,
    ano,
    hasART,
    hasCREA,
  };
}

/* ================ Busca de CATs ================= */
async function findCATMatches(ctxOrNull, textoAlvo, limit = 12, localFilesText = [], opts = {}) {
  const debug = typeof opts.debug === 'function' ? opts.debug : () => {};
  const pool = [];

  const companyId = opts.tenantId || opts.companyId;
  if (ctxOrNull && companyId) {
    const docs = await ctxOrNull.list(companyId, { limit: 100, includeText: true });
    debug({ kind: 'mysqlBatchCats', total: docs.length });
    docs.forEach((doc, i) => {
      debug({ kind: 'mysqlItemCats', i: i + 1, source: doc.fileName || 'mysql-cat' });
      const meta = parseCatMetaFromRaw(doc.fullText || '', doc.fileName || doc.source);
      meta.catNum = doc.meta?.cat?.numeroCat || meta.catNum;
      const score = scoreCatToObjetoLote(meta, textoAlvo, '');
      if (score > 0) pool.push({ meta, score });
    });
  }

  if (ctxOrNull && companyId) {
    const docs = await ctxOrNull.listChunks(companyId, 200);
    debug({ kind: 'mysqlBatchChunks', total: docs.length });
    docs.forEach((doc, i) => {
      debug({ kind: 'mysqlItemChunks', i: i + 1, source: doc.source || 'mysql-chunk' });
      const meta = parseCatMetaFromRaw(doc.text || doc.raw || '', doc.source || 'mysql-chunk');
      const score = scoreCatToObjetoLote(meta, textoAlvo, '');
      if (score > 0) pool.push({ meta, score });
    });
  }

  if (Array.isArray(localFilesText) && localFilesText.length) {
    debug({ kind: 'localBatch', total: localFilesText.length });
    localFilesText.forEach((f, i) => {
      debug({ kind: 'localItem', i: i + 1, source: f.source || 'local' });
      const meta = parseCatMetaFromRaw(f.text || '', f.source || 'local');
      const score = scoreCatToObjetoLote(meta, textoAlvo, '');
      if (score > 0) pool.push({ meta, score });
    });
  }

  const ranked = pool
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p) => ({ ...p.meta, _score: clamp(p.score / 10, 0, 1) }));

  return uniqueByCat(ranked);
}

/* ================ Dedup ================= */
function uniqueByCat(arr = []) {
  const seen = new Set(); const out = [];
  for (const c of arr) {
    const k = (c.catNum || c.fileName || c.nomeCAT || '').toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

/* ================ Sugerir RT ================= */
function suggestBestRT(cats = [], objeto = '') {
  if (!cats.length) return null;
  const best = cats[0];
  const profMatch = (best.raw || '').match(/\b(Eng(?:\.|enheiro)?\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][^\n,;]{3,80})/i);
  const profissional = (best.profissional || (profMatch ? profMatch[1] : '') || '').trim();
  return { profissional: profissional || '', conselho: best.conselho || best.orgao || '' };
}

/* ================ Comparar requisitos vs CAT ================= */
function compareReqVsCat(reqText = '', catRaw = '') {
  const out = [];
  const R = normalize(reqText);
  const C = normalize(catRaw);

  // Elétrica
  if (/(subestac|linha de transmiss|isolador|ferragens|termografia|230kv|138kv|500kv|69kv|34,5kv|13,8kv|painel eletrico|rele)/.test(R)
   && /(subestac|linha de transmiss|isolador|ferragens|termografia|230kv|138kv|500kv|69kv|34,5kv|13,8kv|painel eletrico|rele)/.test(C))
    out.push('CAT demonstra experiência em LT/Subestação (instalações e/ou manutenção com tensões citadas).');

  // Civil
  if (/\balvenaria|edifica|constru|concreto|fundac|estrutura\b/.test(R)
   && /\balvenaria|edifica|constru|concreto|fundac|estrutura\b/.test(C))
    out.push('CAT demonstra experiência com obras civis (alvenaria/edificações/estrutura).');

  // Saneamento/Hidráulica
  if (/(hidr[aá]ul|esgoto|tubul|adutora|eta|ete|estacao de tratamento)/.test(R)
   && /(hidr[aá]ul|esgoto|tubul|adutora|eta|ete|estacao de tratamento)/.test(C))
    out.push('CAT demonstra experiência com instalações hidráulicas/saneamento (ETA/ETE/adutoras).');

  // PET / Fornecimento específico
  if (/(areia higienica|areia sanitaria|litter|felino|gatos)/.test(R)
   && /(areia higienica|areia sanitaria|litter|felino|gatos)/.test(C))
    out.push('CAT demonstra experiência com fornecimento de insumos PET (areia higiênica).');

  return out;
}

/* ================ Assinaturas (debug) ================= */
function signaturesFor(tenantId, text = '') {
  const low = normalize(text);
  const sample = low.slice(0, 100).replace(/\s+/g, ' ');
  return { short: sample };
}

/* =============================== Exports =============================== */
module.exports = {
  // Detectores e gate
  detectDomain,                 // mantém compatibilidade (Set de labels)
  detectTechnicalDomains,       // novo (Set de domínios técnicos)
  detectModalities,             // novo (Set de modalidades)
  sameDomainGate,               // novo (gate por domínio técnico + modalidade)
  hasDomainOverlap,             // mantido, agora usa gate novo

  // Busca e ranking
  findCATMatches,
  uniqueByCat,
  scoreCatToObjetoLote,

  // Auxiliares
  suggestBestRT,
  compareReqVsCat,
  signaturesFor,

  // Utils
  clamp,
  pickReasonableYear,
  tokenize,
  jaccard,
};
