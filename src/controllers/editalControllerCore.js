// src/controllers/editalControllerCore.js
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const Cats = require('../models/catModel');
const Companies = require('../models/companyModel');
const { MAX_EDITALTEXT_CHARS: MAX_CHARS_ENV } = require('../Config/env');
const { extractTextFromPdf } = require('../utils/ocr');

const {
  extractRequirementsFromBid,
  analyzeRequirementWithContext,
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
  detectDomain,          // domínio do edital
  sameDomainGate,        // >>> NOVO
  clamp,                 // >>> para normalizar score
} = require('../services/cats');

/* ====== diretório por empresa para salvar relatórios ====== */
const REPORTS_BASE_DIR = path.join(process.cwd(), 'data', 'reports');
const companyReportsDir = (companyId) => path.join(REPORTS_BASE_DIR, String(companyId || 'unknown'));

/* ====== limites/config ====== */
const MAX_EDITALTEXT_CHARS = Number(MAX_CHARS_ENV || 200000);

/* ============================ PDF helpers (originais) ============================ */
function cleanTextForPdf(text = '') {
  const zwsp = '\u200B';
  return String(text || '')
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
      paragraphGap: 4.2,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (/\[\[PAGE_BREAK\]\]/.test(ln)) { doc.addPage(); continue; }
    if (/^\s*---\s*$/.test(ln)) { drawHr(); continue; }
    if (/^#\s+/.test(ln)) { doc.font('Helvetica-Bold').fontSize(16).text(ln.replace(/^#\s+/, ''), { width: contentWidth, align: 'center' }); doc.font('Helvetica').fontSize(11); doc.moveDown(0.4); continue; }
    if (/^##\s+/.test(ln)) { doc.font('Helvetica-Bold').fontSize(14).text(ln.replace(/^##\s+/, ''), { width: contentWidth }); doc.font('Helvetica').fontSize(11); doc.moveDown(0.25); continue; }
    if (/^###\s+/.test(ln)) { doc.font('Helvetica-Bold').fontSize(12).text(ln.replace(/^###\s+/, ''), { width: contentWidth }); doc.font('Helvetica').fontSize(11); doc.moveDown(0.15); continue; }

    const bulletMatch = ln.match(/^\s*[-•]\s+(.*)$/);
    if (bulletMatch) {
      doc.list([bulletMatch[1]], { bulletRadius: 1.8, textIndent: 10, bulletIndent: 14, width: contentWidth });
      continue;
    }

    if (/^\s*$/.test(ln)) { doc.moveDown(0.15); continue; }

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
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#6b7280')
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

/* ======================= Compat: findCATMatches ======================= */
async function safeFindCATMatches(contextOrNull, textoAlvo, limit = 10, localFilesText = [], opts = {}) {
  try {
    if (contextOrNull && typeof findCATMatches === 'function') {
      const maybe = await findCATMatches(contextOrNull, textoAlvo, limit, localFilesText, opts);
      if (Array.isArray(maybe)) return maybe;
    }
  } catch (_) {}

  return rankFromLocalOnly(textoAlvo, limit, localFilesText);
}

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
      hasCREA: /(^|\W)(?:CREA|CAU)(\W|$)/i.test(f.text),
      orgao: null,
      catNum: null,
    };
    const score = scoreCatToObjetoLote(meta, textoAlvo);
    pool.push({ meta, score });
  }
  return pool
    .filter(p => (p.score || 0) > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p) => p.meta);
}

/* =============== Shim para compareReqVsCat =============== */
function compareReqVsCatShim(requisitoText = '', catOrArray) {
  try {
    const arr = Array.isArray(catOrArray) ? catOrArray : (catOrArray ? [catOrArray] : []);
    if (!arr.length) return [];
    const lines = compareReqVsCat(requisitoText, arr[0]);
    return lines.slice(0, 6).map(l => `- ${l}`);
  } catch {
    return [];
  }
}

/* ===== helpers de aprovação ===== */
const THRESH_NORM = 0.65;
function approveCatAgainst(editalText, catMeta, rawScore) {
  const catAll = [catMeta?.raw, catMeta?.escopo, catMeta?.fileName].filter(Boolean).join(' ');
  const gate = sameDomainGate(editalText, catAll);
  const norm = clamp((rawScore || 0) / 10, 0, 1);
  const approved = gate && norm >= THRESH_NORM;
  return { gate, norm, approved };
}

