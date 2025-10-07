// utils/cat_meta.js
function normalizeSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function extractFromFilename(sourceName = '') {
  const name = String(sourceName || '');

  // CAT num em filename: "CAT 1234-2023", "CAT_987/2021", "CAT-456.2019" etc.
  const catNum =
    name.match(/CAT\s*[:.\- ]*\s*([0-9][0-9./\-]+)/i)?.[1] ||
    name.match(/\b(\d{3,6}[/.\-]\d{2,4})\b/)?.[1] || '';

  // Ano no filename
  const fileYear = name.match(/\b(19\d{2}|20\d{2})\b/)?.[1] || '';

  // Órgão “palpável” no filename (acrósticos usuais e PM-XXX)
  const orgaoAcr =
    name.match(/\b(?:PM-?[A-Z]{2,}|SEINFRA|SINFRA|DER|DNIT|DEINFRA|SEDUC|SESA|COMPESA|CAGEPA|SABESP|SANEPAR|CHESF|CELPE|CEMIG|COPEL|LIGHT|UF[A-Z]{1,3}|UFR[A-Z]*|IF[A-Z]{2,})\b/i)?.[0] || '';

  return {
    fileCatNum: catNum,
    fileYear,
    fileOrgao: orgaoAcr
  };
}

function extractCATMeta(sourceName, text) {
  const t = normalizeSpaces(text);
  const hints = extractFromFilename(sourceName);

  // CAT Nº (várias grafias)
  const catNum =
    t.match(/\bCAT\s*(?:N[º°o\.]|num(?:ero)?|n)\s*[:.\- ]*\s*([0-9][0-9./\-]+)/i)?.[1] ||
    t.match(/\bCAT\s*[:.\- ]+\s*([0-9][0-9./\-]+)/i)?.[1] ||
    hints.fileCatNum || '';

  // Órgão/Entidade (lista ampliada + padrões longos)
  const orgaoLong =
    t.match(/\b(PREFEITURA MUNICIPAL DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|GOVERNO DO ESTADO DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|SECRETARIA (?:MUNICIPAL|ESTADUAL) DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|UNIVERSIDADE(?: FEDERAL| ESTADUAL)? DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+|CÂMARA MUNICIPAL DE [A-ZÁ-Ú][A-ZÁ-Ú\s\-]+)\b/i)?.[0];

  const orgaoAcr =
    t.match(/\b(PM de [A-ZÁ-Ú][\w\s\-]+|PM-?[A-Z]{2,}|UF[A-Z]{1,3}|UFR[A-Z]*|IF[A-Z]{2,}|CELPE|CHESF|SEINFRA|SINFRA|SEDUC|COMPESA|CAGEPA|SABESP|SANEPAR|DER|DNIT|CEMIG|COPEL|LIGHT)\b/i)?.[0];

  const orgao = (orgaoLong || orgaoAcr || hints.fileOrgao || '').trim();

  // Ano “razoável” (mais recente)
  const years = (t.match(/\b(19\d{2}|20\d{2})\b/g) || [])
    .map(Number)
    .filter(y => y >= 1990 && y <= 2099);
  const ano = String(years.length ? Math.max(...years) : (hints.fileYear || ''));

  const hasART  = /\bART\b|Anota[cç][aã]o de Responsabilidade T[ée]cnica/i.test(t);
  const hasCREA = /\bCREA\b|\bCAU\b/i.test(t);

  // Sinais do escopo
  const mentionsObra  = /\bobra(?:s)?\b|edifica[cç][aã]o|constru[cç][aã]o/i.test(t);
  const mentionsManut = /\bmanuten[cç][aã]o\b|preventiva|corretiva|predial/i.test(t);

  // Profissional / título (mantém sua lógica original, com fallback)
  const profissional =
    (t.match(/Profissional\s*:\s*([^\n]+?)\s+(?:Registro|RNP|T[íi]tulo)/i)?.[1] ||
     t.match(/Profissional:\s*([^\n]+)/i)?.[1] || '')
    .trim();

  const titulo = (t.match(/T[íi]tulo profissional\s*:\s*([^\n]+)/i)?.[1] || '').trim();

  // Status do atestado
  const status =
    /atividade\s+conclu[ií]da/i.test(t) ? 'concluída' :
    /atividade\s+em\s+andamento/i.test(t) ? 'em_andamento' : '';

  // Escopo: tenta blocos clássicos com “respiro”
  let escopo = '';
  const mEscopo = t.match(
    /(?:OBJETO|OBJETIVO|DESCRI[ÇC][AÃ]O(?: DA OBRA OU SERVI[ÇC]O)?|ATIVIDADE T[ÉE]CNICA|OBSERVA[ÇC][AÃ]O(?:ES)?)\s*[:\-]\s*([\s\S]{0,500}?)(?:\.\s|;\s|$)/i
  );
  if (mEscopo) {
    escopo = normalizeSpaces(mEscopo[1]);
  }
  if (!escopo) {
    const snip = t.slice(0, 300).trim();
    escopo = snip ? (snip.length >= 300 ? snip + '…' : snip) : '';
  }

  return {
    nomeCAT: sourceName || 'CAT (sem nome)',
    catNum,
    orgao,
    ano,
    escopo,
    hasART,
    hasCREA,
    mentionsObra,
    mentionsManut,
    profissional,
    titulo,
    status,
    raw: t,
    // NOVO: usado pelo controller como fallback em alguns pontos
    fileHints: {
      fileCatNum: hints.fileCatNum || '',
      fileYear: hints.fileYear || '',
      fileOrgao: hints.fileOrgao || ''
    }
  };
}

module.exports = { extractCATMeta };
