// utils/cat_meta.js
function extractCATMeta(sourceName, text) {
  const t = (text || '').replace(/\s+/g, ' ');
  const catNum =
    (t.match(/CAT\s*[NºNo\.:\- ]+\s*([0-9\-\/\.]+)/i)?.[1]) ||
    (sourceName.match(/CAT\s*[NºNo\. ]*\s*([0-9\-\/\.]+)/i)?.[1]) || '';

  // Orgão/entidade recorrentes
  const orgao = (t.match(/\b(PM de [A-ZÁ-Ú][\w\s\-]+|UFAL|CELPE|CHESF|SEINFRA|SINFRA|PMJP|UFRPE|SEDUC|SEINFRA\/\w+|COMPESA|CAGEPA|PM\w+)\b/i)?.[0]) || '';

  // Ano "razoável" (evita 1966 da Lei); se não achar, tenta no nome do arquivo
  const years = (t.match(/\b(19\d{2}|20\d{2})\b/g) || []).map(Number).filter(y => y >= 1990 && y <= 2099);
  const ano = (years.length ? String(Math.max(...years)) :
    (sourceName.match(/\b(20\d{2}|19\d{2})\b/)?.[1]) || '');

  const hasART  = /ART\b|Anota[cç][aã]o de Responsabilidade T[ée]cnica/i.test(t);
  const hasCREA = /\bCREA\b|\bCAU\b/i.test(t);

  // Sinais gerais do escopo e disciplina
  const mentionsObra  = /\bobra(s)?\b|edifica[cç][aã]o|constru[cç][aã]o/i.test(t);
  const mentionsManut = /manuten[cç][aã]o|preventiva|corretiva|predial/i.test(t);

  // Disciplina do profissional (pode ajudar no domínio)
  const profissional = (t.match(/Profissional\s*:\s*([^\n]+?)\s+(?:Registro|RNP|Título)/i)?.[1]
    || t.match(/Profissional:\s*([^\n]+)/i)?.[1] || '').trim();
  const titulo       = (t.match(/T[íi]tulo profissional\s*:\s*([^\n]+)/i)?.[1] || '').trim();

  // Status do atestado (concluída/em andamento)
  const status = (/atividade\s+conclu[ií]da/i.test(t) ? 'concluída' :
                 /atividade\s+em\s+andamento/i.test(t) ? 'em_andamento' : '');

  // Extrai bloco de “Observações/Atividade Técnica/Objeto” como escopo
  let escopo = '';
  const mEscopo =
    t.match(/(?:OBJETO|OBJETIVO|DESCRI[ÇC][AÃ]O(?: DA OBRA OU SERVI[ÇC]O)?|ATIVIDADE T[ÉE]CNICA|OBSERVA[ÇC][AÃ]O(?:ES)?)\s*[:\-]\s*([\s\S]{0,400}?)(?:\.\s|;|\n|$)/i);
  if (mEscopo) escopo = mEscopo[1].trim();
  if (!escopo) {
    const snip = t.slice(0, 300).trim();
    escopo = snip.endsWith('...') ? snip : `${snip}${snip.length >= 300 ? '...' : ''}`;
  }

  return {
    nomeCAT: sourceName || 'CAT (sem nome)',
    catNum, orgao, ano, escopo,
    hasART, hasCREA, mentionsObra, mentionsManut,
    profissional, titulo, status,
    raw: t
  };
}

module.exports = { extractCATMeta };