/* ============================ CORE ============================ */
async function analisarEditalCore(files, onProgress = () => {}, opts = {}) {
  const { companyId } = opts || {};
  const bump = (pct, phase) => { try { onProgress(pct, phase); } catch (_) {} };

  // Perfil empresa (opcional)
  let companyProfile = null;
  if (companyId) {
    try { companyProfile = await Companies.findById(companyId); } catch (_) {}
  }

  const mainEditalFile = files?.mainEditalFile;
  const annexFiles = files?.annexFiles || [];
  const allFiles = [mainEditalFile, ...annexFiles].filter(Boolean);

  if (!mainEditalFile?.path) throw new Error('Arquivo principal do edital não informado.');

  try {
    // OCR principal
    const rawPdf = fs.readFileSync(mainEditalFile.path);
    const mainText = await extractTextFromPdf(rawPdf, mainEditalFile.path);
    if (!mainText?.trim()) throw new Error('Falha ao extrair texto do edital.');
    const editalText = mainText.slice(0, MAX_EDITALTEXT_CHARS);
    bump(15, 'OCR do edital');

    // OCR anexos + pool local
    const localFilesText = [];
    const filesForEvidenceSearch = [];
    for (const f of allFiles) {
      const sourceName = f.originalname || path.basename(f.path);
      try {
        const txt = await extractTextFromPdf(fs.readFileSync(f.path), f.path);
        localFilesText.push({ source: sourceName, text: txt || '' });
      } catch (_) {
        localFilesText.push({ source: sourceName, text: '' });
      }
      filesForEvidenceSearch.push({
        source: sourceName,
        getText: async () => {
          try {
            const buff = fs.readFileSync(f.path);
            return await extractTextFromPdf(buff, f.path);
          } catch {
            return '';
          }
        }
      });
    }
    bump(25, 'Textos locais prontos');

    // Cabeçalho (trechos úteis)
    const T = editalText;
    const take = (rx, max = 1200) => {
      const m = T.match(rx);
      return m ? String(m[0]).slice(0, max) : '';
    };

    const objetoBlock =
      take(/(?:\bDO?\s+OBJETO\b[\s\S]{0,2000})|(?:\bOBJETO\b[\s\S]{0,2000})/i, 2000) ||
      T.slice(0, 2000);

    const lotesSnippet = (() => {
      const lotes = [];
      const rx = /(?:^|\n)\s*(?:LOTE|Lote)\s*(\d+)\s*[:\-–]\s*([\s\S]{0,300})/gi;
      let m, cap = 0;
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

    // Domínio do edital (para trilha CAT)
    const editalDomains = detectDomain(editalText);
    const isEngineeringDomain = [...editalDomains].some(d => ['engenharia_civil','eletrica','hidraulica','saneamento','manutencao_predial'].includes(d));
    console.log('[editalCore] domains.edital =', [...editalDomains], '| isEngineeringDomain=', isEngineeringDomain);

    // Busca de CATs
    const domainProbe = [header.objetoLicitado, header.resumoLotes, editalText].filter(Boolean).join('\n');

    const allCatsRaw = await safeFindCATMatches(
      Cats,
      domainProbe,
      15,
      localFilesText,
      { companyId }
    );

    const dedupCats = uniqueByCat(allCatsRaw || []).map((c) => ({
      ...c,
      ano: pickReasonableYear(c.raw) || c.ano || '',
    }));

    const preRank = dedupCats.map((c) => ({
      meta: c,
      rawScore: scoreCatToObjetoLote(c, domainProbe),
    }));

    // Aprovação final (gate + threshold)
    const approvedCats = preRank
      .filter(r => {
        const v = approveCatAgainst(domainProbe, r.meta, r.rawScore);
        if (v.approved) r.meta._score = clamp(r.rawScore / 10, 0, 1);
        return v.approved;
      })
      .sort((a,b)=>b.rawScore-a.rawScore)
      .slice(0,5)
      .map(r => r.meta);

    const domainAligned = approvedCats.length > 0;
    console.log('[editalCore] cats.approved =', approvedCats.map(c => c?.fileName || c?.nomeCAT));
    bump(60, 'CATs aprovadas');

    // Requisitos
    const allRequirements = await extractRequirementsFromBid(editalText);
    const requirementsToAnalyze = (allRequirements || []).filter(
      (r) => !/credenciamento|chave|senha|licitanet|comprasnet|bll|enviar proposta/i.test(r || '')
    );

    const detailedAnalyses = [];
    const techBlocks = [];
    const adminBlocks = [];

    for (const reqTxt of requirementsToAnalyze) {
      const isTech = TECH_REQ_RX.test((reqTxt || '').toLowerCase());

      if (isTech) {
        if (isEngineeringDomain && approvedCats.length > 0) {
          const bullets = approvedCats
            .slice(0, 3)
            .map((c, idx) => {
              const tags = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
                .filter(Boolean).join(' · ');
              const conf = typeof c._score === 'number' ? ` — **conf.: ${(c._score * 100).toFixed(0)}%**` : '';
              const place = ['1º','2º','3º'][idx] || `${idx+1}º`;
              return `- **${place}** — ${c.nomeCAT || c.fileName || '(CAT)'}${c.ano ? ` (${c.ano})` : ''} — ${tags || '—'}${conf}`;
            })
            .join('\n');

          const block = `Requisito: ${reqTxt}\n\n🟢 ATENDIDO.\n\n${bullets || '- (sem CATs listadas)'}`;
          detailedAnalyses.push(block);
          techBlocks.push(block);
        } else {
          const block = `Requisito: ${reqTxt}\n\n🔴 **NÃO ATENDIDO** — Não há acervo (CAT) aderente ao edital.`;
          detailedAnalyses.push(block);
          techBlocks.push(block);
        }
      } else {
        let block;
        if (companyProfile) {
          block = await analyzeRequirementWithContext(reqTxt, null, companyProfile);
        } else {
          const evidence = await findEvidenceOnTheFly(reqTxt, filesForEvidenceSearch, Cats, { tenantId: companyId });
          block = await analyzeRequirementWithContext(reqTxt, evidence, null);
        }
        detailedAnalyses.push(block);
        adminBlocks.push(block);
      }
    }

    // Viabilidade técnica (apenas aprovadas)
    const blocoViabilidade = (approvedCats.length
      ? `### Viabilidade profissional e técnica

Com base no acervo (CATs), identificamos **aderência técnica direta**:

${approvedCats
  .slice(0, 3)
  .map((c, idx) => {
    const comp = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
      .filter(Boolean).join(' · ');
    const place = ['1º','2º','3º'][idx] || `${idx+1}º`;
    const conf = typeof c._score === 'number' ? ` — **conf.: ${(c._score * 100).toFixed(0)}%**` : '';
    return `- **${place}** — ${c.nomeCAT || c.fileName || '(CAT)'} | ${c.orgao || '-'} | ${c.ano || '-'}${conf}
  - **Escopo:** ${c.escopo ? String(c.escopo).slice(0, 600) : '-'}
  - **Comprovações:** ${comp || '—'}`;
  })
  .join('\n\n')}`
      : '### Viabilidade profissional e técnica\n\n- **Não há acervo (CAT) aderente a este edital** conforme a árvore de decisão (domínio técnico + modalidade).'
    );

    // Lotes (apenas aprovadas por lote)
    const lotesAnalise = [];
    if (header.resumoLotes) {
      const lotes = header.resumoLotes.split(/\n+/).filter(Boolean);
      for (const linha of lotes) {
        const cand = await safeFindCATMatches(
          Cats,
          linha,
          10,
          localFilesText,
          { companyId }
        );
        const dedup = uniqueByCat(cand).map(c => ({ meta: c, rawScore: scoreCatToObjetoLote(c, linha) }))
          .sort((a,b) => b.rawScore - a.rawScore);

        const aprov = [];
        for (const r of dedup) {
          const v = approveCatAgainst(linha, r.meta, r.rawScore);
          if (v.approved) aprov.push({ ...r.meta, _score: clamp(r.rawScore / 10, 0, 1) });
        }

        const bullets =
          (aprov.length
            ? aprov.slice(0,3).map((c, idx) => {
                const conf = typeof c._score === 'number' ? ` — **conf.: ${(c._score * 100).toFixed(0)}%**` : '';
                const tags = [c.catNum ? `CAT nº ${c.catNum}` : null, c.hasART ? 'ART' : null, c.hasCREA ? 'CREA/CAU' : null]
                  .filter(Boolean).join(' · ');
                const place = ['1º','2º','3º'][idx] || `${idx+1}º`;
                return `- **${place}** — ${c.nomeCAT || c.fileName || '(CAT)'}${c.ano ? ` (${c.ano})` : ''} — ${tags || '—'}${conf}`;
              }).join('\n')
            : '- (sem acervo aderente para este lote)');

        lotesAnalise.push(`### ${linha.replace(/^\s*Lote\s*\d+\s*[:\-–]\s*/i, '').trim()}\n${bullets}`);
      }
    }

    const blocoLotes = lotesAnalise.length
      ? ['## Aderência por Lote', ...lotesAnalise].join('\n\n')
      : '';

    // RT sugerido (se houver CAT aprovada)
    let blocoRT = '';
    if (approvedCats.length && domainAligned) {
      const rtSugerido = suggestBestRT(approvedCats, header.objetoLicitado || editalText);
      if (rtSugerido) {
        const chosenCat = approvedCats[0];
        const reqBase = [header.objetoLicitado, header.resumoLotes].filter(Boolean).join('\n');
        const compLines = compareReqVsCatShim(reqBase, chosenCat);
        blocoRT = [
          '### Responsável Técnico Sugerido',
          `**Nome:** ${rtSugerido.profissional || '—'}`,
          `**CAT nº / Ano / Órgão:** ${chosenCat?.catNum || '—'} / ${chosenCat?.ano || '—'} / ${chosenCat?.orgao || '—'}`,
          `**Escopo (resumo):** ${chosenCat?.escopo ? String(chosenCat.escopo).slice(0, 600) : '—'}`,
          `**Fonte (arquivo):** ${chosenCat?.nomeCAT || chosenCat?.fileName || '—'}`,
          '',
          '#### Evidências de equivalência/excedente frente ao edital',
          compLines.length ? compLines.join('\n') : '- (Sem parâmetros comparáveis explícitos)'
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

    for (const f of allFiles) { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {} }

    return { report: finalReport, pdf: { filename, url: publicUrl, path: filePath } };
  } catch (err) {
    console.error('[analisarEditalCore] erro:', err);
    for (const f of allFiles) { try { if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {} }
    throw err;
  }
}

module.exports = { analisarEditalCore, gerarPdf };
