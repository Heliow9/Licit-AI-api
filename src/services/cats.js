/**
 * src/services/cats.js — versão completa e segura
 *
 * • Compatível com analisarEditalCore (assinatura de findCATMatches)
 * • Busca híbrida: coleções Mongo (cats/chunks) + arquivos locais (PDF OCR)
 * • Scoring híbrido (léxico + metadados leves; sem vetor obrigatório)
 * • Domínios ampliados (elétrica, civil, incêndio, clima, água, saúde_social)
 * • Extração de ano “razoável”, dedupe por CAT, RT sugerido, comparação simples
 *
 * Observação: parte vetorial fica opcional; se './azure' não existir, ignora.
 */

const { ObjectId } = require('mongodb');
const crypto = require('crypto');

let embedText = null;
try {
  // opcional – só se você tiver esse módulo no projeto
  ({ embedText } = require('./azure'));
} catch { /* sem embeddings, seguimos no modo léxico */ }

/* ============================== Léxico base ============================== */
const DOMAIN_LEXICON = {
  eletrica: [
    'subesta', 'kva', '\\bkv\\b', 'transformador', 'disjuntor', 'qgbt',
    'cabine primária', 'baixa tensão', 'média tensão', 'proteção elétrica',
    'religadores?', 'seccionadoras?', 'barramentos?', '\\bLT\\b', '\\bLD\\b',
    'ilumina[çc][aã]o\\s+p[úu]blica', 'lumin[áa]ri[ao]s?', '\\bled\\b',
    'fotoc[eé]lula', 'rel[eé]\\s*fot[oô]el[eé]trico',
    'poste(s)?\\s+de\\s+ilumina', 'bra[çc]o\\s+de\\s+luz',
    'parque\\s+de\\s+ilumina', 'pontos?\\s+de\\s+luz',
    'ilumina[çc][aã]o\\s+vi[áa]ria', 'driver\\s+de\\s+lumin[áa]ria',
    '\\brel[eé]\\b', '\\bip\\b(?![a-z0-9])'
  ],
  civil: [
    'edifica', 'paviment', 'obra civil', 'concreto', 'alvenaria', 'fund[aá]cao',
    'creche', 'escola', 'pr[eé]dio', 'manuten[çc][aã]o predial', 'reforma'
  ],
  incendio: [
    'inc[êe]ndio', 'sdai', 'sprinkler', 'hidrante', 'bomba de incêndio',
    'endere[cç]a', 'alarme', 'detec[çc][aã]o'
  ],
  clima: [
    'climatiza', 'ar condicionado', 'chiller', 'fan ?coil', 'vrf', '\\btr\\b', 'split', 'self contained'
  ],
  agua: [
    'micromedi', 'hidr[oó]metro', 'adu[cç][aã]o', '\\beta\\b', '\\bete\\b', '\\betap\\b',
    'po[çc]o', 'submers[ií]vel', 'per[íi]metros de irriga', 'bomba d[\' ]?água'
  ],
  saude_social: [
    'sa[úu]de', 'sistema\\s+[úu]nico\\s+de\\s+sa[úu]de|\\bSUS\\b',
    'assist[êe]ncia\\s+social', '\\bSUAS\\b', '\\bCRAS\\b', '\\bCREAS\\b',
    'unidade\\s+b[áa]sica\\s+de\\s+sa[úu]de|\\bUBS\\b', '\\bUPA\\b', 'posto\\s+de\\s+sa[úu]de',
    'hospital', 'cl[ií]nica', 'ambulat[óo]rio',
    'idos[oa]s?', 'geriatr', 'geronto', 'casa\\s+lar',
    'institui[çc][aã]o\\s+de\\s+longa\\s+perman[êe]ncia|\\bILPI\\b',
    'cuidad(?:or|ora)(?:es)?\\s+de\\s+idos[oa]s?',
    'cuidado\\s+domiciliar', 'home\\s*care',
    'enferm(?:eir[oa]s?)?', 't[ée]cnico\\s+de\\s+enfermagem',
    'curativos?', 'medica[çc][aã]o'
  ],
};

