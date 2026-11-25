// src/controllers/editalController.js
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const PDFDocument = require('pdfkit');
const Cats = require('../models/catModel');
const { MAX_EDITALTEXT_CHARS } = require('../Config/env');
const { extractTextFromPdf } = require('../utils/ocr');

const {
  extractRequirementsFromBid,
  analyzeRequirementWithContext,
  generateExecutiveSummary,
  findEvidenceOnTheFly,
  countEliminatoryFailures,
  computeSuccessProbability,
  renderSuccessBanner,
} = require('../services/evidence');

const {
  findCATMatches,
  uniqueByCat,
  scoreCatToObjetoLote,
  pickReasonableYear,
  suggestBestRT,
  compareReqVsCat,
  signaturesFor,
  detectDomain,          // detector de domínio
} = require('../services/cats');

/* ========= multi-tenant helpers ========= */
const DATA_ROOT = path.resolve(process.cwd(), 'data');
function getReportsDir(companyId) {
  return companyId
    ? path.join(DATA_ROOT, 'tenants', String(companyId), 'reports')
    : path.join(DATA_ROOT, 'reports');
}
function getTenantId(req) {
  return (req.auth && req.auth.companyId) || req.companyId || null;
}

/* ============ Helpers de formatação/parse ============ */
function normalizeField(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!s || s === '-' || s.toLowerCase() === 'para' || s.toLowerCase().includes('integrante da administração')) return '';
  return s.replace(/\s{2,}/g, ' ');
}
function stripLine(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

function tidyObjeto(s = '', max = 300) {
  const cleaned = String(s)
    .replace(/^\s*\d+\s*\/\s*\d+\s*$/gm, '')
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

/* ================== PDF helpers – layout melhorado ================== */

// ⚠️ Quebra agressiva de qualquer sequência sem espaços
function softBreakLongWords(text = '', minLen = 40, chunk = 12) {
  const ZWSP = '\u200B'; // zero-width space
  return String(text || '').replace(
    new RegExp(`(\\S{${minLen},})`, 'g'),
    (m) => {
      let out = '';
      for (let i = 0; i < m.length; i += chunk) out += m.slice(i, i + chunk) + ZWSP;
      return out;
    }
  );
}

function cleanTextForPdf(text = '') {
  let s = String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  // ⚠️ Insere quebra em URLs antes de renderizar
  s = s.replace(/https?:\/\/\S+/gi, (url) => softBreakLongWords(url, 20, 8));

  // pequenos ajustes de layout
  s = s.replace(/(Score:\s*\d+%)(?=\S)/g, '$1\n');
  s = s.replace(/(%\s*Sum[aá]rio)/gi, '%\n$1');
  s = s.replace(/(%\s*Atendimento)/gi, '%\n$1');

  // ⚠️ Quebra geral de tokens longos (evita loop no LineWrapper do pdfkit)
  s = softBreakLongWords(s, 40, 12);

  return s;
}

function chunkMarkdownToBlocks(md) {
  const rawLines = cleanTextForPdf(md).split('\n');
  const blocks = [];
  let i = 0;

  const isBlank     = (s) => !s || /^\s*$/.test(s);
  const isHeading   = (s) => /^(#{1,3})\s+/.test(s);
  const headingLvl  = (s) => ((s.match(/^(#{1,3})\s+/) || [,''])[1] || '').length;
  const isBadge     = (s) => /^[🟢🟡🔴]/.test(s);
  const isTopBullet = (s) => /^-\s+/.test(s);
  const isSubBullet = (s) => /^ {2,}-\s+/.test(s);

  while (i < rawLines.length) {
    const line = rawLines[i];

    if (isBlank(line)) { blocks.push({ type: 'spacer', lines: [''] }); i += 1; continue; }
    if (isHeading(line)) { blocks.push({ type: 'heading', level: headingLvl(line), lines: [line.replace(/^#{1,3}\s+/, '')] }); i += 1; continue; }
    if (isBadge(line)) { blocks.push({ type: 'badge', lines: [line] }); i += 1; continue; }

    if (isTopBullet(line)) {
      const lines = [line];
      let j = i + 1;
      while (j < rawLines.length) {
        if (isSubBullet(rawLines[j])) { lines.push(rawLines[j]); j++; continue; }
        if (isTopBullet(rawLines[j])) break;
        if (isBlank(rawLines[j]) || isHeading(rawLines[j]) || isBadge(rawLines[j])) break;
        break;
      }
      blocks.push({ type: 'listItem', lines });
      i = j;
      continue;
    }

    const lines = [line];
    let j = i + 1;
    while (j < rawLines.length) {
      if (isBlank(rawLines[j]) || isHeading(rawLines[j]) || isBadge(rawLines[j]) || isTopBullet(rawLines[j]) || isSubBullet(rawLines[j])) break;
      lines.push(rawLines[j]); j++;
    }
    blocks.push({ type: 'paragraph', lines });
    i = j;
  }

  return blocks;
}

function drawDivider(doc, width) {
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
}

function renderBlocksKeepTogether(doc, md, width) {
  const blocks = chunkMarkdownToBlocks(md);
  const LINE_GAP   = 2.2;
  const SUB_INDENT = 20;

  const spaceLeft = () => doc.page.height - doc.page.margins.bottom - doc.y;

  const measureBlock = (b) => {
    doc.font('Helvetica').fontSize(11);
    switch (b.type) {
      case 'spacer': return 6;
      case 'heading': {
        const size = b.level === 1 ? 16 : (b.level === 2 ? 13 : 12);
        doc.font('Helvetica-Bold').fontSize(size);
        const h = doc.heightOfString(b.lines.join('\n'), { width, lineGap: LINE_GAP });
        doc.font('Helvetica').fontSize(11);
        return h + 6;
      }
      case 'badge': {
        const text = b.lines.join('\n').replace(/^[^\s]+\s*/, '');
        const h = doc.heightOfString(text, { width: width - 14, lineGap: LINE_GAP });
        return h + 12;
      }
      case 'listItem': {
        let h = 0;
        for (const ln of b.lines) {
          const t = /^-\s+/.test(ln)
            ? '• ' + ln.replace(/^-\s+/, '')
            : '• ' + ln.replace(/^ {2,}-\s+/, '');
          h += doc.heightOfString(t, { width: /^-\s+/.test(ln) ? width : (width - SUB_INDENT), lineGap: LINE_GAP });
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

  const renderBlock = (b) => {
    doc.fillColor('#000').font('Helvetica').fontSize(11);
    switch (b.type) {
      case 'spacer':
        doc.moveDown(0.3); return;
      case 'heading': {
        const size = b.level === 1 ? 16 : (b.level === 2 ? 13 : 12);
        doc.font('Helvetica-Bold').fontSize(size);
        doc.text(b.lines.join('\n'), { width, align: 'left', lineGap: 2.2 });
        doc.font('Helvetica').fontSize(11);
        if (b.level === 1) drawDivider(doc, width);
        return;
      }
      case 'badge': {
        const raw = b.lines[0] || '';
        const color = raw.startsWith('🟢') ? '#22c55e' : raw.startsWith('🟡') ? '#f59e0b' : '#ef4444';
        const text = raw.replace(/^[^\s]+\s*/, '');
        const x = doc.x, y = doc.y + 6;
        doc.save().circle(x + 5, y, 4).fill(color).restore();
        doc.fillColor('#000');
        doc.text(text, x + 14, doc.y, { width: width - 16, align: 'left', lineGap: 2.2 });
        doc.fillColor('#000');
        return;
      }
      case 'listItem': {
        for (const ln of b.lines) {
          if (/^-\s+/.test(ln)) {
            const t = '• ' + ln.replace(/^-\s+/, '');
            doc.text(t, { width, align: 'left', lineGap: 2.2, indent: 10 });
          } else {
            const t = '• ' + ln.replace(/^ {2,}-\s+/, '');
            const x = doc.x + SUB_INDENT;
            const y = doc.y;
            doc.text(t, x, y, { width: width - SUB_INDENT, align: 'left', lineGap: 2.2 });
          }
        }
        doc.moveDown(0.1);
        return;
      }
      case 'paragraph': {
        const line = b.lines.join('\n');
        // negrito **...** seguro
        const parts = line.split(/\*\*(.+?)\*\*/g);
        for (let i = 0; i < parts.length; i++) {
          const chunk = parts[i];
          if (!chunk) continue;
          doc.font(i % 2 ? 'Helvetica-Bold' : 'Helvetica');
          doc.text(chunk, { width, continued: i < parts.length - 1, lineGap: 2.2, align: 'justify' });
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

function renderMdWithLogicalBreak(doc, md, width) {
  const SPLIT = '\n## Análise Detalhada';
  if (!md.includes(SPLIT)) { renderBlocksKeepTogether(doc, md, width); return; }
  const [a, b] = md.split(SPLIT);
  renderBlocksKeepTogether(doc, a, width);
  doc.addPage();
  renderBlocksKeepTogether(doc, '## Análise Detalhada' + b, width);
}

// Rodapé/cabeçalho
function attachHeaderFooter(doc, title = 'RELATÓRIO DE VIABILIDADE') {
  const drawHF = () => {
    const { page, page: { width, margins } } = doc;

    const headerFontSize = 10;
    const footerFontSize = 9;

    const yTop = Math.max(12, margins.top - 28);
    const yBot = page.height - margins.bottom - footerFontSize - 6;

    // Header
    doc.save()
      .font('Helvetica-Bold').fontSize(headerFontSize).fillColor('#111827')
      .text(title, margins.left, yTop, {
        width: width - margins.left - margins.right,
        align: 'center',
        lineBreak: false,
      })
      .restore();

    // Footer
    const pageNum = doc.page.number;
    doc.save()
      .font('Helvetica').fontSize(footerFontSize).fillColor('#6b7280')
      .text(`Página ${pageNum}`, margins.left, yBot, {
        width: width - margins.left - margins.right,
        align: 'center',
        lineBreak: false,
      })
      .restore();
  };

  // Primeira página
  drawHF();

  // Páginas subsequentes
  doc.on('pageAdded', () => {
    drawHF();
  });
}

/* ========= gerarPdf multi-tenant (layout novo) ========= */
async function gerarPdf(markdown, companyId = null) {
  const REPORTS_DIR = getReportsDir(companyId);
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  const filename = `relatorio_viabilidade_${Date.now()}.pdf`;
  const outPath = path.join(REPORTS_DIR, filename);

  // limite defensivo para não explodir o PDF
  const MAX_CHARS_REPORT = 250_000;
  if (markdown && markdown.length > MAX_CHARS_REPORT) {
    markdown = markdown.slice(0, MAX_CHARS_REPORT) + '\n\n… [trecho truncado para emissão do PDF]';
  }

  const doc = new PDFDocument({ size: 'A4', margin: 54 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  attachHeaderFooter(doc, 'RELATÓRIO DE VIABILIDADE');

  doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827')
     .text('RELATÓRIO DE VIABILIDADE', { align: 'center', width: contentWidth });
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10).fillColor('#6b7280')
     .text(`Emitido em: ${new Date().toLocaleString('pt-BR')}`, { align: 'center', width: contentWidth })
     .fillColor('#000');
  doc.moveDown(0.7);

  renderMdWithLogicalBreak(doc, markdown || '-', contentWidth);

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return {
    filePath: outPath,
    publicUrl: `/api/edital/report/${filename}`,
    filename
  };
}

/* ============ PROGRESS LOGGER (sempre ligado) ============ */
function makeProgressLogger() {
  const WEIGHTS = { OCR: 20, HEADER: 5, FILES_TEXT: 0, CAT_SEARCH: 45, REQUIREMENTS: 20, SUMMARY: 5, PDF: 5 };
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

/* ======= indicador ponderado (70/30) ======= */
function computeWeightedIndicators(items) {
  const tech = items.filter(i => i.kind === 'TECH');
  const doc  = items.filter(i => i.kind === 'DOC');
  const count = (arr, st) => arr.filter(i => i.status === st).length;

  const okT = count(tech, 'OK'), paT = count(tech, 'PARCIAL'), naT = count(tech, 'NAO');
  const okD = count(doc,  'OK'), paD = count(doc,  'PARCIAL'), naD = count(doc,  'NAO');

  const score = (ok, parcial, total) => total ? (ok + 0.5 * parcial) / total : 0;
  const techScore = score(okT, paT, tech.length);
  const docScore  = score(okD, paD, doc.length);

  const finalPct = Math.round((0.7 * techScore + 0.3 * docScore) * 100);

  return {
    counts: { ok: okT + okD, parcial: paT + paD, nao: naT + naD },
    tech:   { ok: okT, parcial: paT, nao: naT, pct: Math.round(techScore * 100), score: techScore },
    doc:    { ok: okD, parcial: paD, nao: naD, pct: Math.round(docScore * 100), score: docScore },
    pct: finalPct
  };
}
function recomendacaoByPct(pct) {
  if (pct >= 75) return { label: '🟢 PARTICIPAÇÃO RECOMENDADA', cor: 'verde' };
  if (pct >= 60) return { label: '🟡 PARTICIPAÇÃO RECOMENDADA COM AJUSTES', cor: 'amarelo' };
  if (pct >= 40) return { label: '🟠 AVALIAR E REGISTRAR RISCOS', cor: 'laranja' };
  return { label: '🔴 PARTICIPAÇÃO NÃO RECOMENDADA', cor: 'vermelho' };
}

/* ============ CONTROLLER principal (multi-empresa) ============ */
async function analisarEdital(req, res) {
  console.log("[controller] HIT /api/edital/analisar | editalController v3.4 MONGO-FIRST");
  const PROGRESS = makeProgressLogger();
  const tenantId = getTenantId(req);

  console.log("[controller] headers content-type =", req.headers['content-type'] || '(sem)');

  if (!req.files || !req.files.editalPdf || req.files.editalPdf.length !== 1) {
    console.log("[controller] arquivo inválido: esperava exatamente 1 em 'editalPdf'");
    return res.status(400).json({ error: 'Envie exatamente 1 arquivo PDF do edital (campo: editalPdf).' });
  }

  const mainEditalFile = req.files.editalPdf[0];
  const annexFiles = req.files['arquivos[]'] || [];
  console.log("[controller] files.editalPdf =", (req.files?.editalPdf||[]).length, "| files['arquivos[]'] =", annexFiles.length);

  console.log(`\n-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=`);
  console.log(`[${new Date().toLocaleString('pt-BR')}] Nova análise: ${mainEditalFile.originalname} (+${annexFiles.length} anexos enviados, ignorados para evidência local) | tenant=${tenantId || 'public'}`);

  try {
    // OCR somente do EDITAL (para extrair cabeçalho/objeto/requisitos)
    const rawPdf = fs.readFileSync(mainEditalFile.path);
    const mainEditalText = await extractTextFromPdf(rawPdf, mainEditalFile.path);
    if (!mainEditalText?.trim()) {
      console.log("[controller] OCR vazio para o PDF principal");
      return res.status(400).json({ error: 'Não foi possível extrair texto do PDF principal.' });
    }
    const editalText = mainEditalText.slice(0, MAX_EDITALTEXT_CHARS || 200000);
    PROGRESS.phase('OCR', `Texto do edital extraído (${editalText.length.toLocaleString('pt-BR')} chars)`);

    // Cabeçalho/assinaturas
    const header = parseBidHeader(editalText);
    const objSigs = signaturesFor(tenantId, header.objetoLicitado || editalText);
    console.log("[controller] OBJETO(limpo)=", header.objetoLicitado || '(n/a)');
    PROGRESS.phase('HEADER', `Cabeçalho extraído | Sigs(objeto): [${objSigs.short}]`);

    // Domínios do edital (documento inteiro)
    const editalDomains = detectDomain(editalText);
    const editalDomainsArr = [...editalDomains];
    const isEngineeringDomain = editalDomainsArr.some(d => ['engenharia_civil','eletrica','hidraulica','manutencao_predial'].includes(d));
    const isHealthOnly = !isEngineeringDomain && editalDomainsArr.some(d => ['odontologia','saude'].includes(d));
    console.log('[controller] domains.edital =', editalDomainsArr, '| isEngineeringDomain =', isEngineeringDomain, '| isHealthOnly =', isHealthOnly);

    // >>>> Estratégia MONGO-FIRST:
    // - Não vamos fazer OCR dos anexos locais.
    // - Evidências e CATs serão buscadas nas coleções do MySQL.
    // - Mantemos apenas "placeholders" vazios para interfaces antigas das funcs.
    const filesForEvidenceSearch = []; // vazio = sem leitura local
    const localFilesText = [];         // vazio = sem OCR local
    PROGRESS.phase('FILES_TEXT', 'Evidências serão consultadas diretamente no MySQL (sem OCR de anexos).');

    // Busca de CATs (apenas para engenharia) — usando APENAS o MySQL
    let topCats = [];
    let domainAligned = false;

    if (isEngineeringDomain) {
      let totalCandidatesEstimate = 1;
      const catSearchTick = PROGRESS.sub('CAT_SEARCH', () => totalCandidatesEstimate);

      const domainProbe = [header.objetoLicitado, editalText].filter(Boolean).join('\n');

      const allCatsRaw = await findCATMatches(
        Cats,
        domainProbe,
        12,
        [], // <<< sem base local
        {
          tenantId,
          debug: (evt) => {
            try {
              if (evt.kind === 'mysqlBatchCats')  { totalCandidatesEstimate += Math.max(0, evt.total); }
              if (evt.kind === 'mysqlItemCats')   { catSearchTick(Math.min(evt.i, totalCandidatesEstimate), `MySQL CATS ${evt.source}`); }
              if (evt.kind === 'mysqlBatchChunks'){ totalCandidatesEstimate += Math.max(0, evt.total); }
              if (evt.kind === 'mysqlItemChunks'){ catSearchTick(Math.min(evt.i, totalCandidatesEstimate), `MySQL CHUNKS ${evt.source}`); }
              // intencionalmente ignoramos eventos "localBatch"/"localItem"
            } catch {}
          }
        }
      );

      // Dedup e score somente para **aprovadas** (score>0)
      const dedupCats = uniqueByCat(allCatsRaw).map(c => ({ ...c, ano: pickReasonableYear(c.raw) || c.ano || '' }));

      const ranked = dedupCats
        .map(c => ({ meta: c, score: scoreCatToObjetoLote(c, domainProbe) })) // score=0 se domínio não bater
        .filter(r => (r.score || 0) > 0)         // SOMENTE aprovadas
        .sort((a,b)=>b.score-a.score)
        .slice(0, 3);

      topCats = ranked.map(r => r.meta);
      domainAligned = ranked.length > 0;

      console.log("[controller] CATs top =", topCats.length, "| domainAligned =", domainAligned);
    } else {
      PROGRESS.phase('CAT_SEARCH', 'Domínio não-engenharia — CATs desabilitadas');
    }

    // Requisitos extraídos do edital (OCR do edital apenas)
    const allRequirements = await extractRequirementsFromBid(editalText);
    const requirementsToAnalyze = (allRequirements || [])
      .filter(r => !/credenciamento|chave|senha|licitanet|comprasnet|bll|enviar proposta/i.test((r || '')));

    console.log("[controller] extractRequirementsFromBid ->", Array.isArray(allRequirements) ? allRequirements.length : "N/A");
    console.log("[controller] requirementsToAnalyze ->", requirementsToAnalyze.length);

    const analysesMd = [];
    const results = [];
    const reqTick = PROGRESS.sub('REQUIREMENTS', Math.max(1, requirementsToAnalyze.length));

    for (let i = 0; i < requirementsToAnalyze.length; i++) {
      const reqTxt = requirementsToAnalyze[i];
      if (!reqTxt) { reqTick(i + 1, 'requisito vazio'); continue; }

      const isTechKeyword = /\b(cat|acervo|atestado|respons[áa]vel\s+t[ée]cnico|rt)\b/i.test(reqTxt);
      console.log('[controller] loop req %d/%d | isEngineeringDomain=%s | topCats=%d | isTechKeyword=%s | req="%s"',
        i + 1, requirementsToAnalyze.length, isEngineeringDomain, topCats.length, isTechKeyword, (reqTxt||'').slice(0, 120));

      // ---------- CAT + EVIDENCE (engenharia) — **MySQL-first**
      if (isEngineeringDomain && isTechKeyword) {
        if (topCats.length > 0 && domainAligned) {
          const bullets = topCats.map((c, idx) => {
            const tags = [
              c.catNum ? `CAT nº ${c.catNum}` : (c.fileHints?.fileCatNum ? `CAT nº ${c.fileHints.fileCatNum}` : null),
              c.hasART ? 'ART' : null,
              c.hasCREA ? 'CREA/CAU' : null
            ].filter(Boolean).join(' · ');
            const year = c.ano || c.fileHints?.fileYear || '';
            const label = `${c.nomeCAT || c.fileName || c.source}${year ? ` (${year})` : ''}`;
            const place = ['1º','2º','3º'][idx] || `${idx+1}º`;
            return `- **${place}** — ${label} — ${tags || '—'}`;
          }).join('\n');

          let block = `Requisito: ${reqTxt}\n\n🟢 ATENDIDO.\n\nQualificação técnica suportada por:\n${bullets}`;

          try {
            // Sem leitura local; busca evidências APENAS no MySQL
            const evidence = await findEvidenceOnTheFly(reqTxt, [], Cats, { tenantId });
            const docBlock = await analyzeRequirementWithContext(reqTxt, evidence, (req.auth && req.auth.companyProfile) || {}, { isEngineering: true });
            block += `\n\n---\n**Corroboração por evidências (base MySQL)**\n\n${docBlock}`;
          } catch (e) {
            block += `\n\n> (Falha ao buscar evidências MySQL: ${e.message})`;
          }

          analysesMd.push(block);
          results.push({ kind: 'TECH', status: 'OK', req: reqTxt });
          reqTick(i + 1, 'CAT + evidências (MySQL)');
          continue;
        } else {
          const block = `Requisito: ${reqTxt}\n\n🔴 **NÃO ATENDIDO** — Sem acervo (CAT) aderente no MySQL.`;
          analysesMd.push(block);
          results.push({ kind: 'TECH', status: 'NAO', req: reqTxt });
          reqTick(i + 1, 'sem acervo (MySQL)');
          continue;
        }
      }

      // ---------- EVIDENCE documental — **MySQL-first**
      const evidence = await findEvidenceOnTheFly(reqTxt, [], Cats, { tenantId });
      const block = await analyzeRequirementWithContext(reqTxt, evidence, (req.auth && req.auth.companyProfile) || {}, { isEngineering: false });
      analysesMd.push(block);
      results.push({
        kind: 'DOC',
        status: (() => {
          const t = block.toLowerCase();
          if (/n[aã]o atendido/.test(t) || /🔴/.test(block)) return 'NAO';
          if (/atendido parcialmente/.test(t) || /🟡/.test(block)) return 'PARCIAL';
          if (/atendido/.test(t) || /🟢/.test(block)) return 'OK';
          return 'PARCIAL';
        })(),
        req: reqTxt
      });
      reqTick(i + 1, 'evidências (MySQL)');
    }

    // Indicadores ponderados (70/30)
    const indic = computeWeightedIndicators(results);
    const rec = recomendacaoByPct(indic.pct);

    // Probabilidade de êxito
    const eliminatoriosNaoAt = countEliminatoryFailures ? countEliminatoryFailures(analysesMd) : 0;
    const probExito = computeSuccessProbability ? computeSuccessProbability(indic.tech.score, indic.doc.score, eliminatoriosNaoAt) : (indic.pct / 100);
    const probBanner = renderSuccessBanner ? renderSuccessBanner(probExito, eliminatoriosNaoAt) : '';

    const indicadoresMd = [
      `### Resultado ponderado`,
      `**Recomendação:** ${rec.label}`,
      `**Indicadores gerais:** ${indic.counts.ok} OK • ${indic.counts.parcial} PARCIAL • ${indic.counts.nao} NÃO • **Atendimento global (ponderado 70/30): ${indic.pct}%**`,
      `**Técnico (70%):** ${indic.tech.ok} OK • ${indic.tech.parcial} PARCIAL • ${indic.tech.nao} NÃO — ${indic.tech.pct}%`,
      `**Documental (30%):** ${indic.doc.ok} OK • ${indic.doc.parcial} PARCIAL • ${indic.doc.nao} NÃO — ${indic.doc.pct}%`,
    ].join('\n\n');

    // Bloco Viabilidade (CATs) — somente para engenharia
    const blocoViabilidade = (isEngineeringDomain
      ? (topCats.length
          ? `### Viabilidade profissional e técnica\n\nCom base no acervo (CATs) **encontrado no MySQL**, identificamos **aderência técnica** ao objeto licitado:\n\n${
              topCats.map((c, idx) => {
                const comp = [
                  c.catNum ? `CAT nº ${c.catNum}` : (c.fileHints?.fileCatNum ? `CAT nº ${c.fileHints.fileCatNum}` : null),
                  c.hasART ? 'ART' : null,
                  c.hasCREA ? 'CREA/CAU' : null
                ].filter(Boolean).join(' · ');
                const head = [
                  `**CAT:** ${c.nomeCAT || c.fileName || c.source}`,
                  c.orgao ? `**Órgão/Entidade:** ${c.orgao}` : (c.fileHints?.fileOrgao ? `**Órgão/Entidade:** ${c.fileHints.fileOrgao}` : null),
                  (c.ano || c.fileHints?.fileYear) ? `**Ano:** ${c.ano || c.fileHints?.fileYear}` : null
                ].filter(Boolean).join(' | ');
                const place = ['1º','2º','3º'][idx] || `${idx+1}º`;
                return `- **${place}** — ${head}\n  - **Escopo/Resumo:** ${c.escopo || '-'}\n  - **Comprovações:** ${comp || '—'}`;
              }).join('\n\n')
            }`
          : `### Viabilidade profissional e técnica\n\n- **Sem acervo aderente (CAT) no MySQL** para este edital.`)
      : '### Viabilidade profissional e técnica\n\n- Para este objeto, a comprovação é por **atestado de capacidade técnica** pertinente (e, quando aplicável, **registro ANVISA/MAPA**), não por CAT/CREA.'
    );

    // RT sugerido — só faz sentido em engenharia e com CAT consistente
    let blocoRT = '';
    if (isEngineeringDomain && topCats.length) {
      const rt = suggestBestRT(topCats, header.objetoLicitado || editalText);
      const chosenCat = topCats[0];
      if (rt && (rt.profissional || chosenCat?.nomeCAT)) {
        const reqBase = [header.objetoLicitado || '', ...(Array.isArray(allRequirements) ? allRequirements : [])].join('\n');
        const comp = compareReqVsCat(reqBase, chosenCat?.raw || '');
        blocoRT = [
          '### Responsável Técnico Sugerido',
          `**Nome:** ${rt.profissional || '—'}`,
          `**CAT nº / Ano / Órgão:** ${chosenCat?.catNum || chosenCat?.fileHints?.fileCatNum || '—'} / ${(chosenCat?.ano || chosenCat?.fileHints?.fileYear || '—')} / ${(chosenCat?.orgao || chosenCat?.fileHints?.fileOrgao || '—')}`,
          `**Escopo (resumo):** ${chosenCat?.escopo || '—'}`,
          `**Fonte (arquivo):** ${chosenCat?.nomeCAT || chosenCat?.fileName || '—'}`,
          '',
          '#### Comprovação de equivalência/excedente frente ao edital',
          (Array.isArray(comp) && comp.length ? comp.map(l => `- ${l}`).join('\n') : '- (Sem parâmetros comparáveis explícitos)')
        ].join('\n\n');
      }
    }

    // Aderência por Lote — opcional (mantém neutro)
    let blocoLotes = '';
    if (isEngineeringDomain) {
      const lotes = (editalText.match(/^\s*Lote\s*\d+\s*[-–:]\s*[^\n]+/gim) || []).slice(0, 8);
      if (lotes.length) {
        const lotesAnalise = lotes.map(l => `#### ${l.replace(/^\s*/,'')}\n- (análise de CAT por lote pode ser habilitada aqui; fonte MySQL)`);
        blocoLotes = ['## Aderência por Lote', ...lotesAnalise].join('\n\n');
      }
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

    const summaryPatched = summary.replace(
      /###\s*Recomendação Final[\s\S]*?(?=\n###|\n##|$)/i,
      (m) => {
        const base = m.trim().replace(/\n+$/,'');
        const extra = `\n\n**Indicadores (ponderado 70/30):** Técnico ${indic.tech.pct}% • Documental ${indic.doc.pct}% • **Global ${indic.pct}%**`;
        return base.includes('Indicadores (ponderado') ? base : base + extra;
      }
    );

    const headerList = [
      `- **Órgão Licitório:** ${header.orgaoLicitante || '-'}`,
      `- **Concorrência Eletrônica:** ${header.concorrenciaEletronica || '-'}`,
      `- **Tipo:** ${header.tipo || '-'}`,
      `- **Prazo de execução:** ${header.prazoExecucao || '-'}`,
      `- **Classificação de Despesa e valor:** ${header.classificacaoDespesaEValor || '-'}`,
      `- **Objeto licitado:** ${header.objetoLicitado || '-'}`,
      `- **Prazo máximo para proposta:** ${header.prazoMaximoParaProposta || '-'}`,
    ].join('\n');

    const bannerTopo = probBanner || '';

    const finalReport = [
      '# RELATÓRIO DE VIABILIDADE',
      bannerTopo,
      '## Dados do edital',
      headerList,
      '',
      indicadoresMd,
      '',
      blocoViabilidade,
      blocoRT ? `\n${blocoRT}` : '',
      '',
      isEngineeringDomain && blocoLotes ? blocoLotes : '',
      '',
      '## Sumário Executivo',
      summaryPatched,
      '',
      '## Análise Detalhada',
      analysesMd.join('\n\n') || '- (Não foi possível gerar a análise detalhada)'
    ].filter(Boolean).join('\n\n');

    const { publicUrl, filePath, filename } = await gerarPdf(finalReport, tenantId);
    PROGRESS.phase('PDF', `PDF emitido em ${filePath}`);
    console.log(` -> Análise concluída! Progresso final: ${PROGRESS.get().toFixed(1)}%`);
    return res.json({
      report: finalReport,
      pdf: { filename, url: publicUrl, path: filePath },
      probability: { value: Math.round((probExito || 0) * 100), eliminatoriosNaoAt }
    });

  } catch (error) {
    console.error(' -> ❌ Erro:', error);
    return res.status(500).json({ error: 'Erro interno.', details: error.message });
  } finally {
    const allUploadedFiles = [
      ...(req.files?.editalPdf || []),
      ...((req.files && req.files['arquivos[]']) || []),
    ];
    for (const f of allUploadedFiles) { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} }
    console.log(`-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=\n`);
  }
}

/** POST /api/edital/gerar-pdf */
async function gerarPdfFromBody(req, res) {
  try {
    console.log("[controller] HIT /api/edital/gerar-pdf (from body)");
    const { reportMd } = req.body || {};
    if (!reportMd || typeof reportMd !== 'string' || reportMd.trim().length < 5) {
      return res.status(400).json({ error: 'Campo "reportMd" é obrigatório (string com conteúdo).' });
    }
    const tenantId = getTenantId(req);
    const { publicUrl, filename } = await gerarPdf(reportMd, tenantId);
    return res.json({ url: publicUrl, filename });
  } catch (e) {
    console.error('[gerarPdfFromBody] ERRO:', e);
    return res.status(500).json({ error: 'Falha ao gerar PDF.', details: e.message });
  }
}

/** GET /api/edital/analisar/history (scoped ao tenant) */
async function listarHistorico(req, res) {
  try {
    console.log("[controller] HIT /api/edital/analisar/history | editalController v3.4 MONGO-FIRST");
    const tenantId = getTenantId(req);
    const REPORTS_DIR = getReportsDir(tenantId);

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || '10', 10)));

    await fsp.mkdir(REPORTS_DIR, { recursive: true }).catch(() => {});
    const files = await fsp.readdir(REPORTS_DIR).catch(() => []);
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

/** GET /api/edital/report/:name (scoped ao tenant) */
async function serveReportByName(req, res) {
  try {
    console.log("[controller] HIT /api/edital/report/:name", req.params?.name || '');
    const tenantId = getTenantId(req);
    const REPORTS_DIR = getReportsDir(tenantId);

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

/* ====== Stubs para status/SSE (se um dia ativar async para edital) ====== */
async function editalStatus(req, res) {
  return res.status(400).json({ error: 'Async de editais está desabilitado. Use POST /api/edital/analisar (sync).' });
}
function editalEvents(req, res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: error\ndata: ${JSON.stringify({ message: 'Async de editais desabilitado' })}\n\n`);
  try { res.end(); } catch {}
}

module.exports = {
  analisarEdital,
  gerarPdf,
  gerarPdfFromBody,
  listarHistorico,
  serveReportByName,
  editalStatus,   // stubs p/ rotas /status e /events
  editalEvents,
  __getParseHeader: parseBidHeader,
};
