// src/controllers/editalControllerCore.js
const fs = require('fs');
const path = require('path');
const { getDb } = require('../Config/db');
const { MAX_EDITALTEXT_CHARS } = require('../Config/env');
const { extractTextFromPdf } = require('../utils/ocr');
const PDFDocument = require('pdfkit');
const Companies = require('../models/companyModel');

const {
  extractRequirementsFromBid,
  analyzeRequirementWithContext,
  analyzeSingleRequirement,
  generateExecutiveSummary,
  findEvidenceOnTheFly,
  TECH_REQ_RX,
  summarize,
  buildRecommendation,
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

const REPORTS_BASE_DIR = path.join(process.cwd(), 'data', 'reports');
const companyReportsDir = (companyId) => path.join(REPORTS_BASE_DIR, String(companyId || 'unknown'));

/* ============================ HELPERS PDF ============================ */
function cleanTextForPdf(text = '') {
  const zwsp = '\u200B';
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/([A-Za-z0-9_/\\\-]{30,})/g, (m) => m.split('').join(zwsp));
}

function renderMarkdownSimple(doc, markdown) {
  const lines = cleanTextForPdf(markdown).split(/\r?\n/);
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const drawHr = () => {
    doc.moveDown(0.3);
    const y = doc.y;
    doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y)
      .strokeColor('#e5e7eb').lineWidth(1).stroke();
    doc.strokeColor('black').lineWidth(1);
    doc.moveDown(0.3);
  };

  lines.forEach((ln) => {
    if (/^\s*---\s*$/.test(ln)) { drawHr(); return; }
    if (/^#\s+/.test(ln))  { doc.moveDown(0.3).font('Helvetica-Bold').fontSize(18).text(ln.replace(/^#\s+/, ''), { width: contentWidth }); doc.font('Helvetica').fontSize(11); return; }
    if (/^##\s+/.test(ln)) { doc.moveDown(0.25).font('Helvetica-Bold').fontSize(14).text(ln.replace(/^##\s+/, ''), { width: contentWidth }); doc.font('Helvetica').fontSize(11); return; }
    if (/^###\s+/.test(ln)) { doc.moveDown(0.2).font('Helvetica-Bold').fontSize(12).text(ln.replace(/^###\s+/, ''), { width: contentWidth }); doc.font('Helvetica').fontSize(11); return; }
    if (/^\s*[-•]\s+/.test(ln)) { doc.text(`• ${ln.replace(/^\s*[-•]\s+/, '')}`, { width: contentWidth, indent: 10 }); return; }
    if (/^\s*$/.test(ln)) { doc.moveDown(0.25); return; }
    doc.text(ln, { width: contentWidth, align: 'justify' });
  });
}

async function gerarPdf(markdown, companyId) {
  const reportsDir = companyReportsDir(companyId);
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `relatorio_viabilidade_${Date.now()}.pdf`;
  const outPath = path.join(reportsDir, filename);

  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // capa
  doc.font('Helvetica-Bold').fontSize(16).text('RELATÓRIO DE VIABILIDADE', { align: 'center' });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#6b7280')
    .text(`Emitido em: ${new Date().toLocaleString('pt-BR')}`, { align: 'center' })
    .fillColor('black');
  doc.moveDown();

  renderMarkdownSimple(doc, markdown);

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  // importante: rota autenticada que serve por empresa
  return { filePath: outPath, publicUrl: `/api/edital/report/${filename}`, filename };
}

/* ============================ CORE ============================ */
async function analisarEditalCore(files, onProgress = () => {}, opts = {}) {
  const { companyId } = opts || {};
  const bump = (pct, phase) => { try { onProgress(pct, phase); } catch {} };

  // Mongo (chunks vetoriais)
  let collection = null;
  try {
    const db = await getDb();
    collection = db.collection('chunks');
  } catch {}

  // Perfil da empresa (ADMIN)
  let companyProfile = null;
  if (companyId) {
    try {
      const c = await Companies.findById(companyId);
      companyProfile = c ? c : null;
    } catch (_) {}
  }

  const mainEditalFile = files.mainEditalFile;
  const annexFiles = files.annexFiles || [];
  const allUploadedFiles = [mainEditalFile, ...annexFiles];

  try {
    // OCR principal
    const rawPdf = fs.readFileSync(mainEditalFile.path);
    const mainEditalText = await extractTextFromPdf(rawPdf, mainEditalFile.path);
    if (!mainEditalText?.trim()) {
      throw new Error('Não foi possível extrair texto do PDF principal.');
    }
    const editalText = mainEditalText.slice(0, MAX_EDITALTEXT_CHARS || 200000);
    bump(15, 'OCR do edital');

    // textos locais (para evidência)
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

    // cabeçalho essencial
    const header = (() => {
      const api = require('../controllers/editalController');
      if (api.__getParseHeader) return api.__getParseHeader(editalText);
      return { objetoLicitado: (editalText.match(/OBJETO[\s\S]{0,800}/i)?.[0] || '').slice(0, 800) };
    })();
    signaturesFor(header.objetoLicitado || editalText);
    bump(30, 'Cabeçalho extraído');

    // CATs (Mongo + locais)
    const allCatsRaw = await findCATMatches(
      collection ? { chunksCol: collection } : null,
      header.objetoLicitado || editalText,
      10,
      localFilesText,
      { companyId }
    );

    const dedupCats = uniqueByCat(allCatsRaw).map(c => ({ ...c, ano: pickReasonableYear(c.raw) || c.ano || '' }));

    const ranked = dedupCats.map(c => ({
      meta: c,
      score: scoreCatToObjetoLote(
        c,
        header.objetoLicitado || editalText,
        ((header.concorrenciaEletronica || '') + '\n' + (header.tipo || ''))
      )
    })).sort((a, b) => b.score - a.score);

    const MIN_ALIGN_SCORE = 5;
    const rankedCats = ranked.filter(r => r.score >= (MIN_ALIGN_SCORE - 2));
    const topRanked = rankedCats.slice(0, 3);
    const topCats = topRanked.map(r => r.meta);
    const domainAligned = ranked.some(r => r.score >= MIN_ALIGN_SCORE);
    bump(60, 'CATs selecionadas');

    // requisitos
    const allRequirements = await extractRequirementsFromBid(editalText);
    const requirementsToAnalyze = (allRequirements || []).filter(r =>
      !/credenciamento|chave|senha|licitanet|comprasnet|bll|enviar proposta/i.test(r || '')
    );

    const detailedAnalyses = [];
    const techBlocks = [];
    const adminBlocks = [];

    const maxScore = (topRanked[0]?.score || 0) || 1;

    for (let i = 0; i < requirementsToAnalyze.length; i++) {
      const reqTxt = requirementsToAnalyze[i];
      const isTech = TECH_REQ_RX.test(reqTxt.toLowerCase());

      if (isTech) {
        if (topCats.length > 0) {
          const bullets = topRanked.map(r => {
            const c = r.meta;
            const tags = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
              .filter(Boolean).join(' · ');
            const label = `${c.nomeCAT}${c.ano ? ` (${c.ano})` : ''}`;
            const conf = Math.round(Math.min(97, Math.max(55, (r.score / maxScore) * 100)));
            return `• ${label} — ${tags || '—'} — **conf.: ${conf}%**`;
          }).join('\n');

          const status = domainAligned ? '🟢 ATENDIDO.' : '🟡 ATENDIDO PARCIALMENTE.';
          const note = domainAligned ? '' : '\n\n> Observação: CATs localizadas com aderência parcial; recomenda-se substituir por CATs do mesmo escopo do edital.';
          const block = `Requisito: ${reqTxt}\n\n${status}\n\nA qualificação técnica é suportada pelas seguintes CATs do acervo:\n${bullets}${note}`;
          detailedAnalyses.push(block);
          techBlocks.push(block);
        } else {
          const block = `Requisito: ${reqTxt}\n\n🔴 **NÃO ATENDIDO** — Não foram localizadas CATs aderentes no acervo.`;
          detailedAnalyses.push(block);
          techBlocks.push(block);
        }
      } else {
        let block;
        if (companyProfile) {
          // >>> FIX: passa o profile no 3º parâmetro (antes estava errado)
          block = await analyzeRequirementWithContext(reqTxt, null, companyProfile);
        } else {
          const evidence = await findEvidenceOnTheFly(reqTxt, filesForEvidenceSearch, collection);
          block = await analyzeSingleRequirement(reqTxt, evidence);
        }
        detailedAnalyses.push(block);
        adminBlocks.push(block);
      }

      if (i % 3 === 0) {
        const pct = Math.min(80, 60 + Math.round(((i + 1) / Math.max(1, requirementsToAnalyze.length)) * 20));
        bump(pct, 'Analisando requisitos');
      }
    }

    // viabilidade técnica
    const blocoViabilidade = (topCats.length
      ? `### Viabilidade profissional e técnica

Com base no acervo (CATs), identificamos ${domainAligned ? '**aderência técnica direta**' : '**aderência parcial**'} ao objeto licitado:

${topCats.map(c => {
  const comp = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null].filter(Boolean).join(' · ');
  const head = [`**CAT:** ${c.nomeCAT}`, c.orgao ? `**Órgão/Entidade:** ${c.orgao}` : null, c.ano ? `**Ano:** ${c.ano}` : null].filter(Boolean).join(' | ');
  return `- ${head}
  - **Escopo/Resumo:** ${c.escopo}
  - **Comprovações:** ${comp || '—'}`;
}).join('\n\n')}`
      : '### Viabilidade profissional e técnica\n\n- **Não localizamos CATs aderentes automaticamente.** Recomenda-se checagem manual do acervo.'
    );

    // RT sugerido
    const rtSugerido = suggestBestRT(topCats, header.objetoLicitado || editalText);
    let blocoRT = '';
    if (rtSugerido) {
      const reqBase = [header.objetoLicitado || '', ...(Array.isArray(allRequirements) ? allRequirements : [])].join('\n');
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
        (comp.length ? comp.map(l => `- ${l}`).join('\n') : '- (Sem parâmetros comparáveis explícitos)')
      ].join('\n\n');
    }

    // sumário + recomendação 70/30
    let summary = await generateExecutiveSummary(detailedAnalyses);
    bump(90, 'Sumário executivo');

    const tech = summarize(techBlocks);
    const admin = summarize(adminBlocks);
    const rec = buildRecommendation({ tech, admin, hasAlignedCAT: domainAligned });

    const quadroPontuacao = [
      '## Recomendação Final e Pontuação',
      rec.markdown
    ].join('\n\n');

    // header
    const headerItems = [
      `### Órgão Licitório\n${header.orgaoLicitante || '-'}`,
      `### Concorrência Eletrônica\n${header.concorrenciaEletronica || '-'}`,
      `### Tipo\n${header.tipo || '-'}`,
      `### Prazo de execução\n${header.prazoExecucao || '-'}`,
      `### Classificação de Despesa e valor do objeto\n${header.classificacaoDespesaEValor || '-'}`,
      `### Objeto licitado\n${header.objetoLicitado || '-'}`,
      `### Prazo máximo para proposta\n${header.prazoMaximoParaProposta || '-'}`,
    ];

    // confiança CATs
    let blocoConfianca = '';
    if (topRanked.length) {
      const max = topRanked[0].score || 1;
      const linhas = topRanked.map(r => {
        const conf = Math.round(Math.min(97, Math.max(55, (r.score / max) * 100)));
        return `- ${r.meta.nomeCAT}${r.meta.ano ? ` (${r.meta.ano})` : ''} — **conf.: ${conf}%**`;
      }).join('\n');
      blocoConfianca = ['### Confiança de Aderência das CATs Selecionadas', linhas].join('\n\n');
    }

    const finalReport = [
      '# RELATÓRIO DE VIABILIDADE',
      headerItems.join('\n\n---\n\n'),
      '---',
      blocoViabilidade,
      blocoConfianca ? `\n---\n\n${blocoConfianca}` : '',
      blocoRT ? `\n---\n\n${blocoRT}` : '',
      '---',
      quadroPontuacao,
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
    console.error('[analisarEditalCore] erro:', error?.stack || error);
    for (const f of allUploadedFiles) { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} }
    throw error;
  }
}

module.exports = { analisarEditalCore, gerarPdf };