const EXTRA_DOMAIN_SYNONYMS = {
  eletrica: [
    '\\bLT\\b', '\\bLD\\b', 'linha viva', 'linha morta', '\\b69\\s*kV\\b', '\\b138\\s*kV\\b', '\\b230\\s*kV\\b',
    'subesta[cç][aã]o', '\\bSE\\b', 'alimentador', 'barramento', 'disjuntor', 'religador', 'transformador',
    'ilumina[çc][aã]o\\s+p[úu]blica', 'lumin[áa]ria', '\\bled\\b',
    'poste\\s+de\\s+ilumina', 'bra[çc]o\\s+de\\s+luz',
    'fotoc[eé]lula', 'rel[eé]\\s*fot[oô]el[eé]rico',
    'parque\\s+de\\s+ilumina', 'pontos?\\s+de\\s+luz', '\\bip\\b(?![a-z0-9])'
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
  ],
  saude_social: [
    '\\bUBS\\b', '\\bUPA\\b', '\\bSUS\\b', '\\bCRAS\\b', '\\bCREAS\\b', '\\bILPI\\b',
    'home\\s*care', 'cuidador(?:a)?\\s+de\\s+idos', 'geriatr', 'geronto',
    'enfermagem', 'hospital', 'cl[íi]nica', 'ambulatório'
  ]
};

