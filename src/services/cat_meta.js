function normalizeSpaces(s) {
  return String(s || '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')     // NBSP e amigos
    .replace(/\s+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

function toAsciiLower(s = '') {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// evita confundir nº de CAT com CNPJ/CPF/CEP
function isLikelyDocNumber(str = '') {
  const s = str.replace(/[^\d]/g, '');
  return s.length === 11 || s.length === 14 || s.length === 8;
}

function extractFromFilename(sourceName = '') {
  const name = String(sourceName || '');

  // CAT com variações e espaços
  let catNum =
    name.match(/\bcat\s*(?:n[ºo°\.]|num(?:ero)?|n)?\s*[:.\- ]*\s*([0-9][0-9.\-\/ ]{3,})\b/i)?.[1] ||
    name.match(/\b(\d{3,6}\s*[\/.\-]\s*\d{2,4})\b/)?.[1] ||
    '';

  catNum = catNum ? normalizeSpaces(catNum).replace(/\s+/g, '') : '';

  if (catNum && isLikelyDocNumber(catNum)) catNum = ''; // descarta se parecer CNPJ/CPF

  const fileYear = name.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || '';

  const orgaoAcr =
    name.match(/\b(?:PM-?[A-Z]{2,}|SEINFRA|SINFRA|DER|DNIT|DEINFRA|SEDUC|SESA|COMPESA|CAGEPA|SABESP|SANEPAR|CHESF|CELPE|CEMIG|COPEL|LIGHT|UF[A-Z]{1,3}|UFR[A-Z]*|IF[A-Z]{2,})\b/i)?.[0] || '';

  return {
    fileCatNum: catNum,
    fileYear,
    fileOrgao: orgaoAcr
  };
}

function pickYearFromContext(t) {
  // 1) datas dd/mm/aaaa
  const dateYears = (t.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-](19\d{2}|20\d{2})\b/g) || [])
    .map(m => Number(m.match(/(19\d{2}|20\d{2})/)[1]));
  if (dateYears.length) return String(Math.max(...dateYears));

  // 2) "de 2023", "em 2022"
  const ctxYears = (t.match(/\b(?:de|em)\s+(19\d{2}|20\d{2})\b/gi) || [])
    .map(m => Number(m.match(/(19\d{2}|20\d{2})/)[1]));
  if (ctxYears.length) return String(Math.max(...ctxYears));

  // 3) qualquer ano razoável
  const anyYears = (t.match(/\b(19\d{2}|20\d{2})\b/g) || [])
    .map(Number)
    .filter(y => y >= 1990 && y <= 2099);
  if (anyYears.length) return String(Math.max(...anyYears));

  return '';
}

function normalizeOrgao(s = '') {
  let out = normalizeSpaces(s);
  // PM de X → Prefeitura Municipal de X
  out = out.replace(/\bPM de\s+/i, 'Prefeitura Municipal de ');
  out = out.replace(/\bPM-([A-Z]{2,})\b/g, 'Prefeitura Municipal de $1');
  return out;
}

function extractCATMeta(sourceName, text) {
  const raw = String(text || '');
  const t = normalizeSpaces(raw);
  const low = toAsciiLower(t);
  const hints = extractFromFilename(sourceName);

  // CAT número
  let catNum =
    t.match(/\bCAT\s*(?:N[º°o\.]|num(?:ero)?|n)?\s*[:.\- ]*\s*([0-9][0-9.\-\/ ]{3,})\b/i)?.[1] ||
    t.match(/\bCAT\s*[:.\- ]+\s*([0-9][0-9.\-\/ ]{3,})\b/i)?.[1] ||
    hints.fileCatNum || '';

  catNum = normalizeSpaces(catNum).replace(/\s+/g, '');
  if (catNum && isLikelyDocNumber(catNum)) catNum = '';

  // órgão (longo + siglas)
  const orgaoLong =
    t.match(/\b(PREFEITURA MUNICIPAL DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|GOVERNO DO ESTADO DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|SECRETARIA (?:MUNICIPAL|ESTADUAL) DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|UNIVERSIDADE(?: FEDERAL| ESTADUAL)? DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|CÂMARA MUNICIPAL DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+)\b/i)?.[0];

  const orgaoAcr =
    t.match(/\b(PM de [A-ZÁ-Ú][\w\s\-]+|PM-?[A-Z]{2,}|UF[A-Z]{1,3}|UFR[A-Z]*|IF[A-Z]{2,}|CELPE|CHESF|SEINFRA|SINFRA|SEDUC|COMPESA|CAGEPA|SABESP|SANEPAR|DER|DNIT|CEMIG|COPEL|LIGHT)\b/i)?.[0];

  const orgao = normalizeOrgao((orgaoLong || orgaoAcr || hints.fileOrgao || '').trim());

  // ano
  const ano = pickYearFromContext(t) || hints.fileYear || '';

  // ART/CREA/CAU
  const hasART  = /\bART\b|Anota[cç][aã]o de Responsabilidade T[ée]cnica/i.test(t);
  const hasCREA = /\bCREA\b/i.test(t);
  const hasCAU  = /\bCAU\b/i.test(t);

  // escopo
  let escopo = '';
  const mEscopo = t.match(
    /(?:OBJETO|OBJETIVO|DESCRI[ÇC][AÃ]O(?: DA OBRA OU SERVI[ÇC]O)?|ATIVIDADE T[ÉE]CNICA|ESCOPO|SERVI[ÇC]O(?:S)?|FINALIDADE|JUSTIFICATIVA)\s*[:\-]\s*([\s\S]{0,800}?)(?:\n{2,}|(?:\s{2,}|\.)\s|$)/i
  );
  if (mEscopo) escopo = normalizeSpaces(mEscopo[1]);
  if (!escopo) {
    // fallback por palavras-chave
    const kw = low.match(/(?:obra|manutencao|instalacao|fornecimento|servico|execucao)[^.\n]{20,200}/i);
    if (kw) escopo = normalizeSpaces(kw[0]);
  }
  if (!escopo) {
    const snip = t.slice(0, 300).trim();
    escopo = snip ? (snip.length >= 300 ? snip + '…' : snip) : '';
  }

  // profissional (RT)
  let profissional =
    (t.match(/Respons[aá]vel T[ée]cnico\s*[:\-]\s*([^\n]+?)(?:\s+(?:Registro|RNP|CREA|CAU|T[íi]tulo|CPF)\b|$)/i)?.[1] ||
     t.match(/Profissional\s*[:\-]\s*([^\n]+?)(?:\s+(?:Registro|RNP|CREA|CAU|T[íi]tulo|CPF)\b|$)/i)?.[1] ||
     t.match(/\b(Eng(?:\.|enheiro)?\s+[^\n]+|Arq(?:\.|uiteto)?\s+[^\n]+)\b/i)?.[0] ||
     '')
    .trim();

  // título profissional
  const titulo =
    (t.match(/T[íi]tulo profissional\s*[:\-]\s*([^\n]+)/i)?.[1] ||
     t.match(/\b(Engenheiro(?: Civil| Eletricista| Mec[aâ]nico)?|Arquiteto(?: Urbanista)?)\b/i)?.[1] ||
     '')
    .trim();

  // status
  const status =
    /atividade\s+conclu[ií]da|obra\s+conclu[ií]da|servi[cç]o\s+conclu[ií]do/i.test(t) ? 'concluída' :
    /atividade\s+em\s+andamento|obra\s+em\s+andamento|servi[cç]o\s+em\s+execu[cç][aã]o/i.test(t) ? 'em_andamento' : '';

  // sinais de domínio
  const mentionsObra  = /\bobra(?:s)?\b|edifica[cç][aã]o|constru[cç][aã]o|pavimenta[cç][aã]o|recapeamento|terraplenagem/i.test(t);
  const mentionsManut = /\bmanuten[cç][aã]o\b|preventiva|corretiva|predial|rotina|servi[cç]os continuados/i.test(t);
  const mentionsInst  = /\binstala[cç][aã]o|montagem|comissionamento\b/i.test(t);
  const mentionsFor   = /\bfornecimento|suprimento|aquisi[cç][aã]o\b/i.test(t);

  // tags e confiança (heurístico leve)
  const domainTags = [];
  if (mentionsObra) domainTags.push('obra');
  if (mentionsManut) domainTags.push('manutencao');
  if (mentionsInst) domainTags.push('instalacao');
  if (mentionsFor) domainTags.push('fornecimento');

  let confidence = 0;
  if (catNum) confidence += 0.35;
  if (orgao) confidence += 0.15;
  if (escopo && escopo.length > 40) confidence += 0.25;
  if (hasART || hasCREA || hasCAU) confidence += 0.15;
  if (profissional) confidence += 0.10;
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  // dedup/associação
  const hashKey = [
    toAsciiLower(catNum || ''),
    String(ano || ''),
    toAsciiLower(profissional || '')
  ].join('#');

  return {
    nomeCAT: sourceName || 'CAT (sem nome)',
    catNum,
    orgao,
    ano,
    escopo,
    hasART,
    hasCREA,
    hasCAU,
    mentionsObra,
    mentionsManut,
    mentionsInstalacao: mentionsInst,
    mentionsFornecimento: mentionsFor,
    profissional,
    titulo,
    status,
    domainTags,
    confidence,
    hashKey,
    raw: t,
    fileHints: {
      fileCatNum: hints.fileCatNum || '',
      fileYear: hints.fileYear || '',
      fileOrgao: hints.fileOrgao || ''
    }
  };
}

module.exports = { extractCATMeta };
