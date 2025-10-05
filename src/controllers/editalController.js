// src/controllers/editalController.js
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const PDFDocument = require('pdfkit');
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
  signaturesFor,
  hasDomainOverlap
} = require('../services/cats');

/* ============ Diretório de relatórios ============ */
const REPORTS_DIR = path.resolve(process.cwd(), 'data', 'reports');

/* ============ Helpers de formatação/parse ============ */
function normalizeField(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!s || s === '-' || s.toLowerCase() === 'para' || s.toLowerCase().includes('integrante da administração')) return '';
  return s.replace(/\s{2,}/g, ' ');
}
function stripLine(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

/* Limpa poluição de OCR no "OBJETO" e limita tamanho */
function tidyObjeto(s = '', max = 300) {
  const cleaned = String(s)
    .replace(/^\s*\d+\s*\/\s*\d+\s*$/gm, '')      // "2/23"
    .replace(/AVISO DE LICITA[ÇC][AÃ]O[\s\S]*$/i, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned;
}

function extractObjeto(editalText = '') {
  const t = editalText;
  const rxBlocks = [
    /(?:^|\n)\s*(?:DO\s+OBJETO|OBJETO(?:\s+LICITADO)?|CL[ÁA]USULA\s+\d+\s*-\s*OBJETO)\s*[:\-]?\s*\n([\s\S]{1,1200}?)(?:\n\s*(?:CL[ÁA]USULA|ITEM|CAP[ÍI]TULO|SE[ÇC][AÃ]O)\b|$)/i,
    /Objeto(?:\s+licitado)?\s*[:\-]\s*([\s\S]{1,1200}?)(?:\n{2,}|ITEM|CL[ÁA]USULA|$)/i
  ];
  for (const rx of rxBlocks) { const m = t.match(rx); if (m?.[1]) return stripLine(m[1]); }
  const near = t.split(/\n+/).find(l => /objeto/i.test(l));
  return stripLine(near || '');
}

function parseBidHeader(editalText = '') {
  const get1 = (re) => (editalText.match(re)?.[1] || '');
  const objetoBruto = extractObjeto(editalText);
  return {
    orgaoLicitante: normalizeField(
      get1(/(?:Órg[ãa]o\s+Licitante|ENTIDADE\s+CONTRATANTE|CONTRATANTE|ÓRG[ÃA]O)[:\s]+(.+?)(?:\n|$)/i)
      || get1(/(?:Cliente|Promotor(?:a)?|Contratante)\s*[:\-]\s*(.+?)(?:\n|$)/i)
    ),
    concorrenciaEletronica: normalizeField(
      get1(/(CONCORR[ÊE]NCIA\s+ELETR[ÔO]NICA[^\n]*)(?:\n|$)/i)
      || get1(/(Preg[aã]o\s+Eletr[ôo]nico\s*N[ºo]\s*[^\n]+)(?:\n|$)/i)
      || get1(/(?:Preg[aã]o|Concorr[êe]ncia|Tomada de Pre[çc]os)[^\n]{0,80}(?:\n|$)/i)
    ),
    tipo: normalizeField(
      get1(/Tipo\s*[:\-]\s*(.+?)(?:\n|$)/i)
      || get1(/TIPO\s*DE\s*JULGAMENTO\s*[:\-]\s*(.+?)(?:\n|$)/i)
      || get1(/Criteri[oa]\s*de\s*Julgamento\s*[:\-]\s*(.+?)(?:\n|$)/i)
    ),
    prazoExecucao: normalizeField(
      get1(/Prazo\s+de\s+execu[cç][aã]o[^:]*[:\-\s]+(.+?)(?:\n|$)/i)
      || get1(/Vig[êe]ncia\s*[:\-]\s*(.+?)(?:\n|$)/i)
    ),
    classificacaoDespesaEValor: normalizeField(
      [
        get1(/Classifica[cç][aã]o\s+de\s+Despesa\s*[:\-\s]+(.+?)(?:\n|$)/i),
        get1(/(?:Valor\s+Estimado|Valor\s+do\s+Objeto|Or[çc]amento\s+Estimado)[^\n]*[:\-\s]+(.+?)(?:\n|$)/i)
      ].filter(Boolean).join(' | ')
    ),
    objetoLicitado: tidyObjeto(objetoBruto),
    prazoMaximoParaProposta: normalizeField(
      get1(/Prazo\s+m[aá]ximo\s+para\s+proposta\s*[:\-\s]+(.+?)(?:\n|$)/i)
      || get1(/Data\s+limite\s+para\s+propostas\s*[:\-\s]+(.+?)(?:\n|$)/i)
    ),
  };
}

/* ============ PDF helpers ============ */
function cleanTextForPdf(text = '') {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ====== Parser de blocos (para "keep-together") ======
 * Tipos:
 * - heading:  #, ##, ###
 * - badge:    inicia com 🟢/🟡/🔴
 * - listItem: item "- ..." e subitens "  - ..." unidos como um bloco
 * - paragraph: parágrafo comum
 * - spacer: linha vazia
 */
function chunkMarkdownToBlocks(md) {
  const rawLines = cleanTextForPdf(md).split('\n');
  const blocks = [];
  let i = 0;

  const isBlank = (s) => !s || /^\s*$/.test(s);
  const isHeading = (s) => /^(#{1,3})\s+/.test(s);
  const headingLevel = (s) => ((s.match(/^(#{1,3})\s+/) || [,''])[1] || '').length;
  const isBadge = (s) => /^[🟢🟡🔴]/.test(s);
  const isTopBullet = (s) => /^-\s+/.test(s);
  const isSubBullet = (s) => /^ {2,}-\s+/.test(s);

  while (i < rawLines.length) {
    const line = rawLines[i];

    if (isBlank(line)) {
      blocks.push({ type: 'spacer', lines: [''] });
      i += 1;
      continue;
    }

    if (isHeading(line)) {
      blocks.push({ type: 'heading', level: headingLevel(line), lines: [line.replace(/^#{1,3}\s+/, '')] });
      i += 1;
      continue;
    }

    if (isBadge(line)) {
      blocks.push({ type: 'badge', lines: [line] });
      i += 1;
      continue;
    }

    if (isTopBullet(line)) {
      // junta este item + subitens imediatamente seguintes
      const lines = [line];
      let j = i + 1;
      while (j < rawLines.length) {
        if (isSubBullet(rawLines[j])) { lines.push(rawLines[j]); j++; continue; }
        // se vier outro top-level bullet imediatamente, encerra bloco atual
        if (isTopBullet(rawLines[j])) break;
        // se vier linha vazia, encerra bloco
        if (isBlank(rawLines[j]) || isHeading(rawLines[j]) || isBadge(rawLines[j])) break;
        // se vier parágrafo, também termina (mantemos como bloco separado)
        break;
      }
      blocks.push({ type: 'listItem', lines });
      i = j;
      continue;
    }

    // parágrafo: consome até linha vazia ou heading/badge/list
    const lines = [line];
    let j = i + 1;
    while (j < rawLines.length) {
      if (isBlank(rawLines[j]) || isHeading(rawLines[j]) || isBadge(rawLines[j]) || isTopBullet(rawLines[j]) || isSubBullet(rawLines[j])) break;
      lines.push(rawLines[j]);
      j++;
    }
    blocks.push({ type: 'paragraph', lines });
    i = j;
  }

  return blocks;
}

/* ========== Render com "keep-together" por bloco ========== */
function renderBlocksKeepTogether(doc, md, width) {
  const blocks = chunkMarkdownToBlocks(md);

  const LINE_GAP = 2;
  const TOP_INDENT = 8;
  const SUB_INDENT = 18;

  // util: espaço restante na página
  const spaceLeft = () => doc.page.height - doc.page.margins.bottom - doc.y;

  // mede altura aproximada do bloco usando heightOfString
  const measureBlock = (b) => {
    doc.font('Helvetica').fontSize(11); // padrão
    switch (b.type) {
      case 'spacer':
        return 6;
      case 'heading': {
        const size = b.level === 1 ? 16 : (b.level === 2 ? 13 : 12);
        doc.font(b.level === 1 ? 'Helvetica-Bold' : 'Helvetica-Bold').fontSize(size);
        const h = doc.heightOfString(b.lines.join('\n'), { width, lineGap: LINE_GAP });
        doc.font('Helvetica').fontSize(11);
        return h + 4;
      }
      case 'badge': {
        // texto com margem para bolinha
        const text = b.lines.join('\n').replace(/^[^\s]+\s*/, '');
        const h = doc.heightOfString(text, { width: width - 12, lineGap: LINE_GAP });
        return h + 10; // 10px para a bolinha e respiro
      }
      case 'listItem': {
        let h = 0;
        for (const ln of b.lines) {
          if (/^-\s+/.test(ln)) {
            const t = '• ' + ln.replace(/^-\s+/, '');
            h += doc.heightOfString(t, { width, lineGap: LINE_GAP });
          } else {
            const t = '• ' + ln.replace(/^ {2,}-\s+/, '');
            h += doc.heightOfString(t, { width: width - SUB_INDENT, lineGap: LINE_GAP });
          }
        }
        return h + 4;
      }
      case 'paragraph': {
        const t = b.lines.join('\n');
        return doc.heightOfString(t, { width, lineGap: LINE_GAP }) + 2;
      }
      default:
        return doc.heightOfString(b.lines.join('\n'), { width, lineGap: LINE_GAP });
    }
  };

  // escreve bloco (sabendo que cabe)
  const renderBlock = (b) => {
    doc.fillColor('#000').font('Helvetica').fontSize(11);

    switch (b.type) {
      case 'spacer':
        doc.moveDown(0.35);
        return;

      case 'heading': {
        const size = b.level === 1 ? 16 : (b.level === 2 ? 13 : 12);
        doc.font('Helvetica-Bold').fontSize(size);
        doc.text(b.lines.join('\n'), { width, align: 'left', lineGap: LINE_GAP });
        doc.font('Helvetica').fontSize(11);
        if (b.level === 1) doc.moveDown(0.15);
        return;
      }

      case 'badge': {
        const raw = b.lines[0] || '';
        const color = raw.startsWith('🟢') ? '#22c55e' : raw.startsWith('🟡') ? '#f59e0b' : '#ef4444';
        const text = raw.replace(/^[^\s]+\s*/, '');
        const x = doc.x, y = doc.y + 5;
        doc.save().circle(x + 4, y, 4).fill(color).restore();
        doc.fillColor('#000');
        doc.text(text, x + 12, doc.y, { width: width - 12, align: 'left', lineGap: LINE_GAP });
        doc.fillColor('#000');
        return;
      }

      case 'listItem': {
        for (const ln of b.lines) {
          if (/^-\s+/.test(ln)) {
            const t = '• ' + ln.replace(/^-\s+/, '');
            doc.text(t, { width, align: 'left', lineGap: LINE_GAP, indent: TOP_INDENT });
          } else {
            const t = '• ' + ln.replace(/^ {2,}-\s+/, '');
            const x = doc.x + SUB_INDENT;
            const y = doc.y;
            doc.text(t, x, y, { width: width - SUB_INDENT, align: 'left', lineGap: LINE_GAP });
          }
        }
        return;
      }

      case 'paragraph': {
        // negrito inline simples **...**
        const line = b.lines.join('\n');
        const parts = line.split(/\*\*(.+?)\*\*/g);
        for (let i = 0; i < parts.length; i++) {
          const chunk = parts[i];
          if (!chunk) continue;
          doc.font(i % 2 ? 'Helvetica-Bold' : 'Helvetica');
          doc.text(chunk, { width, continued: i < parts.length - 1, lineGap: LINE_GAP });
        }
        doc.text('');
        return;
      }
    }
  };

  for (const block of blocks) {
    const h = measureBlock(block);
    if (h > spaceLeft()) doc.addPage();
    renderBlock(block);
  }
}

/* quebra “Análise Detalhada” em nova página */
function renderMdWithLogicalBreak(doc, md, width) {
  const SPLIT = '\n## Análise Detalhada';
  if (!md.includes(SPLIT)) {
    renderBlocksKeepTogether(doc, md, width);
    return;
  }
  const [a, b] = md.split(SPLIT);
  renderBlocksKeepTogether(doc, a, width);
  doc.addPage();
  renderBlocksKeepTogether(doc, '## Análise Detalhada' + b, width);
}

async function gerarPdf(markdown) {
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  const filename = `relatorio_viabilidade_${Date.now()}.pdf`;
  const outPath = path.join(REPORTS_DIR, filename);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // reset a cada página
  doc.on('pageAdded', () => {
    doc.font('Helvetica').fontSize(11).fillColor('#000');
  });

  // Título
  doc.font('Helvetica-Bold').fontSize(16)
     .text('RELATÓRIO DE VIABILIDADE', { align: 'center', width: contentWidth, lineGap: 2 });
  doc.moveDown(0.4);

  // Corpo
  doc.font('Helvetica').fontSize(11).fillColor('#000');
  renderMdWithLogicalBreak(doc, markdown || '-', contentWidth);

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve({
      filePath: outPath,
      publicUrl: `/api/edital/report/${filename}`,
      filename
    }));
    stream.on('error', reject);
  });
}

/* ============ PROGRESS LOGGER ============ */
function makeProgressLogger() {
  const WEIGHTS = { OCR: 15, HEADER: 5, FILES_TEXT: 10, CAT_SEARCH: 40, REQUIREMENTS: 20, SUMMARY: 5, PDF: 5 };
  let pct = 0;
  const log = (msg) => console.log(`[analisarEdital] ${msg}`);
  const bump = (delta, msg) => { pct = Math.min(100, pct + delta); log(`[${pct.toFixed(1)}%] ${msg}`); };
  const phase = (name, msg) => bump(WEIGHTS[name] || 0, msg || `Fase ${name} concluída`);
  const sub = (name, total) => {
    const weight = WEIGHTS[name] || 0; let done = 0; total = Math.max(1, Number(total) || 1);
    return (i, msg) => {
      i = Math.min(i, total);
      const inc = ((i - done) / total) * weight; done = i; pct = Math.min(100, pct + inc);
      log(`[${pct.toFixed(1)}%] ${name} ${(i / total * 100).toFixed(0)}% — ${msg || ''}`);
    };
  };
  const get = () => pct;
  return { bump, phase, sub, get, log, WEIGHTS };
}

/* ======= indicador ponderado (técnico 60% / documental 40%) ======= */
function parseStatusFromText(block = '') {
  const t = (block || '').toLowerCase();
  if (/não atendido|nao atendido|🔴/i.test(t)) return 'NAO';
  if (/atendido parcialmente|🟡/i.test(t)) return 'PARCIAL';
  if (/atendido|🟢/i.test(t)) return 'OK';
  return 'PARCIAL';
}
function computeWeightedIndicators(items) {
  const tech = items.filter(i => i.kind === 'TECH');
  const doc  = items.filter(i => i.kind === 'DOC');
  const count = (arr, st) => arr.filter(i => i.status === st).length;

  const okT = count(tech, 'OK'), paT = count(tech, 'PARCIAL'), naT = count(tech, 'NAO');
  const okD = count(doc,  'OK'), paD = count(doc,  'PARCIAL'), naD = count(doc,  'NAO');

  const score = (ok, parcial, total) => total ? (ok + 0.5 * parcial) / total : 0;
  const techScore = score(okT, paT, tech.length);
  const docScore  = score(okD, paD, doc.length);

  const finalPct = Math.round((0.6 * techScore + 0.4 * docScore) * 100);

  return {
    counts: { ok: okT + okD, parcial: paT + paD, nao: naT + naD },
    tech:   { ok: okT, parcial: paT, nao: naT, pct: Math.round(techScore * 100) },
    doc:    { ok: okD, parcial: paD, nao: naD, pct: Math.round(docScore * 100) },
    pct: finalPct
  };
}
function recomendacaoByPct(pct) {
  if (pct >= 75) return { label: '🟢 PARTICIPAÇÃO RECOMENDADA', cor: 'verde' };
  if (pct >= 60) return { label: '🟡 PARTICIPAÇÃO RECOMENDADA COM AJUSTES', cor: 'amarelo' };
  if (pct >= 40) return { label: '🟠 AVALIAR E REGISTRAR RISCOS', cor: 'laranja' };
  return { label: '🔴 PARTICIPAÇÃO NÃO RECOMENDADA', cor: 'vermelho' };
}

/* ===== regex amplo para reconhecer requisitos TÉCNICOS ===== */
const TECH_REQ_RX =
  /\b(cat(?:s)?|capacidade\s+t[eé]cnica|capacit[aã]o\s+t[eé]cnica|atestado(?:s)?\s+de?\s+capacidade|acervo\s+t[eé]cnico|experi[êe]ncia(?:\s+t[eé]cnica)?|respons[aá]vel\s+t[eé]cnico|(?:\b|^)RT\b)\b/i;

/* ============ CONTROLLER principal ============ */
async function analisarEdital(req, res) {
  const PROGRESS = makeProgressLogger();

  if (!req.files || !req.files.editalPdf || req.files.editalPdf.length !== 1) {
    return res.status(400).json({ error: 'Envie exatamente 1 arquivo PDF do edital (campo: editalPdf).' });
  }

  const mainEditalFile = req.files.editalPdf[0];
  const annexFiles = req.files['arquivos[]'] || [];
  console.log(`\n-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=`);
  console.log(`[${new Date().toLocaleString('pt-BR')}] Nova análise: ${mainEditalFile.originalname} (+${annexFiles.length} anexos)`);

  // Mongo opcional
  let catsCol = null, chunksCol = null;
  try {
    const db = await getDb();
    chunksCol = db.collection('chunks');
    catsCol   = db.collection('cats');
    console.log(`[Mongo] OK: "chunks" e "cats" prontos para consulta.`);
  } catch (e) {
    console.error('[Mongo] ERRO ao conectar. Segue análise apenas com arquivos locais:', e.message);
  }

  try {
    // OCR
    const rawPdf = fs.readFileSync(mainEditalFile.path);
    const mainEditalText = await extractTextFromPdf(rawPdf, mainEditalFile.path);
    if (!mainEditalText?.trim()) {
      return res.status(400).json({ error: 'Não foi possível extrair texto do PDF principal.' });
    }
    const editalText = mainEditalText.slice(0, MAX_EDITALTEXT_CHARS || 200000);
    PROGRESS.phase('OCR', `Texto do edital extraído (${editalText.length.toLocaleString('pt-BR')} chars)`);

    // Header
    const header = parseBidHeader(editalText);
    const objSigs = signaturesFor(header.objetoLicitado || editalText);
    PROGRESS.phase('HEADER', `Cabeçalho extraído | Sigs(objeto): [${objSigs.join(', ')}]`);

    // Arquivos para evidências
    const filesForEvidenceSearch = await Promise.all(
      [mainEditalFile, ...annexFiles].map(async (file) => ({
        source: file.originalname,
        getText: async () => extractTextFromPdf(fs.readFileSync(file.path), file.path)
      }))
    );

    // Texto local
    const subFilesTick = PROGRESS.sub('FILES_TEXT', filesForEvidenceSearch.length);
    const localFilesText = [];
    for (let i = 0; i < filesForEvidenceSearch.length; i++) {
      const f = filesForEvidenceSearch[i];
      try {
        const txt = await f.getText();
        localFilesText.push({ source: f.source, text: txt || '' });
        subFilesTick(i + 1, `OCR local: ${f.source}`);
      } catch (e) {
        console.warn(`[OCR local] Falha ao extrair "${f.source}":`, e.message);
        subFilesTick(i + 1, `OCR local: ${f.source} (falhou)`);
      }
    }

    // CATs combinadas
    let totalCandidatesEstimate = 1;
    const catSearchTick = PROGRESS.sub('CAT_SEARCH', () => totalCandidatesEstimate);
    const allCatsRaw = await findCATMatches(
      (catsCol || chunksCol) ? { catsCol, chunksCol } : null,
      header.objetoLicitado || editalText,
      8,
      localFilesText,
      {
        debug: (evt) => {
          try {
            if (evt.kind === 'mongoBatchCats') { totalCandidatesEstimate += Math.max(0, evt.total); }
            if (evt.kind === 'mongoItemCats')   { catSearchTick(Math.min(evt.i, totalCandidatesEstimate), `Analisando (CATS) ${evt.source}`); }
            if (evt.kind === 'mongoBatchChunks'){ totalCandidatesEstimate += Math.max(0, evt.total); }
            if (evt.kind === 'mongoItemChunks'){ catSearchTick(Math.min(evt.i, totalCandidatesEstimate), `Analisando (CHUNKS) ${evt.source}`); }
            if (evt.kind === 'localBatch')      { totalCandidatesEstimate += evt.total; }
            if (evt.kind === 'localItem')       { catSearchTick(Math.min(evt.i + (evt.offset || 0), totalCandidatesEstimate), `Analisando (Local) ${evt.source}`); }
          } catch {}
        }
      }
    );

    const dedupCats = uniqueByCat(allCatsRaw).map(c => ({ ...c, ano: pickReasonableYear(c.raw) || c.ano || '' }));
    const loteTexto = (header.concorrenciaEletronica || '') + '\n' + (header.tipo || '');
    const ranked = dedupCats.map(c => ({ meta: c, score: scoreCatToObjetoLote(c, header.objetoLicitado || editalText, loteTexto) }))
                            .sort((a,b)=>b.score-a.score);

    const objHasDomain = signaturesFor(header.objetoLicitado || editalText).length > 0;
    const MIN_ALIGN_SCORE = objHasDomain ? 5 : 3;

    const rankedCatsDomain = ranked.map(r => r.meta)
      .filter(c => objHasDomain ? hasDomainOverlap(header.objetoLicitado || editalText, c.raw || '', c.fileName || '') : true);

    const rescored = rankedCatsDomain.map(c => ({ meta: c, score: scoreCatToObjetoLote(c, header.objetoLicitado || editalText, loteTexto) }))
                                     .sort((a,b)=>b.score-a.score);

    const filtered = rescored.filter(r => r.score >= MIN_ALIGN_SCORE);
    const topCats = filtered.slice(0, 2).map(r => r.meta);
    const domainAligned = filtered.length > 0;

    // Requisitos
    const allRequirements = await extractRequirementsFromBid(editalText);
    const requirementsToAnalyze = (allRequirements || [])
      .filter(r => !/credenciamento|chave|senha|licitanet|comprasnet|bll|enviar proposta/i.test((r || '')));

    const analysesMd = [];
    const results = [];
    const reqTick = PROGRESS.sub('REQUIREMENTS', Math.max(1, requirementsToAnalyze.length));

    for (let i = 0; i < requirementsToAnalyze.length; i++) {
      const reqTxt = requirementsToAnalyze[i];
      if (!reqTxt) { reqTick(i + 1, 'requisito vazio'); continue; }

      const isTech = TECH_REQ_RX.test(reqTxt);

      if (isTech && topCats.length > 0) {
        const bullets = topCats.map(c => {
          const tags = [
            c.catNum ? `CAT nº ${c.catNum}` : (c.fileHints?.fileCatNum ? `CAT nº ${c.fileHints.fileCatNum}` : null),
            c.hasART ? 'ART' : null,
            c.hasCREA ? 'CREA/CAU' : null
          ].filter(Boolean).join(' · ');
          const label = `${c.nomeCAT || c.fileName || c.source}${c.ano ? ` (${c.ano})` : (c.fileHints?.fileYear ? ` (${c.fileHints.fileYear})` : '')}`;
          return `- ${label} — ${tags || '—'}`;
        }).join('\n');

        const statusTxt = domainAligned ? '🟢 ATENDIDO.' : '🟡 ATENDIDO PARCIALMENTE.';
        const note = domainAligned ? '' : '\n\n> Observação: CATs localizadas com aderência parcial; ideal substituir por CATs do mesmo escopo do edital.';
        const block = `Requisito: ${reqTxt}\n\n${statusTxt}\n\nA qualificação técnica é suportada por:\n${bullets}${note}`;

        analysesMd.push(block);
        results.push({ kind: 'TECH', status: domainAligned ? 'OK' : 'PARCIAL', req: reqTxt });
        reqTick(i + 1, 'análise com CATs do topo');
        continue;
      }

      const evidence = await findEvidenceOnTheFly(reqTxt, filesForEvidenceSearch, chunksCol);
      const block = await analyzeSingleRequirement(reqTxt, evidence);
      analysesMd.push(block);
      results.push({ kind: 'DOC', status: parseStatusFromText(block), req: reqTxt });
      reqTick(i + 1, 'análise por evidências');
    }

    // Indicadores ponderados (60/40)
    const indic = computeWeightedIndicators(results);
    const rec = recomendacaoByPct(indic.pct);

    const indicadoresMd = [
      `### Resultado ponderado`,
      `**Recomendação:** ${rec.label}`,
      `**Indicadores gerais:** ${indic.counts.ok} OK • ${indic.counts.parcial} PARCIAL • ${indic.counts.nao} NÃO • **Atendimento global (ponderado): ${indic.pct}%**`,
      `**Técnico (60%):** ${indic.tech.ok} OK • ${indic.tech.parcial} PARCIAL • ${indic.tech.nao} NÃO — ${indic.tech.pct}%`,
      `**Documental (40%):** ${indic.doc.ok} OK • ${indic.doc.parcial} PARCIAL • ${indic.doc.nao} NÃO — ${indic.doc.pct}%`,
    ].join('\n\n');

    // Bloco Viabilidade (CATs)
    const blocoViabilidade = (topCats.length
      ? `### Viabilidade profissional e técnica\n\nCom base no acervo (CATs), identificamos ${domainAligned ? '**aderência técnica direta**' : '**aderência parcial**'} ao objeto licitado:\n\n${
          topCats.map(c => {
            const comp = [
              c.catNum ? `CAT nº ${c.catNum}` : (c.fileHints?.fileCatNum ? `CAT nº ${c.fileHints.fileCatNum}` : null),
              c.hasART ? 'ART' : null,
              c.hasCREA ? 'CREA/CAU' : null
            ].filter(Boolean).join(' · ');
            const head = [
              `**CAT:** ${c.nomeCAT || c.fileName || c.source}`,
              c.orgao ? `**Órgão/Entidade:** ${c.orgao}` : (c.fileHints?.fileOrgao ? `**Órgão/Entidade:** ${c.fileHints.fileOrgao}` : null),
              c.ano ? `**Ano:** ${c.ano}` : (c.fileHints?.fileYear ? `**Ano:** ${c.fileHints.fileYear}` : null)
            ].filter(Boolean).join(' | ');
            return `- ${head}\n  - **Escopo/Resumo:** ${c.escopo || '-'}\n  - **Comprovações:** ${comp || '—'}`;
          }).join('\n\n')
        }`
      : '### Viabilidade profissional e técnica\n\n- **Não localizamos CATs aderentes automaticamente.** Recomenda-se checagem manual do acervo.'
    );

    // RT sugerido
    const rtSugerido = suggestBestRT(topCats, header.objetoLicitado || editalText);
    let blocoRT = '';
    if (rtSugerido) {
      const reqBase = [header.objetoLicitado || '', ...(Array.isArray(allRequirements) ? allRequirements : [])].join('\n');
      const chosenCat = topCats.find(c => (c.nomeCAT || c.fileName) === rtSugerido.arquivo) || topCats[0];
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

    // Sumário executivo
    let summary = '';
    try {
      summary = await generateExecutiveSummary(analysesMd);
      PROGRESS.phase('SUMMARY', 'Sumário executivo gerado');
    } catch {
      summary = '- (Ocorreu um erro ao gerar o sumário executivo)';
      PROGRESS.phase('SUMMARY', 'Falha ao gerar sumário (continuando)');
    }

    // Patch dos indicadores dentro do bloco "Recomendação Final"
    const summaryPatched = summary.replace(
      /###\s*Recomendação Final[\s\S]*?(?=\n###|\n##|$)/i,
      (m) => {
        const base = m.trim().replace(/\n+$/,'');
        const extra = `\n\n**Indicadores (ponderado):** Técnico ${indic.tech.pct}% • Documental ${indic.doc.pct}% • **Global ${indic.pct}%**`;
        return base.includes('Indicadores (ponderado):') ? base : base + extra;
      }
    );

    // Cabeçalho (lista)
    const headerList = [
      `- **Órgão Licitório:** ${header.orgaoLicitante || '-'}`,
      `- **Concorrência Eletrônica:** ${header.concorrenciaEletronica || '-'}`,
      `- **Tipo:** ${header.tipo || '-'}`,
      `- **Prazo de execução:** ${header.prazoExecucao || '-'}`,
      `- **Classificação de Despesa e valor:** ${header.classificacaoDespesaEValor || '-'}`,
      `- **Objeto licitado:** ${header.objetoLicitado || '-'}`,
      `- **Prazo máximo para proposta:** ${header.prazoMaximoParaProposta || '-'}`,
    ].join('\n');

    // Relatório final
    const finalReport = [
      '# RELATÓRIO DE VIABILIDADE',
      '## Dados do edital',
      headerList,
      '',
      indicadoresMd,
      '',
      blocoViabilidade,
      blocoRT ? `\n${blocoRT}` : '',
      '',
      // o sumário já pode trazer "## Sumário Executivo" do service; mantemos
      summaryPatched,
      '',
      '## Análise Detalhada',
      analysesMd.join('\n\n') || '- (Não foi possível gerar a análise detalhada)'
    ].join('\n\n');

    const { publicUrl, filePath, filename } = await gerarPdf(finalReport);
    PROGRESS.phase('PDF', `PDF emitido em ${filePath}`);
    console.log(` -> Análise concluída! Progresso final: ${PROGRESS.get().toFixed(1)}%`);
    return res.json({ report: finalReport, pdf: { filename, url: publicUrl, path: filePath } });

  } catch (error) {
    console.error(' -> ❌ Erro:', error);
    return res.status(500).json({ error: 'Erro interno.', details: error.message });
  } finally {
    const allUploadedFiles = [
      ...(req.files?.editalPdf || []),
      ...((req.files && req.files['arquivos[]']) || [])
    ];
    for (const f of allUploadedFiles) { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} }
    console.log(`-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=\n`);
  }
}

/** POST /api/edital/gerar-pdf */
async function gerarPdfFromBody(req, res) {
  try {
    const { reportMd } = req.body || {};
    if (!reportMd || typeof reportMd !== 'string' || reportMd.trim().length < 5) {
      return res.status(400).json({ error: 'Campo "reportMd" é obrigatório (string com conteúdo).' });
    }
    const { publicUrl, filename } = await gerarPdf(reportMd);
    return res.json({ url: publicUrl, filename });
  } catch (e) {
    console.error('[gerarPdfFromBody] ERRO:', e);
    return res.status(500).json({ error: 'Falha ao gerar PDF.', details: e.message });
  }
}

/** GET /api/edital/analisar/history */
async function listarHistorico(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || '10', 10)));

    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    const files = await fsp.readdir(REPORTS_DIR);
    const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));

    const entries = await Promise.all(pdfFiles.map(async (name) => {
      const full = path.join(REPORTS_DIR, name);
      const stat = await fsp.stat(full).catch(() => null);
      const createdAt = stat ? stat.mtime : new Date();
      return {
        id: name,
        title: name.replace(/_/g, ' '),
        filename: name,
        pdfUrl: `/api/edital/report/${name}`,
        createdAt
      };
    }));

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = entries.length;
    const start = (page - 1) * pageSize;
    const items = entries.slice(start, start + pageSize);

    return res.json({ items, total, page, pageSize });
  } catch (e) {
    console.error('[listarHistorico] ERRO:', e);
    return res.status(500).json({ error: 'Falha ao listar histórico.', details: e.message });
  }
}

/** GET /api/edital/report/:name */
async function serveReportByName(req, res) {
  try {
    const raw = req.params.name || '';
    if (!raw || raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
      return res.status(400).send('Nome de arquivo inválido');
    }
    const filePath = path.join(REPORTS_DIR, raw);
    await fsp.access(filePath, fs.constants.R_OK);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.sendFile(filePath);
  } catch (e) {
    console.error('[serveReportByName] ERRO:', e.message);
    return res.status(404).send('PDF não encontrado');
  }
}

module.exports = {
  analisarEdital,
  gerarPdf,
  gerarPdfFromBody,
  listarHistorico,
  serveReportByName,
};
