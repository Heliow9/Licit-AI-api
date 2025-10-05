function extractCATMeta(sourceName, text) {
  const t = (text || '').replace(/\s+/g, ' ');
  const catNum =
    (t.match(/CAT\s*[NºNo\.:\- ]+\s*([0-9\-\/\.]+)/i)?.[1]) ||
    (sourceName.match(/CAT\s*[NºNo\. ]*\s*([0-9\-\/\.]+)/i)?.[1]) || '';
  const orgao = (t.match(/\b(PM de [A-ZÁ-Ú][\w\s\-]+|UFAL|CELPE|CHESF|SEINFRA|SINFRA|PMJP|UFRPE|SEDUC|SEINFRA\/\w+)\b/i)?.[0]) || '';
  const ano = (t.match(/\b(20\d{2}|19\d{2})\b/)?.[1]) || (sourceName.match(/\b(20\d{2}|19d{2})\b/)?.[1]) || '';
  const hasART = /ART\b|Anota[cç][aã]o de Responsabilidade T[ée]cnica/i.test(t);
  const hasCREA = /\bCREA\b|\bCAU\b/i.test(t);
  const mentionsObra = /\bobra(s)?\b|edifica[cç][aã]o|constru[cç][aã]o/i.test(t);
  const mentionsManut = /manuten[cç][aã]o|preventiva|corretiva|predial/i.test(t);

  let escopo = '';
  const mEscopo = t.match(/(?:OBJETO|OBJETIVO|DESCRI[ÇC][AÃ]O DA OBRA OU SERVI[ÇC]O|DESCRI[ÇC][AÃ]O)\s*[:\-]\s*([\s\S]{0,300}?)(?:\.\s|;|\n|$)/i);
  if (mEscopo) escopo = mEscopo[1].trim();
  if (!escopo) {
    const snip = t.slice(0, 220).trim();
    escopo = snip.endsWith('...') ? snip : `${snip}${snip.length >= 220 ? '...' : ''}`;
  }

  return { nomeCAT: sourceName || 'CAT (sem nome)', catNum, orgao, ano, escopo, hasART, hasCREA, mentionsObra, mentionsManut, raw: t };
}

module.exports = { extractCATMeta };
