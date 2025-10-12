const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const { getDb } = require('../Config/db');
const Companies = require('../models/companyModel');
const { MAX_EDITALTEXT_CHARS } = require('../Config/env');
const { extractTextFromPdf } = require('../utils/ocr');

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

/* ====== diretório por empresa para salvar relatórios ====== */
const REPORTS_BASE_DIR = path.join(process.cwd(), 'data', 'reports');
const companyReportsDir = (companyId) => path.join(REPORTS_BASE_DIR, String(companyId || 'unknown'));

/* ============================ PDF helpers ============================ */
function cleanTextForPdf(text = '') {
  const zwsp = '\u200B';
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/([A-Za-z0-9_/\\\-]{30,})/g, (m) => m.split('').join(zwsp));
}

function renderMarkdownSimple(doc, markdown) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const raw = cleanTextForPdf(markdown || '');

  const lines = raw
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+$/gm, '')
    .replace(/^(\s*[-•]\s*)\*\*\s*/gm, '$1')
    .split('\n');

  const drawHr = () => {
    doc.moveDown(0.35);
    const y = doc.y;
    doc.save()
      .lineWidth(0.8)
      .strokeColor('#e5e7eb')
      .moveTo(doc.page.margins.left, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .stroke()
      .restore();
    doc.moveDown(0.35);
  };

  const writePara = (t) => {
    doc.text(t, {
      width: contentWidth,
      align: 'justify',
      lineGap: 2.6,
      paragraphGap: 4.2
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (/\[\[PAGE_BREAK\]\]/.test(ln)) {
      doc.addPage();
      continue;
    }
    if (/^\s*---\s*$/.test(ln)) { drawHr(); continue; }
    if (/^#\s+/.test(ln)) {
      doc.font('Helvetica-Bold').fontSize(18).text(ln.replace(/^#\s+/, ''), { width: contentWidth });
      doc.font('Helvetica').fontSize(11);
      doc.moveDown(0.4);
      continue;
    }
    if (/^##\s+/.test(ln)) {
      doc.font('Helvetica-Bold').fontSize(14).text(ln.replace(/^##\s+/, ''), { width: contentWidth });
      doc.font('Helvetica').fontSize(11);
      doc.moveDown(0.25);
      continue;
    }
    if (/^###\s+/.test(ln)) {
      doc.font('Helvetica-Bold').fontSize(12).text(ln.replace(/^###\s+/, ''), { width: contentWidth });
      doc.font('Helvetica').fontSize(11);
      doc.moveDown(0.15);
      continue;
    }

    const bulletMatch = ln.match(/^\s*[-•]\s+(.*)$/);
    if (bulletMatch) {
      doc.list([bulletMatch[1]], {
        bulletRadius: 1.8,
        textIndent: 10,
        bulletIndent: 14,
        width: contentWidth
      });
      continue;
    }

    if (/^\s*$/.test(ln)) {
      doc.moveDown(0.15);
      continue;
    }

    writePara(ln);
  }
}

async function gerarPdf(markdown, companyId) {
  const reportsDir = companyReportsDir(companyId);
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `relatorio_viabilidade_${Date.now()}.pdf`;
  const outPath = path.join(reportsDir, filename);

  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  doc.font('Helvetica-Bold').fontSize(16).text('RELATÓRIO DE VIABILIDADE', { align: 'center' });
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10).fillColor('#6b7280')
    .text(`Emitido em: ${new Date().toLocaleString('pt-BR')}`, { align: 'center' })
    .fillColor('black');
  doc.moveDown(0.6);

  renderMarkdownSimple(doc, markdown);

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { filePath: outPath, publicUrl: `/api/edital/report/${filename}`, filename };
}

/* ===================== helper de ranking por lote ===================== */
async function rankCatsFor(textoAlvo, opts) {
  const { catsCol, chunksCol, localFilesText, companyId } = opts;
  const raw = await findCATMatches(
    (catsCol || chunksCol) ? { catsCol, chunksCol } : null,
    textoAlvo,
    10,
    localFilesText,
    { companyId }
  );

  const dedup = uniqueByCat(raw).map(c => ({
    ...c,
    ano: pickReasonableYear(c.raw) || c.ano || ''
  }));

  const ranked = dedup.map(c => ({
    meta: c,
    score: scoreCatToObjetoLote(c, textoAlvo, '')
  })).sort((a, b) => b.score - a.score);

  return ranked.slice(0, 3);
}

/* ============================ CORE ============================ */
async function analisarEditalCore(files, onProgress = () => {}, opts = {}) {
  const { companyId } = opts || {};
  const bump = (pct, phase) => { try { onProgress(pct, phase); } catch {} };

  // Mongo (acesso a cats + chunks)
  let catsCol = null;
  let chunksCol = null;
  try {
    const db = await getDb();
    catsCol = db.collection('cats');     // <- CATs completas
    chunksCol = db.collection('chunks'); // <- OCR/embeddings
  } catch {}

  // Perfil empresa
  let companyProfile = null;
  if (companyId) {
    try {
      companyProfile = await Companies.findById(companyId);
    } catch {}
  }

  const mainEditalFile = files.mainEditalFile;
  const annexFiles = files.annexFiles || [];
  const allFiles = [mainEditalFile, ...annexFiles];

  try {
    const rawPdf = fs.readFileSync(mainEditalFile.path);
    const mainText = await extractTextFromPdf(rawPdf, mainEditalFile.path);
    if (!mainText?.trim()) throw new Error('Falha ao extrair texto do edital.');
    const editalText = mainText.slice(0, MAX_EDITALTEXT_CHARS || 200000);
    bump(15, 'OCR do edital');

    // arquivos locais para evidências
    const localFilesText = [];
    for (const f of allFiles) {
      try {
        const txt = await extractTextFromPdf(fs.readFileSync(f.path), f.path);
        localFilesText.push({ source: f.originalname, text: txt || '' });
      } catch {}
    }
    bump(25, 'Textos locais prontos');

    // header simplificado
    const T = editalText;
    const take = (rx, max = 1200) => (T.match(rx) ? String(T.match(rx)[0]).slice(0, max) : '');
    const objetoBlock = take(/(?:\bDO?\s+OBJETO\b[\s\S]{0,2000})|(?:\bOBJETO\b[\s\S]{0,2000})/i, 2000);

    const lotesSnippet = (() => {
      const lotes = [];
      const rx = /(?:^|\n)\s*(?:LOTE|Lote)\s*(\d+)\s*[:\-–]\s*([\s\S]{0,300})/gi;
      let m; let cap = 0;
      while ((m = rx.exec(T)) && cap < 6) {
        lotes.push(`Lote ${m[1]}: ${m[2].trim().replace(/\s+/g, ' ')}`);
        cap++;
      }
      return lotes.join('\n');
    })();

    const header = {
      objetoLicitado: (objetoBlock || '').trim() || T.slice(0, 2000),
      resumoLotes: lotesSnippet
    };
    bump(30, 'Cabeçalho extraído');

    /* ========== Busca global de CATs (objeto + lotes) ========== */
    const domainProbe = [header.objetoLicitado, header.resumoLotes].filter(Boolean).join('\n') || editalText;

    const allCatsRaw = await findCATMatches(
      (catsCol || chunksCol) ? { catsCol, chunksCol } : null,
      domainProbe,
      15,
      localFilesText,
      { companyId }
    );

    const dedupCats = uniqueByCat(allCatsRaw).map(c => ({
      ...c,
      ano: pickReasonableYear(c.raw) || c.ano || ''
    }));

    const objetoBase = [header.objetoLicitado, header.resumoLotes].filter(Boolean).join('\n') || editalText;
    const preRank = dedupCats.map(c => ({
      meta: c,
      score: scoreCatToObjetoLote(c, objetoBase, '')
    }));
    const rankedCats = preRank.sort((a,b)=>b.score - a.score).slice(0,5);
    const topCats = rankedCats.map(r=>r.meta);
    const domainAligned = rankedCats.some(r=>r.score>=7);
    bump(60, 'CATs selecionadas');

    // Análise de requisitos
    const allRequirements = await extractRequirementsFromBid(editalText);
    const requirementsToAnalyze = (allRequirements || []).filter(r =>
      !/credenciamento|chave|senha|licitanet|comprasnet|bll|enviar proposta/i.test(r || '')
    );

    const detailedAnalyses = [];
    const techBlocks = [];
    const adminBlocks = [];

    const maxScore = rankedCats[0]?.score || 1;

    for (const reqTxt of requirementsToAnalyze) {
      const isTech = TECH_REQ_RX.test(reqTxt.toLowerCase());
      if (isTech) {
        if (topCats.length > 0) {
          const bullets = rankedCats.map(r => {
            const c = r.meta;
            const tags = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
              .filter(Boolean).join(' · ');
            const conf = Math.round(Math.min(97, Math.max(55, (r.score / maxScore) * 100)));
            return `- ${c.nomeCAT}${c.ano ? ` (${c.ano})` : ''} — ${tags || '—'} — **conf.: ${conf}%**`;
          }).join('\n');

          const status = domainAligned ? '🟢 ATENDIDO.' : '🟡 ATENDIDO PARCIALMENTE.';
          detailedAnalyses.push(`Requisito: ${reqTxt}\n\n${status}\n\n${bullets}`);
          techBlocks.push(reqTxt);
        } else {
          const block = `Requisito: ${reqTxt}\n\n🔴 **NÃO ATENDIDO** — Sem CATs aderentes.`;
          detailedAnalyses.push(block);
          techBlocks.push(block);
        }
      } else {
        let block;
        if (companyProfile) block = await analyzeRequirementWithContext(reqTxt, null, companyProfile);
        else {
          const evidence = await findEvidenceOnTheFly(reqTxt, localFilesText, chunksCol);
          block = await analyzeRequirementWithContext(reqTxt, evidence, null);
        }
        detailedAnalyses.push(block);
        adminBlocks.push(block);
      }
    }

    /* ======= Viabilidade Técnica ======= */
    const blocoViabilidade = (topCats.length
      ? `### Viabilidade profissional e técnica\n\nCom base no acervo (CATs), identificamos ${domainAligned ? '**aderência técnica direta**' : '**aderência parcial**'}:\n\n${topCats.map(c => {
          const comp = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null].filter(Boolean).join(' · ');
          return `- ${c.nomeCAT} | ${c.orgao || '-'} | ${c.ano || '-'}\n  - **Escopo:** ${c.escopo}\n  - **Comprovações:** ${comp || '—'}`;
        }).join('\n\n')}`
      : '### Viabilidade profissional e técnica\n\n- Nenhuma CAT aderente encontrada.');

    /* ======= Lotes: aderência individual ======= */
    const lotesAnalise = [];
    if (header.resumoLotes) {
      const lotes = header.resumoLotes.split(/\n+/).filter(Boolean);
      for (const linha of lotes) {
        const top = await rankCatsFor(linha, { catsCol, chunksCol, localFilesText, companyId });
        const max = top[0]?.score || 1;
        lotesAnalise.push({
          titulo: linha.replace(/^\s*Lote\s*\d+\s*[:\-–]\s*/i, '').trim(),
          bullets: top.map(r => {
            const c = r.meta;
            const conf = Math.round(Math.min(97, Math.max(55, (r.score / max) * 100)));
            const tags = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null].filter(Boolean).join(' · ');
            return `- ${c.nomeCAT}${c.ano ? ` (${c.ano})` : ''} — ${tags || '—'} — **conf.: ${conf}%**`;
          }).join('\n') || '- (sem CATs aderentes)'
        });
      }
    }

    const blocoLotes = lotesAnalise.length
      ? ['## Aderência por Lote', ...lotesAnalise.map(l => `### ${l.titulo}\n${l.bullets}`)].join('\n\n')
      : '';

    // RT sugerido (baseado no objeto geral)
    let blocoRT = '';
    if (topCats.length) {
      const rtSugerido = suggestBestRT(topCats, header.objetoLicitado || editalText);
      if (rtSugerido) {
        const chosenCat = topCats.find(c => c.nomeCAT === rtSugerido.arquivo) || topCats[0];
        const comp = compareReqVsCat([header.objetoLicitado, header.resumoLotes].filter(Boolean).join('\n'), chosenCat?.raw || '');
        blocoRT = [
          '### Responsável Técnico Sugerido',
          `**Nome:** ${rtSugerido.profissional}`,
          `**CAT nº / Ano / Órgão:** ${rtSugerido.catNum} / ${rtSugerido.ano} / ${rtSugerido.orgao}`,
          `**Escopo (resumo):** ${rtSugerido.escopo}`,
          `**Fonte (arquivo):** ${rtSugerido.arquivo}`,
          '',
          '#### Comprovação frente ao edital',
          (comp.length ? comp.map(l => `- ${l}`).join('\n') : '- (Sem parâmetros comparáveis explícitos)')
        ].join('\n\n');
      }
    }

    const summary = await generateExecutiveSummary(detailedAnalyses);
    bump(90, 'Sumário');

    const tech = summarize(techBlocks);
    const admin = summarize(adminBlocks);
    const rec = buildRecommendation({ tech, admin, hasAlignedCAT: domainAligned });

    const quadroPontuacao = ['## Recomendação Final e Pontuação', rec.markdown].join('\n\n');

    const finalReport = [
      '# RELATÓRIO DE VIABILIDADE',
      '---',
      blocoViabilidade,
      blocoRT ? `\n---\n\n${blocoRT}` : '',
      blocoLotes ? `\n---\n\n${blocoLotes}` : '',
      '---',
      quadroPontuacao,
      '---',
      '## Sumário Executivo',
      summary,
      '[[PAGE_BREAK]]',
      '## Análise Detalhada',
      detailedAnalyses.join('\n\n---\n\n') || '- (não gerado)'
    ].join('\n\n');

    const { publicUrl, filePath, filename } = await gerarPdf(finalReport, companyId);
    bump(100, 'PDF emitido');

    for (const f of allFiles) { try { fs.existsSync(f.path) && fs.unlinkSync(f.path); } catch {} }

    return { report: finalReport, pdf: { filename, url: publicUrl, path: filePath } };
  } catch (err) {
    console.error('[analisarEditalCore] erro:', err);
    for (const f of allFiles) { try { fs.existsSync(f.path) && fs.unlinkSync(f.path); } catch {} }
    throw err;
  }
}

module.exports = { analisarEditalCore, gerarPdf };
