// src/controllers/catsController.js
const fs = require('fs');
const path = require('path');
const Cats = require('../models/catModel');
const { CATS_ROOT } = require('../Config/env');
const { walkFiles } = require('../utils/files');
const { extractTextFromPdf, extractTextFromImage } = require('../utils/ocr');
const { normalizeSpaces } = require('../utils/text');
const { embedText } = require('../services/azure');
const { chunkTextGenerator } = require('../utils/text');
const { extractSpecs } = require('../services/specs');

// >>> helpers de atestado/domínio/keywords
const {
  detectDomain,
  extractAtestadosLimpos,
  buildKeywords,
} = require('../services/attestation');

// >>> jobs/progresso + LOGS
const {
  createJob, updateJob, completeJob, failJob, getJob,
} = require('../jobs/progress');

const ALLOWED_EXT = /\.(pdf|tif|tiff|png|jpg|jpeg)$/i;

// ===== helpers =====
const safeWalk = (dir) => {
  const ok = fs.existsSync(dir);
  if (!ok) {
    console.warn('[safeWalk] diretório não existe:', dir);
    return [];
  }
  return walkFiles(dir);
};

// ====== texto/regex util ======
function extractFirst(rx, text) {
  const m = rx.exec(String(text || ''));
  return m ? (m[1] || m[0])?.trim() : null;
}
function extractAll(rx, text, map = (v) => String(v).trim()) {
  const out = [];
  let m; const t = String(text || '');
  while ((m = rx.exec(t))) out.push(map(m[1] || m[0]));
  return out;
}
function cleanObj(o) {
  const out = {};
  for (const [k,v] of Object.entries(o || {})) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}
function lines(t){ return String(t||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean); }
function pickBestYear(y){ const n = parseInt(y,10); return n>=1970 && n<=2100; }
function scoreCatNum(s){
  const m = /(\d{4})$/.exec(s);
  const yOk = m ? pickBestYear(m[1]) : false;
  return (s.replace(/\D/g,'').length) + (yOk ? 100 : 0);
}
function findCatNumber(txt){
  const t = String(txt||'');
  const cands = new Set();

  // clássico 2220530101/2021
  (t.match(/\b\d{6,15}\/\d{4}\b/g) || []).forEach(v => cands.add(v));

  // “Certidão nº 2220530101/2021”
  (t.match(/Certid[ãa]o[^0-9\n]*n[ºo\.]*\s*([\d\/\.]{6,})/ig) || [])
    .forEach(s=>{
      const m = /n[ºo\.]*\s*([\d\/\.]{6,})/i.exec(s);
      if (m) cands.add(m[1]);
    });

  // linha abaixo de “CAT COM REGISTRO…”
  const L = lines(t);
  L.forEach((ln,i)=>{
    if (/CAT\s+COM\s+REGISTRO/i.test(ln) && L[i+1]) {
      const m = L[i+1].match(/\b\d{6,15}\/\d{4}\b/);
      if (m) cands.add(m[0]);
    }
  });

  if (!cands.size) return null;
  return Array.from(cands).sort((a,b)=>scoreCatNum(b)-scoreCatNum(a))[0];
}

/* ================== classificação CAT / ATESTADO (metadados) ================ */
function classifyDoc(fullText = '', fileName = '') {
  const looksCat =
    /certid[aã]o de acervo t[eé]cnico|cat\s*n?[ºo]?|crea\s*\-?\s*cat/i.test(fullText) ||
    /\bcat\b/i.test(fileName);

  const looksAtestado =
    /\batesta[do]\b|\batesto\b|\batestado de capacidade t[eé]cnica\b/i.test(fullText) ||
    /atestado/i.test(fileName);

  if (looksCat && !looksAtestado) return 'CAT';
  if (looksAtestado && !looksCat) return 'ATESTADO';
  if (looksCat && looksAtestado) return 'CAT_ATESTADO_MISTO';
  return 'OUTRO';
}

