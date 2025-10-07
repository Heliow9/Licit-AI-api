// controllers/editalControllerCore.js
const fs = require('fs');
const path = require('path');
const { getDb } = require('../Config/db');
const { MAX_EDITALTEXT_CHARS } = require('../Config/env');
const { extractTextFromPdf } = require('../utils/ocr');
const {
  extractRequirementsFromBid,
  analyzeSingleRequirement,
  generateExecutiveSummary,
  findEvidenceOnTheFly
} = require('../services/evidence');

const {
  findCATMatches,
  uniqueByCat,
  scoreCatToObjetoLote,
  pickReasonableYear,
  suggestBestRT,
  compareReqVsCat,
  signaturesFor
} = require('../services/cats');

const PDFDocument = require('pdfkit');

const REPORTS_BASE_DIR = path.join(process.cwd(), 'data', 'reports');
const companyReportsDir = (companyId) => path.join(REPORTS_BASE_DIR, String(companyId || 'unknown'));

function cleanTextForPdf(text = '') {
  const zwsp = '\u200B';
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/#/g, '')
    .replace(/•/g, '-')
    .replace(/([A-Za-z0-9_/\\\-]{30,})/g, (m) => m.split('').join(zwsp));
}

async function gerarPdf(markdown, companyId) {
  const reportsDir = companyReportsDir(companyId);
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `relatorio_viabilidade_${Date.now()}.pdf`;
  const outPath = path.join(reportsDir, filename);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const clean = cleanTextForPdf(markdown);

  doc.font('Helvetica').fontSize(16).text('RELATÓRIO DE VIABILIDADE', { align: 'center', width: contentWidth });
  doc.moveDown(0.5);
  doc.fontSize(10).text(clean, { align: 'justify', width: contentWidth, lineGap: 2 });
  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { filePath: outPath, publicUrl: `/static/reports/${filename}`, filename };
}

/**
 * Core da análise que NÃO escreve resposta HTTP.
 * Agora aceita { companyId } em opts (back-compat se não mandar).
 */
