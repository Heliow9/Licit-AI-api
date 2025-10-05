// services/cats.js
const { extractCATMeta } = require('../utils/cat_meta');

/** Taxonomia de domínios + palavras-chave (facilmente expandível) */
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

/** Sinônimos adicionais (bem comuns em filename) por domínio */
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

/** Assinaturas de domínio a partir de um texto (objeto/lote ou CAT) */
function signaturesFor(text = '') {
  const s = String(text || '').toLowerCase();
  const hits = new Set();
  for (const [dom, terms] of Object.entries(DOMAIN_LEXICON)) {
    if (terms.some(rx => new RegExp(rx, 'i').test(s))) hits.add(dom);
  }
  return Array.from(hits);
}

/** Base de termos: quando há domínio, foca; quando não, usa conjunto amplo */
function baseTermSet(seed = '') {
  const doms = signaturesFor(seed);
  const set = new Set();
  if (doms.length) {
    set.add('Certidão de Acervo Técnico');
    set.add('\\bCAT\\b');
    set.add('atestado');
    set.add('responsável técnico');
    set.add('manuten[çc][aã]o');
    set.add('obra');
    doms.forEach(dom => {
      (DOMAIN_LEXICON[dom] || []).forEach(t => set.add(t));
    });
  } else {
    ['\\bCAT\\b', '\\bART\\b', '\\bCREA\\b', 'manuten[çc][aã]o', 'obra', 'atestado'].forEach(t => set.add(t));
  }
  return set;
}

