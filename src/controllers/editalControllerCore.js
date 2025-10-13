const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const { getDb } = require('../Config/db');
const Companies = require('../models/companyModel');
const { MAX_EDITALTEXT_CHARS: MAX_CHARS_ENV } = require('../Config/env');
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
  findCATMatches,       // pode ser versão “premium” (Mongo/embeddings) ou “mínima”
  uniqueByCat,
  scoreCatToObjetoLote,
  pickReasonableYear,
  suggestBestRT,
  compareReqVsCat,
  signaturesFor,
} = require('../services/cats');

/* ====== diretório por empresa para salvar relatórios ====== */
const REPORTS_BASE_DIR = path.join(process.cwd(), 'data', 'reports');
const companyReportsDir = (companyId) => path.join(REPORTS_BASE_DIR, String(companyId || 'unknown'));

/* ====== limites/config ====== */
const MAX_EDITALTEXT_CHARS = Number(MAX_CHARS_ENV || 200000);

/* ============================ PDF helpers ============================ */
function cleanTextForPdf(text = '') {
  const zwsp = '\u200B';
  return String(text || '')
    // remove tags html simples
    .replace(/<[^>]+>/g, '')
    // removes **bold** markup
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // quebra palavras gigantes (para não estourar linhas no pdfkit)
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
      paragraphGap: 4.2,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (/\[\[PAGE_BREAK\]\]/.test(ln)) {
      doc.addPage();
      continue;
    }
    if (/^\s*---\s*$/.test(ln)) {
      drawHr();
      continue;
    }
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
        width: contentWidth,
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

  // Cabeçalho
  doc.font('Helvetica-Bold').fontSize(16).text('RELATÓRIO DE VIABILIDADE', { align: 'center' });
  doc.moveDown(0.35);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#6b7280')
    .text(`Emitido em: ${new Date().toLocaleString('pt-BR')}`, { align: 'center' })
    .fillColor('black');
  doc.moveDown(0.6);

  // Conteúdo
  renderMarkdownSimple(doc, markdown);

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { filePath: outPath, publicUrl: `/api/edital/report/${filename}`, filename };
}

/* ======================= Compat: findCATMatches ======================= */
/**
 * Wrapper para usar findCATMatches em qualquer versão:
 *  - Versão “premium”: findCATMatches({ catsCol, chunksCol }, textoAlvo, limit, localFiles, { companyId })
 *  - Versão “mínima”:  findCATMatches(texto, patterns?)  → faz fallback para ranquear arquivos locais
 */
async function safeFindCATMatches(contextOrNull, textoAlvo, limit = 10, localFilesText = [], opts = {}) {
  // Tentativa 1: assinatura “premium”
  try {
    if (contextOrNull && typeof findCATMatches === 'function') {
      const maybe = await findCATMatches(contextOrNull, textoAlvo, limit, localFilesText, opts);
      if (Array.isArray(maybe)) return maybe;
    }
  } catch (err) {
    // cai para fallback
  }

  // Tentativa 2: assinatura “mínima” (ex.: findCATMatches(text, patterns))
  try {
    if (typeof findCATMatches === 'function') {
      const maybe = await findCATMatches(textoAlvo, []); // patterns vazios → sem erro
      if (Array.isArray(maybe)) {
        // Mesmo assim, não temos CAT “meta”; ranquear locais:
        return rankFromLocalOnly(textoAlvo, limit, localFilesText);
      }
    }
  } catch (err) {
    // cai para fallback
  }

  // Fallback final: ranquear apenas arquivos locais
  return rankFromLocalOnly(textoAlvo, limit, localFilesText);
}