function extractCatMeta(fullText = '') {
  const meta = {};

  // Número da CAT
  let num = findCatNumber(fullText);
  if (num) num = num.replace(/[^\d\/]/g,'');
  meta.numeroCat = num || null;

  // Profissional
  meta.profissional = extractFirst(/(?:Profissional|Respons[aá]vel T[eé]cnico)\s*[:\-]\s*([^\n]+)/i, fullText);

  // Registro / CREA
  let registro = null;
  const mCrea1 = /CREA[-\s]*([A-Z]{2})\s*([0-9]{6,})/i.exec(fullText);
  if (mCrea1) {
    registro = `${mCrea1[1]}${mCrea1[2]}`;
  } else {
    const mReg = /Registro\s*[:\-]\s*([A-Z]{2})\s*([0-9]{6,})/i.exec(fullText);
    if (mReg) registro = `${mReg[1]}${mReg[2]}`;
  }
  if (!registro) {
    registro = extractFirst(/Registro\s*[:\-]\s*([A-Z]{2}\d{6,})/i, fullText) ||
               extractFirst(/CREA[-\s]*([A-Z]{2}\d{6,})/i, fullText) || null;
  }
  meta.registro = registro || null;

  // UF CREA
  meta.creaUF = extractFirst(/\bCREA[-\s]*([A-Z]{2})\b/i, fullText) || null;

  // Objeto / Título
  meta.tituloObraServico =
    extractFirst(/(?:Objeto|Obra|Servi[cç]o)\s*[:\-]\s*([^\n]+)/i, fullText) || null;

  if (!meta.tituloObraServico) {
    const mObs = /Observa[cç][õo]es\s*:\s*Objeto\s*:\s*([\s\S]+?)(?:\n[A-Z][^\n]*:|Assinatura|Registro|Data|$)/i.exec(fullText);
    if (mObs) {
      const bloco = mObs[1].replace(/\s+/g, ' ').trim();
      const s = /(.{20,300}?[\.\!\?])/.exec(bloco);
      meta.tituloObraServico = (s ? s[1] : bloco).trim();
    }
  }

  meta.orgaoEmissor = extractFirst(/(?:Conselho|Emitente|Emissor)\s*[:\-]\s*([^\n]+)/i, fullText) || null;

  return cleanObj(meta);
}

function extractAtestadoMeta(fullText = '') {
  const meta = { tipo: 'ATESTADO' };
  meta.orgaoContratante = extractFirst(/(?:Contratante|Emitente|[ÓO]rg[aã]o)\s*[:\-]\s*([^\n]+)/i, fullText);
  meta.contratada = extractFirst(/(?:Contratada|Empresa)\s*[:\-]\s*([^\n]+)/i, fullText);
  meta.objeto = extractFirst(/(?:Objeto|Finalidade)\s*[:\-]\s*([^\n]+)/i, fullText);

  const mats = extractAll(/\b(lumin[aá]ria[s]?\s*led[^\n]*)/ig, fullText);
  const potenciasW = extractAll(/(\d{2,4})\s*W\b/ig, fullText, (v) => parseInt(v, 10)).filter(n => !Number.isNaN(n));
  const temperaturaK = extractAll(/\b(\d{3,5})\s*K\b/ig, fullText, (v) => parseInt(v, 10)).filter(n => !Number.isNaN(n));

  meta.materiaisTexto = mats;
  meta.potenciasW = Array.from(new Set(potenciasW)).sort((a,b)=>a-b);
  meta.temperaturaCorK = Array.from(new Set(temperaturaK)).sort((a,b)=>a-b);

  meta.quantidades = extractAll(/\b(?:quantidade|qtd\.?)\s*[:\-]?\s*([\d\.\,]+)/ig, fullText);
  meta.periodoExecucao = extractFirst(/(?:Per[ií]odo|Execu[cç][aã]o|Vig[eê]ncia)\s*[:\-]\s*([^\n]+)/i, fullText);
  meta.local = extractFirst(/(?:Local|Munic[ií]pio|Cidade)\s*[:\-]\s*([^\n]+)/i, fullText);
  meta.dataEmissao = extractFirst(/(?:Data|Emiss[aã]o)\s*[:\-]\s*([^\n]+)/i, fullText);
  meta.assinante = extractFirst(/(?:Assinatura|Respons[aá]vel|Fiscal)\s*[:\-]\s*([^\n]+)/i, fullText);

  return cleanObj(meta);
}

function classifyAndExtract(fullText = '', fileName = '') {
  const docType = classifyDoc(fullText, fileName);
  const meta = {};
  if (docType === 'CAT' || docType === 'CAT_ATESTADO_MISTO') meta.cat = extractCatMeta(fullText);
  if (docType === 'ATESTADO' || docType === 'CAT_ATESTADO_MISTO') meta.atestado = extractAtestadoMeta(fullText);

  const numeroCat = meta?.cat?.numeroCat || findCatNumber(fullText) || null;
  const linkKeys = {
    numeroCat,
    possiveisPotencias: meta?.atestado?.potenciasW || [],
  };
  return { docType, meta: cleanObj(meta), linkKeys };
}