/* ============================== Helpers ============================== */
function pathSafeFileName(src = '') {
  const p = String(src);
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function toOid(v) { try { return new ObjectId(String(v)); } catch { return null; } }
function buildTenantFilter(tenantId) {
  if (!tenantId) return null;
  const oid = toOid(tenantId);
  return { $or: [{ companyId: String(tenantId) }, ...(oid ? [{ companyId: oid }] : [])] };
}

function norm(s = '') {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function signaturesFor(text = '') {
  const base = norm(text).slice(0, 200);
  const h1 = crypto.createHash('sha1').update(base).digest('hex');
  const h2 = crypto.createHash('md5').update(base).digest('hex');
  return { short: h1.slice(0, 8), long: `${h1.slice(0, 12)}-${h2.slice(0, 12)}` };
}

function signaturesForDomains(text = '') {
  const s = String(text || '').toLowerCase();
  const hits = new Set();
  for (const [dom, terms] of Object.entries(DOMAIN_LEXICON)) {
    if (terms.some(rx => new RegExp(rx, 'i').test(s))) hits.add(dom);
  }
  return Array.from(hits);
}

function baseTermSet(seed = '') {
  const doms = signaturesForDomains(seed);
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

function parseFilenameMeta(fileName = '') {
  const fn = String(fileName || '');
  const lower = fn.toLowerCase();

  const catNum = (lower.match(/cat\s*(?:n[ºo]\s*)?[-:\s]*([0-9]{2,}\/?[0-9]{0,4})/) || [])[1] || '';
  const ano    = (fn.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';

  let orgao = '';
  const orgMatches = fn.match(/\b(CELPE|CHESF|PM\s+DE\s+[A-ZÇÃÕ ]+|PREFEITURA\s+DE\s+[A-ZÇÃÕ ]+|CREA-?[A-Z]{2})\b/i);
  if (orgMatches) orgao = orgMatches[0];

  const hits = new Set(signaturesForDomains(fn));
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

function hasDomainOverlap(objText = '', catText = '', fileName = '') {
  const objSigs = new Set(signaturesForDomains(objText));
  const catSigs = new Set([
    ...signaturesForDomains(catText || ''),
    ...signaturesForDomains(fileName || '')
  ]);
  if (!objSigs.size) return true;
  for (const d of objSigs) if (catSigs.has(d)) return true;
  return false;
}

function tokenOverlapScore(a = '', b = '') {
  const stop = new Set(['de','da','do','das','dos','e','em','para','por','com','um','uma','o','a','os','as','no','na','nos','nas','que','ou','se','ao','à','às']);
  const normTok = s => String(s||'').toLowerCase().replace(/[^a-zà-ú0-9\s]/gi,' ').split(/\s+/)
    .filter(w => w && w.length >= 4 && !stop.has(w));
  const A = new Set(normTok(a)); const B = new Set(normTok(b));
  let hit = 0; for (const w of A) if (B.has(w)) hit++; return hit;
}

function pickReasonableYear(text = '') {
  const now = new Date().getFullYear();
  const years = (String(text || '').match(/\b(19\d{2}|20\d{2})\b/g) || [])
    .map(Number).filter(y => y >= 1990 && y <= (now + 1));
  return years.length ? String(Math.max(...years)) : '';
}

function uniqueByCat(metaList = []) {
  const seen = new Set();
  return (metaList || []).filter(m => {
    const key = `${m.nomeCAT}|${m.catNum || ''}|${m.fileName || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ====== Score e RT ====== */
function scoreCatToObjetoLote(cat = {}, objeto = '', lote = '') {
  const catTxt = (cat.raw || '').toLowerCase();

  const objSigs  = new Set(signaturesForDomains(objeto));
  const loteSigs = new Set(signaturesForDomains(lote));
  const catSigs  = new Set(signaturesForDomains(catTxt));
  for (const d of (cat.fileHints?.fileDomains || [])) catSigs.add(d);

  let sc = 0;

  for (const dom of objSigs) if (catSigs.has(dom)) sc += 8;
  for (const dom of loteSigs) if (catSigs.has(dom)) sc += 4;

  if (objSigs.size) {
    for (const dom of Object.keys(DOMAIN_LEXICON)) {
      if (!objSigs.has(dom) && catSigs.has(dom)) sc -= 7;
    }
  }

  if (cat.hasART) sc += 2;
  if (cat.hasCREA) sc += 1;
  if (cat.mentionsManut) sc += 1;
  if (cat.mentionsObra) sc += 1;

  const yr = Number(pickReasonableYear(cat.raw)) || Number(cat.fileHints?.fileYear) || 0;
  if (yr) sc += (yr - 2015) / 10;

  if (/eletric/i.test(cat.titulo || '') && objSigs.has('eletrica')) sc += 1;

  if (objSigs.size === 0) {
    const ov = tokenOverlapScore(objeto, catTxt);
    sc += Math.min(ov, 4);
    if (ov === 0) sc -= 5;
  }

  return sc;
}

function suggestBestRT(catMatches = [], objetoHint = '') {
  if (!catMatches?.length) return null;

  const pool = catMatches.filter(c => hasDomainOverlap(objetoHint, c.raw || '', c.fileName || ''));
  if (!pool.length) return null;

  const sObj = signaturesForDomains(objetoHint).join('|');
  const scored = [...pool].map(c => {
    let s = 0;
    const catDom = new Set([
      ...signaturesForDomains(c.raw || ''),
      ...(c.fileHints?.fileDomains || [])
    ]);
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

/* ============================ Busca Híbrida ============================ */
/**
 * findCATMatches({ catsCol, chunksCol }, objetoText, limit, localFiles, { tenantId|companyId, debug })
 * Compatível com o seu controller. Se coleções não estiverem disponíveis,
 * cai para busca apenas nos arquivos locais (OCR).
 */
async function findCATMatches(collectionOrChunks, objetoText, limit = 6, localFiles = [], opts = {}) {
  const termSet = baseTermSet(objetoText || '');
  const debug = typeof opts.debug === 'function' ? opts.debug : () => {};
  const tenantFilter = buildTenantFilter(opts.tenantId || opts.companyId);

  const catsCol   = collectionOrChunks?.catsCol || null;
  const chunksCol = collectionOrChunks?.chunksCol || (collectionOrChunks && !collectionOrChunks.catsCol ? collectionOrChunks : null);

  const objDomains = signaturesForDomains(objetoText || '');
  const domainTerms = objDomains.flatMap(d => DOMAIN_LEXICON[d] || []);

  const candidates = [];

  /* ===== A) SEMÂNTICA (opcional) ===== */
  try {
    if (embedText) {
      // você pode ligar com $vectorSearch aqui se seu cluster tiver índice
      // (mantemos placeholder; se não houver, ignoramos a parte vetorial)
      debug({ kind: 'vecInfo', message: 'embeddings habilitados' });
    }
  } catch (e) {
    debug({ kind: 'vecError', message: e?.message });
  }

  /* ===== B) LÉXICO/REGEX nas coleções ===== */
  async function pushLexiconFromCol(col, isCatsCol) {
    const orTerms = Array.from(termSet).map(t => (isCatsCol
      ? { fullText: { $regex: t, $options: 'i' } }
      : { text: { $regex: t, $options: 'i' } }));

    const mustBeCAT = isCatsCol
      ? [{ fileName: { $regex: 'cat|certid[aã]o.*acervo|acervo.*t[ée]cnico', $options: 'i' } },
         { fullText: { $regex: 'Certid[aã]o de Acervo T[ée]cnico|\\bCAT\\b', $options: 'i' } }]
      : [{ text: { $regex: 'Certid[aã]o de Acervo T[ée]cnico', $options: 'i' } },
         { text: { $regex: '\\bCAT\\b', $options: 'i' } }];

    const ands = [{ $or: mustBeCAT }, { $or: orTerms }];
    if (tenantFilter) ands.push(tenantFilter);
    if (domainTerms.length) {
      ands.push({ $or: isCatsCol
        ? [{ fileName: { $regex: domainTerms.join('|'), $options: 'i' } },
           { fullText: { $regex: domainTerms.join('|'), $options: 'i' } }]
        : [{ source: { $regex: domainTerms.join('|'), $options: 'i' } },
           { text: { $regex: domainTerms.join('|'), $options: 'i' } }] });
    }

    const q = { $and: ands };
    const proj = isCatsCol ? { _id: 0, source: 1, fileName: 1, fullText: 1 }
                           : { _id: 0, source: 1, text: 1 };
    const docs = await col.find(q, { projection: proj }).limit(limit * 5).toArray();
    debug({ kind: isCatsCol ? 'lexCats' : 'lexChunks', total: docs.length });
    for (const d of docs) {
      candidates.push({
        kind: isCatsCol ? 'cat' : 'chunk',
        source: d.source || d.fileName,
        fileName: isCatsCol ? d.fileName : pathSafeFileName(d.source),
        text: isCatsCol ? d.fullText : d.text,
        vecScore: null,
      });
    }
  }
  if (catsCol) await pushLexiconFromCol(catsCol, true);
  if (chunksCol) await pushLexiconFromCol(chunksCol, false);

  /* ===== C) ARQUIVOS LOCAIS ===== */
  const looksLikeCATName = (name = '') => /cat|certid[aã]o.*acervo|acervo.*t[ée]cnico/i.test(name) && !/edital/i.test(name);
  const strongCATFingerprint = (txt = '') => /Certid[aã]o de Acervo T[ée]cnico/i.test(txt) && /CAT\s*[NºNo\.:\- ]+\s*\d{3,}/i.test(txt);

  for (const f of (localFiles || [])) {
    if (!f?.text) continue;
    if (!(looksLikeCATName(f.source) || strongCATFingerprint(f.text))) continue;
    if (Array.from(termSet).some(t => new RegExp(String(t), 'i').test(f.text))) {
      candidates.push({ kind: 'local', source: f.source, fileName: f.source, text: f.text, vecScore: null });
    }
  }

  /* ===== D) SCORE LEX + metadados ===== */
  const scored = (candidates || []).map(c => {
    // Você deve ter ../utils/cat_meta com extractCATMeta, senão crie um stub simples
    let metaFromText = {};
    try {
      const { extractCATMeta } = require('../utils/cat_meta');
      metaFromText = extractCATMeta(c.source, c.text || '') || {};
    } catch {
      metaFromText = {
        raw: c.text || '',
        nomeCAT: pathSafeFileName(c.source),
        catNum: (String(c.text||'').match(/cat\s*(?:n[ºo]\s*)?[-:\s]*([0-9]{2,}\/?[0-9]{0,4})/i)||[])[1] || '',
        hasART: /(?:^|\W)art(?:\W|$)/i.test(c.text||''),
        hasCREA: /(?:^|\W)crea|cau(?:\W|$)/i.test(c.text||''),
        mentionsManut: /manuten[çc][aã]o/i.test(c.text||''),
        mentionsObra: /\bobra\b|\bedifica/i.test(c.text||''),
        escopo: (String(c.text||'').slice(0, 400) || '').replace(/\s+/g,' ')
      };
    }

    const fromName = parseFilenameMeta(c.fileName || c.source || '');
    const mergedHints = { ...(metaFromText.fileHints || {}), ...fromName };
    const meta = { ...metaFromText, fileName: c.fileName, raw: metaFromText.raw, fileHints: mergedHints };

    let lex = 0;
    for (const t of baseTermSet(objetoText)) if (new RegExp(t, 'i').test(meta.raw)) lex += 1;
    if (meta.hasART) lex += 2;
    if (meta.hasCREA) lex += 1;
    if (meta.mentionsManut) lex += 1;
    if (meta.mentionsObra) lex += 1;
    if (/\batividade conclu[ií]da|obra conclu[ií]da|conclu[ií]d[ao]\b/i.test(meta.raw)) lex += 1;

    const objSigs = new Set(signaturesForDomains(objetoText));
    const fileSigs = new Set(fromName.fileDomains || []);
    for (const d of objSigs) if (fileSigs.has(d)) lex += 3;
    const yr = Number(fromName.fileYear) || Number(pickReasonableYear(meta.raw)) || 0;
    if (yr) lex += (yr - 2010) / 12;

    if (objSigs.size === 0) {
      const ov = tokenOverlapScore(objetoText, meta.raw);
      lex += Math.min(ov, 4);
      if (ov === 0) lex -= 5;
    }

    const finalScore = Math.max(0, Math.min(1, lex / 15));
    return { meta, score: finalScore, rawLex: lex };
  })
  .filter((v, i, a) =>
    a.findIndex(t =>
      (t.meta.nomeCAT === v.meta.nomeCAT && t.meta.catNum === v.meta.catNum) ||
      (t.meta.fileName && v.meta.fileName && t.meta.fileName === v.meta.fileName)
    ) === i
  )
  .filter(s => hasDomainOverlap(objetoText, s.meta.raw, s.meta.fileName))
  .sort((a, b) => b.score - a.score)
  .slice(0, limit * 3);

  debug({ kind: 'scoredHybrid', count: scored.length });
  return scored.map(s => s.meta);
}

/* ================================ Exports =============================== */
module.exports = {
  // busca principal
  findCATMatches,

  // utilitários
  pickReasonableYear,
  uniqueByCat,
  scoreCatToObjetoLote,
  suggestBestRT,
  // comparação simples por palavras
  compareReqVsCat(requisitoText = '', catText = '') {
    const rq = String(requisitoText || '').toLowerCase();
    const ct = String(catText || '').toLowerCase();
    const out = [];
    // kVA
    const rkva = rq.match(/([0-9]{2,5})\s*kva/); const ckva = ct.match(/([0-9]{2,5})\s*kva/);
    if (rkva) {
      const need = Number(rkva[1]); const have = ckva ? Number(ckva[1]) : null;
      if (have == null) out.push(`⚠ exige ≥ ${need} kVA e a CAT não cita kVA`);
      else if (have > need) out.push(`✅ **superior**: ${have} kVA > exigido ${need} kVA`);
      else if (have === need) out.push(`✅ **igual**: ${have} kVA`);
      else out.push(`❌ **inferior**: ${have} kVA < exigido ${need} kVA`);
    }
    // kV
    const rkv = rq.match(/([0-9]{2,3})\s*kv\b/); const ckv = ct.match(/([0-9]{2,3})\s*kv\b/);
    if (rkv) {
      const need = Number(rkv[1]); const have = ckv ? Number(ckv[1]) : null;
      if (have == null) out.push(`⚠ exige ≥ ${need} kV e a CAT não cita kV`);
      else if (have > need) out.push(`✅ **superior**: ${have} kV > exigido ${need} kV`);
      else if (have === need) out.push(`✅ **igual**: ${have} kV`);
      else out.push(`❌ **inferior**: ${have} kV < exigido ${need} kV`);
    }
    // TR
    const rtr = rq.match(/([0-9]{2,5})\s*tr\b/); const ctr = ct.match(/([0-9]{2,5})\s*tr\b/);
    if (rtr) {
      const need = Number(rtr[1]); const have = ctr ? Number(ctr[1]) : null;
      if (have == null) out.push(`⚠ exige ≥ ${need} TR e a CAT não cita TR`);
      else if (have > need) out.push(`✅ **superior**: ${have} TR > exigido ${need} TR`);
      else if (have === need) out.push(`✅ **igual**: ${have} TR`);
      else out.push(`❌ **inferior**: ${have} TR < exigido ${need} TR`);
    }
    // endereçável
    if (/endere[cç]a[vv]el|endere[çc]ável/.test(rq)) {
      if (/endere[cç]a[vv]el|endere[çc]ável/.test(ct)) out.push('✅ **igual**: sistema de alarme **endereçável** citado');
      else if (/convencional/.test(ct)) out.push('❌ **inferior**: CAT cita sistema **convencional**, edital exige **endereçável**');
      else out.push('⚠ exige **endereçável**, CAT não deixa explícito');
    }
    return out;
  },
  signaturesFor,
  DOMAIN_LEXICON,
  hasDomainOverlap,
};