/** Ranquear “CATs” a partir dos próprios arquivos locais (texto bruto como meta) */
function rankFromLocalOnly(textoAlvo, limit, localFilesText = []) {
  const pool = [];
  for (const f of localFilesText) {
    if (!f?.text) continue;
    const meta = {
      raw: f.text,
      escopo: f.text.slice(0, 1500),
      nomeCAT: f.source || 'local',
      fileName: f.source || 'local',
      ano: pickReasonableYear(f.text) || '',
      hasART: /(^|\W)ART(\W|$)/i.test(f.text),
      hasCREA: /(^|\W)CREA|CAU(\W|$)/i.test(f.text),
      orgao: null,
      catNum: null,
    };
    const score = scoreCatToObjetoLote(meta, textoAlvo, '');
    pool.push({ meta, score });
  }
  return pool
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p) => p.meta);
}

/* ===================== helper de ranking por lote ===================== */
async function rankCatsFor(textoAlvo, opts) {
  const { catsCol, chunksCol, localFilesText, companyId } = opts || {};
  const raw = await safeFindCATMatches(
    (catsCol || chunksCol) ? { catsCol, chunksCol } : null,
    textoAlvo || '',
    10,
    localFilesText || [],
    { companyId }
  );

  const dedup = uniqueByCat(raw || []).map((c) => ({
    ...c,
    ano: pickReasonableYear(c.raw) || c.ano || '',
  }));

  const ranked = dedup
    .map((c) => ({
      meta: c,
      score: scoreCatToObjetoLote(c, textoAlvo || '', ''),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, 3);
}

/* ============================ CORE ============================ */
async function analisarEditalCore(files, onProgress = () => {}, opts = {}) {
  const { companyId } = opts || {};
  const bump = (pct, phase) => {
    try { onProgress(pct, phase); } catch (_) {}
  };

  // Mongo (acesso a cats + chunks) — opcional
  let catsCol = null;
  let chunksCol = null;
  try {
    const db = await getDb();
    if (db) {
      catsCol = db.collection('cats');     // CATs completas
      chunksCol = db.collection('chunks'); // OCR/embeddings
    }
  } catch (_) {
    // sem DB → seguimos com fallback
  }

  // Perfil empresa — opcional
  let companyProfile = null;
  if (companyId) {
    try {
      companyProfile = await Companies.findById(companyId);
    } catch (_) {}
  }

  const mainEditalFile = files?.mainEditalFile;
  const annexFiles = files?.annexFiles || [];
  const allFiles = [mainEditalFile, ...annexFiles].filter(Boolean);

  if (!mainEditalFile?.path) {
    throw new Error('Arquivo principal do edital não informado.');
  }

  try {
    /* ========== OCR do edital principal ========== */
    const rawPdf = fs.readFileSync(mainEditalFile.path);
    const mainText = await extractTextFromPdf(rawPdf, mainEditalFile.path);
    if (!mainText?.trim()) throw new Error('Falha ao extrair texto do edital.');
    const editalText = mainText.slice(0, MAX_EDITALTEXT_CHARS);
    bump(15, 'OCR do edital');

    /* ========== OCR de todos arquivos locais (para evidências/fallback) ========== */
    const localFilesText = [];
    for (const f of allFiles) {
      try {
        const txt = await extractTextFromPdf(fs.readFileSync(f.path), f.path);
        localFilesText.push({ source: f.originalname || path.basename(f.path), text: txt || '' });
      } catch (_) {
        // segue
      }
    }
    bump(25, 'Textos locais prontos');

    /* ========== Cabeçalho simplificado ========== */
    const T = editalText;
    const take = (rx, max = 1200) => {
      const m = T.match(rx);
      return m ? String(m[0]).slice(0, max) : '';
    };

    // Pega do bloco “OBJETO” (ou primeiras linhas se não achar)
    const objetoBlock =
      take(/(?:\bDO?\s+OBJETO\b[\s\S]{0,2000})|(?:\bOBJETO\b[\s\S]{0,2000})/i, 2000) ||
      T.slice(0, 2000);

    // Pega Lotes (até 6 linhas)
    const lotesSnippet = (() => {
      const lotes = [];
      const rx = /(?:^|\n)\s*(?:LOTE|Lote)\s*(\d+)\s*[:\-–]\s*([\s\S]{0,300})/gi;
      let m;
      let cap = 0;
      while ((m = rx.exec(T)) && cap < 6) {
        lotes.push(`Lote ${m[1]}: ${m[2].trim().replace(/\s+/g, ' ')}`);
        cap++;
      }
      return lotes.join('\n');
    })();

    const header = {
      objetoLicitado: String(objetoBlock || '').trim(),
      resumoLotes: lotesSnippet,
    };
    bump(30, 'Cabeçalho extraído');

    /* ========== Busca global de CATs (objeto + lotes) ========== */
    const domainProbe = [header.objetoLicitado, header.resumoLotes].filter(Boolean).join('\n') || editalText;

    const allCatsRaw = await safeFindCATMatches(
      (catsCol || chunksCol) ? { catsCol, chunksCol } : null,
      domainProbe,
      15,
      localFilesText,
      { companyId }
    );

    const dedupCats = uniqueByCat(allCatsRaw || []).map((c) => ({
      ...c,
      ano: pickReasonableYear(c.raw) || c.ano || '',
    }));

    const objetoBase = [header.objetoLicitado, header.resumoLotes].filter(Boolean).join('\n') || editalText;

    const preRank = dedupCats.map((c) => ({
      meta: c,
      score: scoreCatToObjetoLote(c, objetoBase, ''),
    }));

    const rankedCats = preRank.sort((a, b) => b.score - a.score).slice(0, 5);
    const topCats = rankedCats.map((r) => r.meta);
    const domainAligned = rankedCats.some((r) => (r.score || 0) >= 0.35); // limiar suavizado 0–1
    bump(60, 'CATs selecionadas');

    /* ========== Análise de requisitos ========== */
    const allRequirements = await extractRequirementsFromBid(editalText);
    const requirementsToAnalyze = (allRequirements || []).filter(
      (r) => !/credenciamento|chave|senha|licitanet|comprasnet|bll|enviar proposta/i.test(r || '')
    );

    const detailedAnalyses = [];
    const techBlocks = [];
    const adminBlocks = [];

    const maxScore = rankedCats[0]?.score || 1;

    for (const reqTxt of requirementsToAnalyze) {
      const isTech = TECH_REQ_RX.test((reqTxt || '').toLowerCase());
      if (isTech) {
        if (topCats.length > 0) {
          const bullets = rankedCats
            .map((r) => {
              const c = r.meta || {};
              const tags = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
                .filter(Boolean)
                .join(' · ');
              const conf = Math.round(
                Math.min(97, Math.max(55, ((r.score || 0.01) / (maxScore || 1)) * 100))
              );
              return `- ${c.nomeCAT || c.fileName || '(CAT)'}${c.ano ? ` (${c.ano})` : ''} — ${tags || '—'} — **conf.: ${conf}%**`;
            })
            .join('\n');

          const status = domainAligned ? '🟢 ATENDIDO.' : '🟡 ATENDIDO PARCIALMENTE.';
          const block = `Requisito: ${reqTxt}\n\n${status}\n\n${bullets || '- (sem CATs listadas)'}`;
          detailedAnalyses.push(block);
          techBlocks.push(block);
        } else {
          const block = `Requisito: ${reqTxt}\n\n🔴 **NÃO ATENDIDO** — Sem CATs aderentes.`;
          detailedAnalyses.push(block);
          techBlocks.push(block);
        }
      } else {
        let block;
        if (companyProfile) {
          block = await analyzeRequirementWithContext(reqTxt, null, companyProfile);
        } else {
          const evidence = await findEvidenceOnTheFly(reqTxt, localFilesText, chunksCol);
          block = await analyzeRequirementWithContext(reqTxt, evidence, null);
        }
        detailedAnalyses.push(block);
        adminBlocks.push(block);
      }
    }

    /* ======= Viabilidade Técnica ======= */
    const blocoViabilidade = topCats.length
      ? `### Viabilidade profissional e técnica

Com base no acervo (CATs), identificamos ${
          domainAligned ? '**aderência técnica direta**' : '**aderência parcial**'
        }:

${topCats
  .map((c) => {
    const comp = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
      .filter(Boolean)
      .join(' · ');
    return `- ${c.nomeCAT || c.fileName || '(CAT)'} | ${c.orgao || '-'} | ${c.ano || '-'}
  - **Escopo:** ${c.escopo ? String(c.escopo).slice(0, 600) : '-'}
  - **Comprovações:** ${comp || '—'}`;
  })
  .join('\n\n')}`
      : '### Viabilidade profissional e técnica\n\n- Nenhuma CAT aderente encontrada.';

    /* ======= Lotes: aderência individual ======= */
    const lotesAnalise = [];
    if (header.resumoLotes) {
      const lotes = header.resumoLotes.split(/\n+/).filter(Boolean);
      for (const linha of lotes) {
        const top = await rankCatsFor(linha, { catsCol, chunksCol, localFilesText, companyId });
        const max = top[0]?.score || 1;
        const bullets =
          top
            .map((r) => {
              const c = r.meta || {};
              const conf = Math.round(Math.min(97, Math.max(55, ((r.score || 0.01) / (max || 1)) * 100)));
              const tags = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
                .filter(Boolean)
                .join(' · ');
              return `- ${c.nomeCAT || c.fileName || '(CAT)'}${c.ano ? ` (${c.ano})` : ''} — ${tags || '—'} — **conf.: ${conf}%**`;
            })
            .join('\n') || '- (sem CATs aderentes)';
        lotesAnalise.push({
          titulo: linha.replace(/^\s*Lote\s*\d+\s*[:\-–]\s*/i, '').trim(),
          bullets,
        });
      }
    }

    const blocoLotes = lotesAnalise.length
      ? ['## Aderência por Lote', ...lotesAnalise.map((l) => `### ${l.titulo}\n${l.bullets}`)].join('\n\n')
      : '';

    // RT sugerido (baseado no objeto geral)
    let blocoRT = '';
    if (topCats.length) {
      const rtSugerido = suggestBestRT(
        topCats.map((c) => ({ profissional: c.profissional || c.titular || '—', conselho: c.conselho || c.orgao, cat: c })),
        header.objetoLicitado || editalText
      );
      if (rtSugerido) {
        const chosenCat = topCats[0];
        const comp = compareReqVsCat([header.objetoLicitado, header.resumoLotes].filter(Boolean).join('\n'), chosenCat?.raw || '');
        blocoRT = [
          '### Responsável Técnico Sugerido',
          `**Nome:** ${rtSugerido.profissional || '—'}`,
          `**CAT nº / Ano / Órgão:** ${chosenCat?.catNum || '—'} / ${chosenCat?.ano || '—'} / ${chosenCat?.orgao || '—'}`,
          `**Escopo (resumo):** ${chosenCat?.escopo ? String(chosenCat.escopo).slice(0, 600) : '—'}`,
          `**Fonte (arquivo):** ${chosenCat?.nomeCAT || chosenCat?.fileName || '—'}`,
          '',
          '#### Comprovação frente ao edital',
          comp.length ? comp.map((l) => `- ${l}`).join('\n') : '- (Sem parâmetros comparáveis explícitos)',
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
      detailedAnalyses.join('\n\n---\n\n') || '- (não gerado)',
    ].join('\n\n');

    const { publicUrl, filePath, filename } = await gerarPdf(finalReport, companyId);
    bump(100, 'PDF emitido');

    // limpar arquivos temporários
    for (const f of allFiles) {
      try {
        if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch (_) {}
    }

    return { report: finalReport, pdf: { filename, url: publicUrl, path: filePath } };
  } catch (err) {
    console.error('[analisarEditalCore] erro:', err);
    for (const f of allFiles) {
      try {
        if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch (_) {}
    }
    throw err;
  }
}

module.exports = { analisarEditalCore, gerarPdf };