/* ========= STATE p/ multi-empresa: qual job está rodando por companyId ====== */
const runningByCompany = new Map(); // companyId(string) -> jobId

/* ========= LOGS helper ========= */
function appendLog(jobId, text) {
  const job = getJob(jobId);
  if (!job) return;
  const prev = Array.isArray(job.logs) ? job.logs : [];
  prev.push(`[${new Date().toLocaleTimeString('pt-BR')}] ${text}`);
  if (prev.length > 1200) prev.splice(0, prev.length - 1200);
  updateJob(jobId, { logs: prev });
}

// ===== ingest de um arquivo ==================================================
async function ingestSingleCatFile(filePath, { force = false, companyId, rootDir, jobId }) {
  const relDir  = path.relative(rootDir, path.dirname(filePath));
  const gestor  = (relDir.split(path.sep)[0] || 'desconhecido').trim();
  const fileName = path.basename(filePath);
  const source   = `${gestor}/${fileName}`;

  appendLog(jobId, `🔍 Lendo: ${source}`);

  const exists = await Cats.findBySource(companyId, source);
  if (exists && !force) {
    appendLog(jobId, `⏭️ Pulando ${source} (já existe)`);
    return { source, skipped: true, reason: 'exists', chunkCount: exists.chunkCount || 0 };
  }

  const ext = path.extname(fileName).toLowerCase();
  let fullText = '';
  try {
    if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      fullText = await extractTextFromPdf(buf, filePath);
    } else {
      fullText = await extractTextFromImage(filePath);
    }
  } catch (e) {
    appendLog(jobId, `❌ OCR falhou em ${fileName}: ${e.message}`);
    return { source, skipped: true, reason: 'ocr_error' };
  }

  fullText = normalizeSpaces(fullText || '');
  if (!fullText) {
    appendLog(jobId, `⚠️ Sem texto em ${source}`);
    return { source, skipped: true, reason: 'no_text' };
  }

  const { docType, meta, linkKeys } = classifyAndExtract(fullText, fileName);
  appendLog(jobId, `📄 Tipo: ${docType}`);

  // === entidades universais (baseline + opcional LLM)
  let entities = [];
  try {
    const domainHint = detectDomain(fullText);
    entities = await extractSpecs(fullText, { domainHint });
  } catch (e) {
    appendLog(jobId, `⚠️ extractSpecs falhou: ${e.message}`);
  }

  // === domínio + atestados consolidados + keywords
  const domain = detectDomain(fullText);
  const atestadosLimpos = extractAtestadosLimpos(fullText);
  meta.atestadosLimpos = atestadosLimpos;

  const keywords = buildKeywords({
    docType,
    meta,
    domain,
    atestadosLimpos,
    linkKeys,
    fileName,
  });

  const chunks = [];
  for (const text of chunkTextGenerator(fullText)) {
    chunks.push({ text, embedding: await embedText(text) });
    if (chunks.length % 5 === 0) appendLog(jobId, `📦 ${chunks.length} chunks gerados para ${fileName}`);
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 40)));
  }
  const chunkCount = chunks.length;
  await Cats.replace({
    companyId, source, fileName, gestor, fullText, docType, meta: { ...meta, entities },
    linkKeys, domain, keywords, processedAt: new Date(),
  }, chunks);

  appendLog(jobId, `✅ Finalizado ${source} (${chunkCount} chunks)`);
  return {
    source,
    chunkCount,
    docType,
    metaSummary: Object.keys(meta),
    entitiesCount: entities.length
  };
}