async function analisarEditalCore(files, onProgress = () => {}, opts = {}) {
  const { companyId } = opts || {};
  const bump = (pct, phase) => { try { onProgress(pct, phase); } catch {} };

  let collection = null;
  try {
    const db = await getDb();
    collection = db.collection('chunks');
  } catch {}

  const mainEditalFile = files.mainEditalFile;
  const annexFiles = files.annexFiles || [];
  const allUploadedFiles = [mainEditalFile, ...annexFiles];

  try {
    const rawPdf = fs.readFileSync(mainEditalFile.path);
    const mainEditalText = await extractTextFromPdf(rawPdf, mainEditalFile.path);
    if (!mainEditalText?.trim()) {
      throw new Error('Não foi possível extrair texto do PDF principal.');
    }
    const editalText = mainEditalText.slice(0, MAX_EDITALTEXT_CHARS || 200000);
    bump(15, 'OCR do edital');

    const filesForEvidenceSearch = await Promise.all(
      allUploadedFiles.map(async (file) => ({
        source: file.originalname,
        getText: async () => extractTextFromPdf(fs.readFileSync(file.path), file.path)
      }))
    );

    const localFilesText = [];
    for (let i = 0; i < filesForEvidenceSearch.length; i++) {
      try {
        const txt = await filesForEvidenceSearch[i].getText();
        localFilesText.push({ source: filesForEvidenceSearch[i].source, text: txt || '' });
      } catch {}
    }
    bump(25, 'Textos locais prontos');

    const header = (() => {
      const api = require('../controllers/editalController');
      if (api.__getParseHeader) return api.__getParseHeader(editalText);
      return { objetoLicitado: (editalText.match(/OBJETO[\s\S]{0,800}/i)?.[0] || '').slice(0, 800) };
    })();
    const objSigs = signaturesFor(header.objetoLicitado || editalText);
    bump(30, 'Cabeçalho extraído');

    const allCatsRaw = await findCATMatches(
      collection ? { chunksCol: collection } : null,
      header.objetoLicitado || editalText,
      8,
      localFilesText,
      { companyId } // << filtra por empresa se o service suportar
    );
    const dedupCats = uniqueByCat(allCatsRaw).map(c => ({ ...c, ano: pickReasonableYear(c.raw) || c.ano || '' }));
    const ranked = dedupCats.map(c => ({
      meta: c,
      score: scoreCatToObjetoLote(c, header.objetoLicitado || editalText, (header.concorrenciaEletronica||'')+'\n'+(header.tipo||''))
    })).sort((a,b)=>b.score-a.score);
    const MIN_ALIGN_SCORE = 5;
    const rankedCats = ranked.filter(r=> r.score >= (MIN_ALIGN_SCORE-2)).map(r=>r.meta);
    const topCats = rankedCats.slice(0,2);
    const domainAligned = ranked.slice(0,2).some(r=> r.score >= MIN_ALIGN_SCORE);
    bump(60, 'CATs selecionadas');

    const allRequirements = await extractRequirementsFromBid(editalText);
    const requirementsToAnalyze = (allRequirements||[]).filter(r=> !/credenciamento|chave|senha|licitanet|comprasnet|bll|enviar proposta/i.test(r||''));
    const detailedAnalyses = [];
    for (let i=0;i<requirementsToAnalyze.length;i++){
      const reqTxt = requirementsToAnalyze[i];
      const isTech = /\b(cat|experi[êe]ncia|acervo|atestado|capacita[çc][aã]o t[ée]cnica)\b/i.test(reqTxt.toLowerCase());
      if (isTech && topCats.length>0){
        const bullets = topCats.map(c=>{
          const tags = [c.catNum?`CAT nº ${c.catNum}`:null,c.hasART?'ART':null,c.hasCREA?'CREA/CAU':null].filter(Boolean).join(' · ');
          const label = `${c.nomeCAT}${c.ano?` (${c.ano})`:''}`;
          return `• ${label} — ${tags || '—'}`;
        }).join('\n');
        const status = domainAligned ? '🟢 ATENDIDO.' : '🟡 ATENDIDO PARCIALMENTE.';
        const note   = domainAligned ? '' : '\n\n> Observação: CATs localizadas com aderência parcial; recomenda-se substituir por CATs do mesmo escopo do edital.';
        detailedAnalyses.push(`Requisito: ${reqTxt}\n\n${status}\n\nA qualificação técnica é suportada pelas seguintes CATs do acervo:\n${bullets}${note}`);
      } else {
        const evidence = await findEvidenceOnTheFly(reqTxt, filesForEvidenceSearch, collection, { companyId });
        detailedAnalyses.push(await analyzeSingleRequirement(reqTxt, evidence));
      }
      if (i % 3 === 0) bump(Math.min(80, 60 + Math.round((i+1)/Math.max(1,requirementsToAnalyze.length)*20)), 'Analisando requisitos');
    }

    const blocoViabilidade = (topCats.length
      ? `### Viabilidade profissional e técnica

Com base no acervo (CATs), identificamos ${domainAligned ? '**aderência técnica direta**' : '**aderência parcial**'} ao objeto licitado:

${topCats.map(c=>{
  const comp=[c.catNum?`CAT nº ${c.catNum}`:null,c.hasART?'ART':null,c.hasCREA?'CREA/CAU':null].filter(Boolean).join(' · ');
  const head=[`**CAT:** ${c.nomeCAT}`, c.orgao?`**Órgão/Entidade:** ${c.orgao}`:null, c.ano?`**Ano:** ${c.ano}`:null].filter(Boolean).join(' | ');
  return `- ${head}
  - **Escopo/Resumo:** ${c.escopo}
  - **Comprovações:** ${comp || '—'}`;
}).join('\n\n')}`
      : '### Viabilidade profissional e técnica\n\n- **Não localizamos CATs aderentes automaticamente.** Recomenda-se checagem manual do acervo.'
    );

    const rtSugerido = suggestBestRT(topCats, header.objetoLicitado || editalText);
    let blocoRT = '';
    if (rtSugerido){
      const reqBase = [header.objetoLicitado||'', ...(Array.isArray(allRequirements)?allRequirements:[])].join('\n');
      const chosenCat = topCats.find(c => c.nomeCAT === rtSugerido.arquivo) || topCats[0];
      const comp = compareReqVsCat(reqBase, chosenCat?.raw || '');
      blocoRT = [
        '### Responsável Técnico Sugerido',
        `**Nome:** ${rtSugerido.profissional}`,
        `**CAT nº / Ano / Órgão:** ${rtSugerido.catNum} / ${rtSugerido.ano} / ${rtSugerido.orgao}`,
        `**Escopo (resumo):** ${rtSugerido.escopo}`,
        `**Fonte (arquivo):** ${rtSugerido.arquivo}`,
        '',
        '#### Comprovação de equivalência/excedente frente ao edital',
        (comp.length ? comp.map(l=>`- ${l}`).join('\n') : '- (Sem parâmetros comparáveis explícitos)')
      ].join('\n\n');
    }

    let summary = await generateExecutiveSummary(detailedAnalyses, header.objetoLicitado || '');
    bump(90, 'Sumário executivo');

    const headerItems = [
      `### Órgão Licitório\n${header.orgaoLicitante || '-'}`,
      `### Concorrência Eletrônica\n${header.concorrenciaEletronica || '-'}`,
      `### Tipo\n${header.tipo || '-'}`,
      `### Prazo de execução\n${header.prazoExecucao || '-'}`,
      `### Classificação de Despesa e valor do objeto\n${header.classificacaoDespesaEValor || '-'}`,
      `### Objeto licitado\n${header.objetoLicitado || '-'}`,
      `### Prazo máximo para proposta\n${header.prazoMaximoParaProposta || '-'}`,
    ];

    const finalReport = [
      '# RELATÓRIO DE VIABILIDADE',
      headerItems.join('\n\n---\n\n'),
      '---',
      blocoViabilidade,
      blocoRT ? `\n---\n\n${blocoRT}` : '',
      '---',
      '## Sumário Executivo',
      summary,
      '---',
      '## Análise Detalhada',
      detailedAnalyses.join('\n\n---\n\n') || '- (Não foi possível gerar a análise detalhada)'
    ].join('\n\n');

    const { publicUrl, filePath, filename } = await gerarPdf(finalReport, companyId);
    bump(100, 'PDF emitido');

    for (const f of allUploadedFiles) { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} }

    return { report: finalReport, pdf: { filename, url: publicUrl, path: filePath } };

  } catch (error) {
    for (const f of allUploadedFiles) { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} }
    throw error;
  }
}

module.exports = { analisarEditalCore, gerarPdf };