/** Extrai meta do filename: ano, catNum, órgão e domínios pelo nome */
function parseFilenameMeta(fileName = '') {
  const fn = String(fileName || '');
  const lower = fn.toLowerCase();

  const catNum = (lower.match(/cat\s*(?:n[ºo]\s*)?[\-:\s]*([\d]{2,}\/?\d{0,4})/) || [])[1] || '';
  const ano    = (fn.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';

  // Órgão comum no nome
  let orgao = '';
  const orgMatches = fn.match(/\b(CELPE|CHESF|PM\s+DE\s+[A-ZÇÃÕ ]+|PREFEITURA\s+DE\s+[A-ZÇÃÕ ]+|CREA-?[A-Z]{2})\b/i);
  if (orgMatches) orgao = orgMatches[0];

  // Domínios: lexicon + sinônimos extra
  const hits = new Set(signaturesFor(fn));
  for (const [dom, syns] of Object.entries(EXTRA_DOMAIN_SYNONYMS)) {
    if (syns.some(rx => new RegExp(rx, 'i').test(fn))) hits.add(dom);
  }

  return {
    fileCatNum: catNum || null,
    fileYear: ano || null,
    fileOrgao: orgao || null,
    fileDomains: Array.from(hits)
  };
}

/** Overlap de domínios entre objeto e texto/filename da CAT */
function hasDomainOverlap(objText = '', catText = '', fileName = '') {
  const objSigs = new Set(signaturesFor(objText));
  if (!objSigs.size) return true; // sem domínio no objeto, não bloqueia
  const catSigs = new Set([
    ...signaturesFor(catText || ''),
    ...signaturesFor(fileName || '')
  ]);
  for (const [dom, syns] of Object.entries(EXTRA_DOMAIN_SYNONYMS)) {
    if (new RegExp(syns.join('|'), 'i').test(fileName)) catSigs.add(dom);
  }
  for (const d of objSigs) if (catSigs.has(d)) return true;
  return false;
}

// util para quando vier só "source" e quisermos tratá-lo como nome
function pathSafeFileName(src = '') {
  const p = String(src);
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Busca híbrida por CATs:
 * - Mongo (preferencial), agora consultando DUAS coleções:
 *   -> cats  (com fileName/fullText)
 *   -> chunks (compatibilidade com índice vetorial/regex por texto)
 * - Arquivos locais enviados (fallback/combinação)
 * opts.debug(evt) recebe eventos: {kind, total?, i?, source?, offset?}
 *
 * Aceita:
 *   - collectionOrChunks = { catsCol, chunksCol }  (preferível)
 *   - collectionOrChunks = chunksCol                (compatibilidade)
 */
async function findCATMatches(collectionOrChunks, objetoText, limit = 6, localFiles = [], opts = {}) {
  const termSet = baseTermSet(objetoText || '');
  const debug = typeof opts.debug === 'function' ? opts.debug : () => {};
  let cats = [];

  // Aceitar collection única (chunks) ou objeto { catsCol, chunksCol }
  const catsCol   = collectionOrChunks?.catsCol || null;
  const chunksCol = collectionOrChunks?.chunksCol || (collectionOrChunks && !collectionOrChunks.catsCol ? collectionOrChunks : null);

  const objDomains = signaturesFor(objetoText || '');

  // ====== 1) Coleção CATS (preferencial)
  if (catsCol) {
    const mustBeCAT = {
      $or: [
        { fileName: { $regex: 'cat|certid[aã]o.*acervo|acervo.*t[ée]cnico', $options: 'i' } },
        { fullText: { $regex: 'Certid[aã]o de Acervo T[ée]cnico|\\bCAT\\b', $options: 'i' } }
      ]
    };

    const domainFilter = objDomains.length
      ? {
          $or: [
            { fileName: { $regex: (DOMAIN_LEXICON[objDomains[0]] || []).join('|'), $options: 'i' } },
            { fullText: { $regex: (DOMAIN_LEXICON[objDomains[0]] || []).join('|'), $options: 'i' } }
          ]
        }
      : null;

    const q = domainFilter ? { $and: [ mustBeCAT, domainFilter ] } : mustBeCAT;

    const proj = { _id: 0, source: 1, fileName: 1, fullText: 1 };
    const catsDocs = await catsCol.find(q, { projection: proj }).limit(limit * 5).toArray();

    debug({ kind: 'mongoBatchCats', total: catsDocs.length });
    for (let i = 0; i < catsDocs.length; i++) {
      const doc = catsDocs[i];
      cats.push({ source: doc.source || doc.fileName, fileName: doc.fileName, text: doc.fullText });
      debug({ kind: 'mongoItemCats', i: i + 1, total: catsDocs.length, source: doc.fileName });
    }
  }

  // ====== 2) Coleção CHUNKS (compatibilidade com o código atual)
  if (chunksCol) {
    const orTerms = Array.from(termSet).map(t => ({ text: { $regex: t, $options: 'i' } }));
    const mustBeCAT = [
      { text: { $regex: 'Certid[aã]o de Acervo T[ée]cnico', $options: 'i' } },
      { text: { $regex: '\\bCAT\\b', $options: 'i' } },
    ];
    const q = { $and: [ { $or: mustBeCAT }, { $or: orTerms } ] };
    const chunks = await chunksCol.find(q, { projection: { _id: 0, source: 1, text: 1 } }).limit(limit * 3).toArray();

    debug({ kind: 'mongoBatchChunks', total: chunks.length });
    for (let i = 0; i < chunks.length; i++) {
      const doc = chunks[i];
      cats.push({ source: doc.source, fileName: pathSafeFileName(doc.source), text: doc.text });
      debug({ kind: 'mongoItemChunks', i: i + 1, total: chunks.length, source: doc.source });
    }
  }

  // ====== 3) Locais (mesma lógica de antes)
  const looksLikeCATName = (name = '') =>
    /cat|certid[aã]o.*acervo|acervo.*t[ée]cnico/i.test(name) && !/edital/i.test(name);

  const strongCATFingerprint = (txt = '') =>
    /Certid[aã]o de Acervo T[ée]cnico/i.test(txt) && /CAT\s*[NºNo\.:\- ]+\s*\d{3,}/i.test(txt);

  const localCandidates = [];
  for (const f of localFiles) {
    if (!f?.text) continue;
    if (!(looksLikeCATName(f.source) || strongCATFingerprint(f.text))) continue;

    if (Array.from(termSet).some(t => new RegExp(String(t), 'i').test(f.text))) {
      localCandidates.push({ source: f.source, fileName: f.source, text: f.text });
    }
  }
  debug({ kind: 'localBatch', total: localCandidates.length, offset: cats.length });
  for (let i = 0; i < localCandidates.length; i++) {
    const cand = localCandidates[i];
    cats.push(cand);
    debug({ kind: 'localItem', i: i + 1, total: localCandidates.length, offset: cats.length - localCandidates.length, source: cand.source });
  }

  // ====== 4) Scoring + filtros (inclui sinais do filename)
  const scored = (cats || []).map(c => {
    const metaFromText = extractCATMeta(c.source, c.text || ''); // extrai hasART/hasCREA/mentions...
    const fromName = parseFilenameMeta(c.fileName || c.source || '');
    const meta = { ...metaFromText, fileName: c.fileName, raw: metaFromText.raw, fileHints: fromName };

    let score = 0;

    // Ocorrência de termos no texto
    for (const t of termSet) if (new RegExp(t, 'i').test(meta.raw)) score += 1;

    // Metadados do texto
    if (meta.hasART) score += 2;
    if (meta.hasCREA) score += 1;
    if (meta.mentionsManut) score += 1;
    if (meta.mentionsObra) score += 1;
    if (/\batividade conclu[ií]da|obra conclu[ií]da|conclu[ií]d[ao]\b/i.test(meta.raw)) score += 1;

    // Bônus por domínios do filename baterem com o objeto
    const objSigs = new Set(signaturesFor(objetoText));
    const fileSigs = new Set(fromName.fileDomains || []);
    for (const d of objSigs) if (fileSigs.has(d)) score += 3;

    // Recência (ano do filename > ano no texto)
    const yr = Number(fromName.fileYear) || Number(pickReasonableYear(meta.raw)) || 0;
    if (yr) score += (yr - 2010) / 12;

    return { meta, score };
  })
  // Remove duplicadas por (nomeCAT + nº CAT) OU por filename
  .filter((v, i, a) =>
    a.findIndex(t =>
      (t.meta.nomeCAT === v.meta.nomeCAT && t.meta.catNum === v.meta.catNum) ||
      (t.meta.fileName && v.meta.fileName && t.meta.fileName === v.meta.fileName)
    ) === i
  )
  // Hard filter: se objeto tem domínio, exige overlap (texto ou filename)
  .filter(s => hasDomainOverlap(objetoText, s.meta.raw, s.meta.fileName))
  .sort((a, b) => b.score - a.score)
  .slice(0, limit * 3);

  debug({ kind: 'scored', count: scored.length });
  
  return scored.map(s => s.meta);
  
}

/** Ano razoável (capado em ano atual + 1 para evitar “2071”) */
function pickReasonableYear(text = '') {
  const now = new Date().getFullYear();
  const years = (String(text || '').match(/\b(19\d{2}|20\d{2})\b/g) || [])
    .map(Number)
    .filter(y => y >= 1990 && y <= (now + 1));
  return years.length ? String(Math.max(...years)) : '';
}

/** Remove duplicadas por arquivo/CAT nº */
function uniqueByCat(metaList) {
  const seen = new Set();
  return (metaList || []).filter(m => {
    const key = `${m.nomeCAT}|${m.catNum || ''}|${m.fileName || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Score orientado ao objeto + penalidades de domínio desalinhado (considera filename) */
function scoreCatToObjetoLote(cat, objeto = '', lote = '') {
  const catTxt = (cat.raw || '').toLowerCase();

  const objSigs  = new Set(signaturesFor(objeto));
  const loteSigs = new Set(signaturesFor(lote));
  const catSigs  = new Set(signaturesFor(catTxt));
  for (const d of (cat.fileHints?.fileDomains || [])) catSigs.add(d);

  let sc = 0;

  // BÔNUS mais forte por casar domínios
  for (const dom of objSigs) if (catSigs.has(dom)) sc += 4;
  for (const dom of loteSigs) if (catSigs.has(dom)) sc += 2;

  // Penalidade MAIS FORTE por conflitos
  for (const dom of Object.keys(DOMAIN_LEXICON)) {
    if (objSigs.size && !objSigs.has(dom) && catSigs.has(dom)) sc -= 5;
  }

  // Metadados úteis
  if (cat.hasART) sc += 2;
  if (cat.hasCREA) sc += 1;
  if (cat.mentionsManut) sc += 1;
  if (cat.mentionsObra) sc += 1;

  // Recência suavizada (considera ano do filename também)
  const yr = Number(pickReasonableYear(cat.raw)) || Number(cat.fileHints?.fileYear) || 0;
  if (yr) sc += (yr - 2015) / 10;

  // Afinidade de profissão
  if (/eletric/i.test(cat.titulo || '') && objSigs.has('eletrica')) sc += 1;
  if (/mec[aâ]nic/i.test(cat.titulo || '') && objSigs.has('clima')) sc += 0.5;

  return sc;
}

/** RT sugerido — pondera domínio/recência/metadados e respeita overlap */
function suggestBestRT(catMatches, objetoHint = '') {
  if (!catMatches?.length) return null;

  const pool = catMatches.filter(c => hasDomainOverlap(objetoHint, c.raw || '', c.fileName || ''));
  if (!pool.length) return null;

  const sObj = signaturesFor(objetoHint).join('|');
  const scored = [...pool].map(c => {
    let s = 0;
    const catDom = new Set([
      ...signaturesFor(c.raw || ''),
      ...(c.fileHints?.fileDomains || [])
    ]);
    // domínios batendo
    for (const d of catDom) if (sObj.includes(d)) s += 2;

    if (/manuten[cç][aã]o|predial|edifica/i.test(objetoHint)) s += (c.mentionsManut ? 3 : 0) + (c.mentionsObra ? 1 : 0);
    if (/subesta[cç][aã]o|kva|disjuntor|transformador/i.test(objetoHint)) s += /subest|kva|transformador|disjuntor/i.test(c.raw) ? 2 : 0;
    if (/climatiza[cç][aã]o|chiller|\btr\b|vrf/i.test(objetoHint)) s += /climatiza|chiller|\bTR\b|VRF/i.test(c.raw) ? 2 : 0;
    if (/inc[êe]ndio|hidrante|sprinkler|sdai|endere[cç]a/i.test(objetoHint)) s += /inc[êe]ndio|hidrante|sprinkler|SDAI|endere[cç]a/i.test(c.raw) ? 2 : 0;

    if (c.hasART) s += 2;
    if (c.hasCREA) s += 1;

    if (/eletric/i.test(c.titulo || '') && /subest|kva|disjuntor|transformador/i.test(objetoHint)) s += 1;

    const yr = Number(pickReasonableYear(c.raw)) || Number(c.ano) || Number(c.fileHints?.fileYear) || 0;
    s += (yr / 1000);

    const prof = (c.nomeCAT?.match(/^([^/]+)/)?.[1] || '').trim();
    return { meta: c, prof, score: s };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  return top ? {
    profissional: top.prof || '—',
    catNum: top.meta.catNum || top.meta.fileHints?.fileCatNum || '—',
    ano: pickReasonableYear(top.meta.raw) || top.meta.ano || top.meta.fileHints?.fileYear || '—',
    orgao: top.meta.orgao || top.meta.fileHints?.fileOrgao || '—',
    escopo: top.meta.escopo || '—',
    arquivo: top.meta.nomeCAT || top.meta.fileName || '—'
  } : null;
}

/** Parâmetros comparáveis (expansível) */
function parseCaps(text = '') {
  const t = String(text || '').toLowerCase();
  const num = (re) => (t.match(re)?.[1] ? Number(t.match(re)[1]) : null);
  return {
    kva: num(/(\d{2,5})\s*kva/),
    kv:  num(/(\d{2,3})\s*kv\b/),
    tr:  num(/(\d{2,5})\s*tr\b/),
    enderecavel: /endere[cç]a[vv]el|endere[çc]ável/.test(t),
  };
}
function compareReqVsCat(reqText = '', catText = '') {
  const rq = parseCaps(reqText);
  const ct = parseCaps(catText);
  const out = [];

  if (rq.kva != null) {
    if (ct.kva == null) out.push(`⚠ exige ≥ ${rq.kva} kVA e a CAT não cita kVA`);
    else if (ct.kva > rq.kva) out.push(`✅ **superior**: ${ct.kva} kVA > exigido ${rq.kva} kVA`);
    else if (ct.kva === rq.kva) out.push(`✅ **igual**: ${ct.kva} kVA`);
    else out.push(`❌ **inferior**: ${ct.kva} kVA < exigido ${rq.kva} kVA`);
  }

  if (rq.kv != null) {
    if (ct.kv == null) out.push(`⚠ exige ≥ ${rq.kv} kV e a CAT não cita kV`);
    else if (ct.kv > rq.kv) out.push(`✅ **superior**: ${ct.kv} kV > exigido ${rq.kv} kV`);
    else if (ct.kv === rq.kv) out.push(`✅ **igual**: ${ct.kv} kV`);
    else out.push(`❌ **inferior**: ${ct.kv} kV < exigido ${rq.kv} kV`);
  }

  if (rq.tr != null) {
    if (ct.tr == null) out.push(`⚠ exige ≥ ${rq.tr} TR e a CAT não cita TR`);
    else if (ct.tr > rq.tr) out.push(`✅ **superior**: ${ct.tr} TR > exigido ${rq.tr} TR`);
    else if (ct.tr === rq.tr) out.push(`✅ **igual**: ${ct.tr} TR`);
    else out.push(`❌ **inferior**: ${ct.tr} TR < exigido ${rq.tr} TR`);
  }

  if (rq.enderecavel) {
    const catLower = String(catText || '').toLowerCase();
    if (/endere[cç]a[vv]el|endere[çc]ável/.test(catLower))
      out.push(`✅ **igual**: sistema de alarme **endereçável** citado`);
    else if (/convencional/.test(catLower))
      out.push(`❌ **inferior**: CAT cita sistema **convencional**, edital exige **endereçável**`);
    else
      out.push(`⚠ exige **endereçável**, CAT não deixa explícito`);
  }

  return out;
}

module.exports = {
  findCATMatches,
  pickReasonableYear,
  uniqueByCat,
  scoreCatToObjetoLote,
  suggestBestRT,
  compareReqVsCat,
  signaturesFor,
  DOMAIN_LEXICON,
  hasDomainOverlap
};