// ===== executor do job (por empresa) =========================================
async function runSyncJob(jobId, { force, companyId }) {
  const job = getJob(jobId);
  if (!job) return;

  const companyRoot = path.resolve(CATS_ROOT, String(companyId));
  updateJob(jobId, { phase: 'Localizando arquivos...', meta: { ...job.meta, root: companyRoot } });
  appendLog(jobId, `📁 Raiz: ${companyRoot}`);

  const files = safeWalk(companyRoot).filter(f => ALLOWED_EXT.test(f));
  const total = files.length;

  if (!files.length) {
    appendLog(jobId, '⚠️ Nenhum arquivo encontrado para esta empresa.');
    const result = { ok: true, message: 'Nenhum arquivo encontrado para esta empresa.', processed: 0, root: companyRoot };
    completeJob(jobId, result);
    runningByCompany.delete(String(companyId));
    return result;
  }

  try {
    let processed = 0;
    const results = [];

    appendLog(jobId, `🚀 Iniciando processamento de ${total} arquivo(s)`);
    updateJob(jobId, { phase: 'Processando arquivos', total, done: 0, pct: 1 });

    for (const fp of files) {
      const rel = path.relative(companyRoot, fp);
      updateJob(jobId, { phase: `Lendo: ${rel}` });

      const res = await ingestSingleCatFile(fp, { force, companyId, rootDir: companyRoot, jobId });
      results.push(res);

      processed += 1;
      const pct = Math.max(1, Math.round((processed / total) * 100));
      updateJob(jobId, { done: processed, pct });
    }

    const summary = { ok: true, root: companyRoot, processed: results.length, results, force };
    appendLog(jobId, '🎯 Sincronização concluída!');
    completeJob(jobId, summary);
    runningByCompany.delete(String(companyId));
    return summary;
  } catch (e) {
    appendLog(jobId, `💥 Erro crítico: ${e.message}`);
    failJob(jobId, e);
    runningByCompany.delete(String(companyId));
    return null;
  }
}

// ====== listagem e contagem por empresa =====================================
function sanitizeCat(doc) {
  const {
    _id, source, fileName, gestor, chunkCount, processedAt, docType, meta, linkKeys, domain, keywords
  } = doc;
  return {
    id: String(_id),
    source,
    fileName,
    gestor,
    docType: docType || null,
    meta: meta || null,
    linkKeys: linkKeys || null,
    domain: domain || null,       // novo
    keywords: keywords || [],     // novo
    chunkCount: chunkCount || 0,
    processedAt
  };
}

// GET /api/cats?limit=&skip=&q=
async function listCats(req, res) {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const skip = Math.max(0, Math.min(parseInt(req.query.skip, 10) || 0, Number.MAX_SAFE_INTEGER));
    const items = await Cats.list(req.companyId, { limit, skip, search: String(req.query.q || '').trim() });

    res.json({ items: items.map(sanitizeCat), limit, skip });
  } catch (e) {
    console.error('listCats error:', e);
    res.status(500).json({ error: 'Erro ao listar CATs.' });
  }
}

// GET /api/cats/count
async function getCatsCount(req, res) {
  try {
    const total = await Cats.count(req.companyId);
    res.json({ total });
  } catch (e) {
    console.error('[getCatsCount] erro:', e);
    res.status(500).json({ error: 'Falha ao obter total de CATs', details: e.message });
  }
}

// ====== sync from disk (por empresa) ========================================
// POST /api/cats/sync-from-disk?force=0|1&async=0|1
async function syncFromDisk(req, res) {
  try {
    const force = String(req.query.force || '0') === '1';
    const asyncMode = String(req.query.async || '0') === '1';
    const companyId = String(req.companyId);

    // se já há job para esta empresa, retorna o mesmo job
    if (runningByCompany.has(companyId)) {
      const runningJobId = runningByCompany.get(companyId);
      const job = getJob(runningJobId);
      if (job && job.status === 'running' && job.meta?.companyId === companyId) {
        return res.status(200).json({ jobId: runningJobId, status: 'running' });
      } else {
        runningByCompany.delete(companyId);
      }
    }

    // cria SEMPRE um job (para permitir progresso/logs em qualquer modo)
    const job = createJob({ companyId, force, logs: [] });
    const jobId = job.id;
    runningByCompany.set(companyId, jobId);

    const companyRoot = path.resolve(CATS_ROOT, companyId);
    updateJob(jobId, { phase: 'Inicializando', meta: { companyId, force, root: companyRoot }, pct: 0 });
    appendLog(jobId, `🧩 Job criado para empresa ${companyId}`);

    if (asyncMode) {
      // responde já com jobId e roda em background
      res.json({ jobId, status: 'running' });
      setImmediate(() => runSyncJob(jobId, { force, companyId }));
      return;
    }

    // modo síncrono: atualiza o job (barra anda e logs aparecem)
    const result = await runSyncJob(jobId, { force, companyId });
    // retorna o resultado + jobId (para logging/consulta posterior)
    return res.json({ jobId, ...(result || { ok: false }) });
  } catch (e) {
    console.error('cats sync error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// GET /api/cats/sync-status?jobId=...
async function syncStatus(req, res) {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'jobId é obrigatório' });

  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });

  // escopo por empresa
  if (job.meta?.companyId !== String(req.companyId)) {
    return res.status(403).json({ error: 'Job não pertence a esta empresa.' });
  }

  const payload = {
    jobId: job.id,
    status: job.status === 'done' ? 'completed' : job.status === 'error' ? 'failed' : 'running',
    progress: typeof job.pct === 'number' ? job.pct : null,
    processed: job.done ?? 0,
    total: job.total ?? 0,
    phase: job.phase || null,
    logs: job.logs || [], // <<<<<< devolve logs para o terminal
  };

  if (job.status === 'done') {
    payload.result = job.result || { ok: true };
  } else if (job.status === 'error') {
    payload.error = job.error || 'Falha na sincronização.';
  }

  return res.json(payload);
}

