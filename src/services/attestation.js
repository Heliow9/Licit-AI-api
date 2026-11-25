// src/services/attestation.js
const { normalizeSpaces } = require('../utils/text');

function toISO(d) {
  // aceita "dd/mm/aaaa" | "dd-mm-aaaa" | "aaaa-mm-dd"
  if (!d) return null;
  const s = String(d).trim();
  const m1 = /^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/.exec(s);
  if (m1) {
    const [ , dd, mm, yyyy ] = m1;
    const iso = `${yyyy}-${mm}-${dd}`;
    return iso;
  }
  const m2 = /^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/.exec(s);
  if (m2) {
    const [ , yyyy, mm, dd ] = m2;
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function onlyDigits(s){ return String(s||'').replace(/\D+/g, ''); }
function uniq(a){ return Array.from(new Set(a.filter(Boolean))); }
function parseNumberPt(s) {
  if (!s) return null;
  // "31.320", "1.436.702,39", "2.000", "85"
  const raw = String(s).trim();
  const normalized = raw
    .replace(/\./g, '')  // milhares
    .replace(/,(\d{1,2})$/, '.$1'); // decimal
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Detecta domínio temático do documento */
function detectDomain(fullText = '') {
  const t = normalizeSpaces(fullText).toLowerCase();

  if (/\bilumina[cç][aã]o p[uú]blica|\blumin[aá]ria\b|\bled\b|\bvapor de s[oó]dio|\bpontos de luz\b/.test(t)) {
    return 'iluminacao_publica';
  }
  if (/\bsubesta[cç][aã]o\b|\btransformador(?:es)?\b|\bkva\b|\bkv\b|\bbarramento\b/.test(t)) {
    return 'subestacao';
  }
  if (/\blinha(s)? de transmiss[aã]o\b|\bLT\b\s*\d+|\btorre(s)?\b/.test(t)) {
    return 'linhas_transmissao';
  }
  if (/\besgoto\b|\badu?tora\b|\bETA\b|\bETE\b|\bacomodora[cç][aã]o de rede\b|\bsaneamento\b|\bCompesa\b/i.test(t)) {
    return 'saneamento';
  }
  if (/\bconstru[cç][aã]o\b|\bobras civis?\b|\bedifica[cç][aã]o\b|\blaudo estrutural\b|\bconcreto\b|\bm[uú]ro\b|\bm[eé]dia[s]? m²\b/.test(t)) {
    return 'construcao_civil';
  }
  return 'geral';
}

/** Extrai candidatos a "blocos de atestado" a partir do texto bruto */
function splitAtestadoBlocks(fullText = '') {
  const t = normalizeSpaces(fullText);
  const rx = /(ATESTADO(?: DE CAPACIDADE T[EÉ]CNICA)?[\s\S]{100,}?)(?=(?:\n[A-Z].{0,60}\n)|$)/gi;
  const out = [];
  let m;
  while ((m = rx.exec(t))) {
    out.push(m[1].trim());
  }
  // fallback: se vazio, tenta o bloco entre "ATESTADO" e "ART"/"CERTID(Ã|A)O"
  if (!out.length) {
    const rx2 = /ATESTADO[\s\S]+?(?=(?:\bART\b|\bCERTID[ÃA]O\b|$))/gi;
    let m2; while ((m2 = rx2.exec(t))) out.push(m2[0].trim());
  }
  return out;
}

/** Extrai campos estruturados de um bloco de atestado */
function extractAtestadoFields(block = '') {
  const b = block;

  const orgaoContratante =
    /(?:Contratante|[ÓO]rg[aã]o(?:\s+Contratante)?|Secretaria|Prefeitura|Compesa|COMPESA)\s*[:\-]\s*([^\n]+)/i.exec(b)?.[1]
    || /PREFEITURA\s+MUNICIPAL\s+DE\s+[A-ZÃÂÁÉÍÓÚÇ\s]+/i.exec(b)?.[0]
    || /COMPESA/i.exec(b)?.[0]
    || null;

  const contratada =
    /(?:Contratada|Empresa|Execut(?:or|ora))\s*[:\-]\s*([^\n]+)/i.exec(b)?.[1]
    || /Empresa\s+([A-Z0-9\.\-\s]+LTD[AE]|S\.A\.)/i.exec(b)?.[1]
    || null;

  const contratoNumero =
    /(?:Contrato|Ajuste|Conv[eê]nio)\s*(?:n[ºo\.]*)?\s*[:\-]?\s*([A-Z0-9\-\/\.]{3,})/i.exec(b)?.[1]
    || null;

  // Vigência / Período
  const vigA = /vig[eê]ncia\s*[:\-]?\s*([\d\/\-]{8,10})\s*(?:a|até|-|–|—)\s*([\d\/\-]{8,10})/i.exec(b);
  const vigB = /de\s+([\d\/\-]{8,10})\s*(?:a|até|-|–|—)\s*([\d\/\-]{8,10})/i.exec(b);
  const inicioISO = toISO(vigA?.[1] || vigB?.[1]) || null;
  const fimISO    = toISO(vigA?.[2] || vigB?.[2]) || null;

  // Local / Município
  const local =
    /(?:Local|Munic[ií]pio|Cidade)\s*[:\-]\s*([^\n]+)/i.exec(b)?.[1]
    || /(?:Natal|Recife|Olinda|Jaboat[aã]o|Caruaru|Petrolina|Macei[oó]|Jo[aã]o Pessoa|Salvador)/i.exec(b)?.[0]
    || null;

  // Objeto/escopo
  const objeto =
    /(?:Objeto|Finalidade|Servi[cç]os?)\s*[:\-]\s*([^\n]{10,300})/i.exec(b)?.[1]
    || (() => {
         const m = /(execu[cç][aã]o[^\.]{30,400})/i.exec(b);
         return m ? m[1] : null;
       })();

  // Quantitativos e materiais por domínio
  const pontosDeLuz = parseNumberPt(/(?:cerca de\s*)?([\d\.\,]{2,})\s+pontos?\s+de\s+luz/i.exec(b)?.[1]);
  const luminarias  = parseNumberPt(/([\d\.\,]{2,})\s+lumin[aá]rias?/i.exec(b)?.[1]);
  const potenciasW  = uniq([...(b.match(/(\d{2,4})\s*W\b/gi)||[])].map(s => parseInt(onlyDigits(s),10)).filter(x => Number.isFinite(x)));

  // civis: m², m³, km, estacas, concreto
  const areaM2   = parseNumberPt(/([\d\.\,]{2,})\s*m²\b/i.exec(b)?.[1]);
  const volumeM3 = parseNumberPt(/([\d\.\,]{2,})\s*m³\b/i.exec(b)?.[1]);
  const extensaoKm = parseNumberPt(/([\d\.\,]{1,})\s*km\b/i.exec(b)?.[1]);
  const adutoraMm  = parseNumberPt(/adu?tora[^0-9]*([\d\.\,]{2,})\s*mm\b/i.exec(b)?.[1]);

  const materiais = uniq([
    ...(b.match(/\blumin[aá]ria[s]?\s*led\b/gi)||[]).map(s=>s.toLowerCase()),
    ...(b.match(/\bl[aâ]mpadas?\s+de\s+vapor\s+de\s+s[oó]dio/i)||[]),
    ...(b.match(/\bconcreto\b/gi)||[]).map(s=>s.toLowerCase()),
    ...(b.match(/\btubula[cç][aã]o\b/gi)||[]).map(s=>s.toLowerCase()),
  ]);

  // Assinantes / cargo (quando houver)
  const assinante = /(?:Assina(?:tura)?|Respons[aá]vel|Fiscal)\s*[:\-]\s*([^\n]+)/i.exec(b)?.[1] || null;

  // Data do atestado (quando explícita)
  const dataAtestadoISO =
    toISO(/(?:Natal|Recife|Olinda|Jaboat[aã]o|Caruaru|Petrolina)[^0-9]*([\d\/\-]{8,10})/i.exec(b)?.[1]) ||
    toISO(/(?:Em\s+)?([\d\/\-]{8,10})\s*(?:\.|\,|$)/i.exec(b)?.[1]) ||
    null;

  // CNPJ/CPF (opcional)
  const cnpjContratada = /(?:CNPJ|CNPJ\/MF)\s*(?:n[ºo\.]*)?\s*[:\-]?\s*([0-9\.\-\/]{11,18})/i.exec(b)?.[1] || null;

  return {
    origem: (orgaoContratante || '').trim() || null,
    numero: contratoNumero || null,
    periodo: { inicioISO, fimISO, dataAtestadoISO },
    objeto: objeto ? objeto.trim() : null,
    local: local ? local.trim() : null,
    contratada: contratada ? contratada.trim() : null,
    orgaoContratante: orgaoContratante ? orgaoContratante.trim() : null,
    quantitativos: {
      pontosDeLuz: pontosDeLuz || null,
      luminarias: luminarias || null,
      potenciasW: potenciasW.length ? potenciasW.sort((a,b)=>a-b) : [],
      areaM2: areaM2 || null,
      volumeM3: volumeM3 || null,
      extensaoKm: extensaoKm || null,
      adutoraMm: adutoraMm || null,
    },
    materiais,
    assinante,
    cnpjContratada: cnpjContratada ? cnpjContratada.replace(/[^\d]/g,'') : null,
  };
}

/** Consolida e limpa atestados a partir do texto completo */
function extractAtestadosLimpos(fullText = '') {
  const blocks = splitAtestadoBlocks(fullText);
  if (!blocks.length) return [];
  const parsed = blocks.map(extractAtestadoFields);

  // dedup por (orgaoContratante + contratada + contrato + periodo)
  const key = (a) => [
    (a.orgaoContratante||'').toLowerCase(),
    (a.contratada||'').toLowerCase(),
    (a.numero||'').toLowerCase(),
    (a.periodo?.inicioISO||''),
    (a.periodo?.fimISO||''),
  ].join('|');

  const map = new Map();
  for (const a of parsed) {
    const k = key(a);
    const prev = map.get(k);
    if (!prev) { map.set(k, a); continue; }
    // merge simples: mantenha arrays mais longos e qualquer campo inexistente
    prev.materiais = uniq([...(prev.materiais||[]), ...(a.materiais||[])]);
    const pw = uniq([...(prev.quantitativos?.potenciasW||[]), ...(a.quantitativos?.potenciasW||[])]);
    prev.quantitativos.potenciasW = pw.sort((x,y)=>x-y);
    for (const f of ['pontosDeLuz','luminarias','areaM2','volumeM3','extensaoKm','adutoraMm']) {
      if (!prev.quantitativos[f] && a.quantitativos[f]) prev.quantitativos[f] = a.quantitativos[f];
    }
  }
  return Array.from(map.values());
}

/** Gera palavras-chave para consultas */
function buildKeywords({ docType, meta = {}, domain, atestadosLimpos = [], linkKeys = {}, fileName }) {
  const set = new Set();

  // básicos
  if (docType) set.add(docType.toLowerCase());
  if (domain) set.add(domain.toLowerCase());
  if (fileName) set.add(fileName.toLowerCase());

  // CAT
  const numeroCat = meta?.cat?.numeroCat || linkKeys?.numeroCat;
  if (numeroCat) {
    set.add(numeroCat);
    set.add(numeroCat.replace(/[^\d]/g,'')); // versão só números
  }
  if (meta?.cat?.profissional) set.add(meta.cat.profissional.toLowerCase());
  if (meta?.cat?.registro) set.add(meta.cat.registro.toLowerCase());
  if (meta?.cat?.creaUF) set.add(`crea-${meta.cat.creaUF.toLowerCase()}`);

  // Atestado consolidado
  for (const a of atestadosLimpos) {
    const f = (s) => (s||'').toString().toLowerCase();
    if (a.orgaoContratante) set.add(f(a.orgaoContratante));
    if (a.contratada) set.add(f(a.contratada));
    if (a.local) set.add(f(a.local));
    if (a.numero) set.add(f(a.numero));
    if (a.objeto) {
      // palavras do objeto (curtas relevantes)
      f(a.objeto).split(/\W+/).forEach(w => { if (w && w.length >= 3) set.add(w); });
    }
    // quantitativos e potências
    const q = a.quantitativos || {};
    if (q.pontosDeLuz) set.add(`${q.pontosDeLuz} pontos`);
    if (q.luminarias) set.add(`${q.luminarias} luminarias`);
    (q.potenciasW||[]).forEach(w => set.add(`${w}w`));
    if (q.areaM2) set.add(`${q.areaM2}m2`);
    if (q.volumeM3) set.add(`${q.volumeM3}m3`);
    if (q.extensaoKm) set.add(`${q.extensaoKm}km`);
    if (q.adutoraMm) set.add(`${q.adutoraMm}mm`);

    // materiais
    (a.materiais||[]).forEach(m => set.add(m.toLowerCase()));
  }

  // termos por domínio (ajuda em filtros rápidos)
  const domainHints = {
    iluminacao_publica: ['iluminacao','luminaria','led','pontos de luz'],
    construcao_civil: ['construcao','obra','edificacao','concreto','armadura','alvenaria'],
    saneamento: ['saneamento','esgoto','agua','adutora','ete','eta','rede coletora'],
    subestacao: ['subestacao','transformador','kva','kv','barramento'],
    linhas_transmissao: ['linha de transmissao','lt','torre','cabo para-raios'],
  };
  (domainHints[domain] || []).forEach(k => set.add(k));

  return Array.from(set);
}

module.exports = {
  detectDomain,
  extractAtestadosLimpos,
  buildKeywords,
};