// ===== Upload (sempre com companyId) ========================================
// POST /api/cats/upload  (campo "files")
async function uploadCats(req, res) {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const companyId = req.companyId;
    const gestor = String(req.body?.gestor || '').trim() || 'desconhecido';
    const isPathComponent = name => name && name !== '.' && name !== '..' &&
      name.length <= 255 && !/[\\/:*?"<>|\x00-\x1f]/.test(name);
    if (!isPathComponent(gestor) || req.files.some(file => !isPathComponent(file.originalname))) {
      return res.status(400).json({ error: 'Gestor ou nome de arquivo inválido.' });
    }
    const results = [];

    const companyRoot = path.resolve(CATS_ROOT, String(companyId));
    const targetDir   = path.join(companyRoot, gestor);

    fs.mkdirSync(targetDir, { recursive: true });

    for (const f of req.files) {
      const diskPath = f.path;
      const savedPath = path.join(targetDir, f.originalname);
      const targetVirtual = `${gestor}/${f.originalname}`;

      const ext = path.extname(f.originalname).toLowerCase();
      let fullText = '';
      if (ext === '.pdf') {
        const buf = fs.readFileSync(diskPath);
        fullText = await extractTextFromPdf(buf, f.originalname);
      } else {
        fullText = await extractTextFromImage(diskPath, f.originalname);
      }

      fullText = normalizeSpaces(fullText || '');
      if (!fullText) {
        const existing = await Cats.findBySource(companyId, targetVirtual);
        if (!existing) await fs.promises.copyFile(diskPath, savedPath);
        results.push({ source: targetVirtual, savedPath, skipped: true, reason: 'no_text' });
      } else {
        const { docType, meta, linkKeys } = classifyAndExtract(fullText, f.originalname);

        // === entidades universais
        let entities = [];
        try {
          const domainHint = detectDomain(fullText);
          entities = await extractSpecs(fullText, { domainHint });
        } catch (e) {
          console.warn('[catsController] extractSpecs (upload) falhou:', e.message);
        }

        // === domínio + atestados consolidados + keywords
        const domain = detectDomain(fullText);
        const atestadosLimpos = extractAtestadosLimpos(fullText);
        meta.atestadosLimpos = atestadosLimpos;

        const keywords = buildKeywords({
          docType,
          meta,
          domain,
          atestadosLimpos,
          linkKeys,
          fileName: f.originalname,
        });

        const chunks = [];
        for (const text of chunkTextGenerator(fullText)) {
          chunks.push({ text, embedding: await embedText(text) });
          await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 40)));
        }
        const chunkCount = chunks.length;
        await Cats.replace({
          companyId, source: targetVirtual, fileName: f.originalname, gestor, fullText, docType,
          meta: { ...meta, entities }, linkKeys, domain, keywords, processedAt: new Date(),
        }, chunks);
        await fs.promises.copyFile(diskPath, savedPath);

        results.push({
          source: targetVirtual,
          savedPath,
          chunkCount,
          docType,
          metaSummary: Object.keys(meta),
          entitiesCount: entities.length
        });
      }

    }

    res.json({ ok: true, companyId, gestor, processed: results.length, results });
  } catch (e) {
    console.error('cats upload error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    await Promise.allSettled((req.files || []).map(file => fs.promises.unlink(file.path)));
  }
}

module.exports = {
  listCats,
  getCatsCount,
  syncFromDisk,
  syncStatus,
  uploadCats,
};
