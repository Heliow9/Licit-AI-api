// src/controllers/catsController.js
const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const { getDb } = require('../Config/db');
const { CATS_ROOT } = require('../Config/env');
const { walkFiles } = require('../utils/files');
const { extractTextFromPdf, extractTextFromImage } = require('../utils/ocr');
const { normalizeSpaces } = require('../utils/text');
const { embedText } = require('../services/azure');
const { chunkTextGenerator } = require('../utils/text');

const catsCollectionName   = 'cats';
const chunksCollectionName = 'chunks';

// ===== helpers =====
const oid = (v) => (typeof v === 'string' ? new ObjectId(v) : v);
const safeWalk = (dir) => (fs.existsSync(dir) ? walkFiles(dir) : []);

// ===== JOB STATE (in-memory) =================================================
let currentJob = null; // { id, status, startedAt, force, companyId, total, processed, progress, results[], error, finishedAt }

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ===== ingest de um arquivo ==================================================
async function ingestSingleCatFile(filePath, { force = false, companyId, rootDir }) {
  const db = await getDb();
  const catsCol = db.collection(catsCollectionName);
  const chunksCol = db.collection(chunksCollectionName);

  // gestor = 1º nível abaixo do rootDir
  const relDir  = path.relative(rootDir, path.dirname(filePath));
  const gestor  = (relDir.split(path.sep)[0] || 'desconhecido').trim();
  const fileName = path.basename(filePath);
  const source   = `${gestor}/${fileName}`; // identificador lógico dentro da empresa

  // upsert/consulta SEMPRE incluem companyId
  const exists = await catsCol.findOne({ companyId: oid(companyId), source });
  if (exists && !force) {
    return { source, skipped: true, reason: 'exists', chunkCount: exists.chunkCount || 0 };
  }

  const ext = path.extname(fileName).toLowerCase();
  let fullText = '';
  if (ext === '.pdf') {
    const buf = fs.readFileSync(filePath);
    fullText = await extractTextFromPdf(buf, filePath);
  } else {
    fullText = await extractTextFromImage(filePath);
  }
  fullText = normalizeSpaces(fullText || '');
  if (!fullText) {
    return { source, skipped: true, reason: 'no_text' };
  }

  await chunksCol.deleteMany({ companyId: oid(companyId), source });
  await catsCol.updateOne(
    { companyId: oid(companyId), source },
    {
      $set: {
        companyId: oid(companyId),
        source,
        fileName,
        gestor,
        fullText,
        processedAt: new Date(),
      },
    },
    { upsert: true }
  );

  let idx = 0, chunkCount = 0;
  for (const ctext of chunkTextGenerator(fullText)) {
    const emb = await embedText(ctext);
    await chunksCol.insertOne({
      companyId: oid(companyId),
      source,
      gestor,
      chunkIndex: idx++,
      text: ctext,
      embedding: emb,
    });
    chunkCount++;
    await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 40)));
  }
  await catsCol.updateOne({ companyId: oid(companyId), source }, { $set: { chunkCount } });
  return { source, chunkCount };
}

// ===== executor do job (somente pasta da empresa) ============================
async function runSyncJob(force) {
  const companyId = currentJob.companyId;
  const companyRoot = path.join(CATS_ROOT, String(companyId));
  const files = safeWalk(companyRoot);

  currentJob.total = files.length;
  currentJob.results = [];

  if (!files.length) {
    currentJob.status = 'completed';
    currentJob.progress = 100;
    currentJob.finishedAt = new Date();
    currentJob.summary = { ok: true, message: 'Nenhum arquivo encontrado para esta empresa.', processed: 0 };
    return;
  }

  try {
    let processed = 0;
    for (const fp of files) {
      if (!currentJob || currentJob.status !== 'running') break;

      const res = await ingestSingleCatFile(fp, { force, companyId, rootDir: companyRoot });
      currentJob.results.push(res);
      processed += 1;
      currentJob.processed = processed;
      currentJob.progress = Math.round((processed / currentJob.total) * 100);
    }

    if (currentJob) {
      currentJob.status = 'completed';
      currentJob.finishedAt = new Date();
      currentJob.summary = {
        ok: true,
        root: companyRoot,
        processed: currentJob.results.length,
        results: currentJob.results,
      };
    }
  } catch (e) {
    if (currentJob) {
      currentJob.status = 'failed';
      currentJob.error = e.message || String(e);
      currentJob.finishedAt = new Date();
    }
  }
}

// ====== listagem e contagem por empresa =====================================
function sanitizeCat(doc) {
  const { _id, source, fileName, gestor, chunkCount, processedAt } = doc;
  return { id: String(_id), source, fileName, gestor, chunkCount: chunkCount || 0, processedAt };
}

// GET /api/cats?limit=&skip=&q=
async function listCats(req, res) {
  try {
    const db = await getDb();
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const skip  = Math.max(parseInt(req.query.skip  || '0', 10), 0);
    const q     = String(req.query.q || '').trim();

    const filter = { companyId: oid(req.companyId) };
    if (q) {
      const s = q.toLowerCase();
      filter.$or = [
        { source:   { $regex: s, $options: 'i' } },
        { gestor:   { $regex: s, $options: 'i' } },
        { fileName: { $regex: s, $options: 'i' } },
      ];
    }

    const items = await db.collection(catsCollectionName)
      .find(filter)
      .sort({ processedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({ items: items.map(sanitizeCat), limit, skip });
  } catch (e) {
    console.error('listCats error:', e);
    res.status(500).json({ error: 'Erro ao listar CATs.' });
  }
}

// GET /api/cats/count
async function getCatsCount(req, res) {
  try {
    const db = await getDb();
    const total = await db.collection(catsCollectionName).countDocuments({ companyId: oid(req.companyId) });
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
    const companyId = req.companyId;

    if (currentJob && currentJob.status === 'running' && currentJob.companyId === companyId) {
      return res.status(200).json({ jobId: currentJob.id, status: currentJob.status });
    }

    const companyRoot = path.join(CATS_ROOT, String(companyId));

    if (asyncMode) {
      currentJob = {
        id: newId(),
        status: 'running',
        startedAt: new Date(),
        force,
        companyId,
        total: 0,
        processed: 0,
        progress: 0,
        results: [],
      };
      runSyncJob(force); // fire-and-forget
      return res.json({ jobId: currentJob.id, status: 'running' });
    }

    // modo síncrono
    const files = safeWalk(companyRoot);
    if (!files.length) {
      return res.json({ ok: true, message: 'Nenhum arquivo encontrado para esta empresa.', processed: 0 });
    }
    const out = [];
    for (const fp of files) out.push(await ingestSingleCatFile(fp, { force, companyId, rootDir: companyRoot }));
    return res.json({ ok: true, root: companyRoot, processed: out.length, results: out });
  } catch (e) {
    console.error('cats sync error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// GET /api/cats/sync-status?jobId=...
async function syncStatus(req, res) {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'jobId é obrigatório' });

  if (!currentJob || currentJob.id !== jobId) {
    return res.status(404).json({ error: 'Job não encontrado' });
  }

  // ⛔️ segurança: não vazar status de job de outra empresa
  if (currentJob.companyId !== req.companyId) {
    return res.status(403).json({ error: 'Job não pertence a esta empresa.' });
  }

  const payload = {
    jobId: currentJob.id,
    status: currentJob.status,
    progress: currentJob.progress ?? null,
    processed: currentJob.processed ?? 0,
    total: currentJob.total ?? 0,
  };

  if (currentJob.status === 'completed') {
    payload.result = currentJob.summary || { ok: true };
  } else if (currentJob.status === 'failed') {
    payload.error = currentJob.error || 'Falha na sincronização.';
  }

  return res.json(payload);
}

// ===== Upload (sempre com companyId) ========================================
// src/controllers/catsController.js (trecho: uploadCats)
async function uploadCats(req, res) {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const companyId = req.companyId;
    const gestor = String(req.body?.gestor || 'desconhecido').trim();
    const results = [];

    // Caminhos de destino onde manteremos cópia física
    const companyRoot = path.join(CATS_ROOT, String(companyId));
    const targetDir   = path.join(companyRoot, gestor);

    // Garante estrutura: CATS_ROOT/<companyId>/<gestor>
    fs.mkdirSync(targetDir, { recursive: true });

    for (const f of req.files) {
      const diskPath = f.path;                  // temp do multer
      const savedPath = path.join(targetDir, f.originalname); // destino final
      const targetVirtual = `${gestor}/${f.originalname}`;

      // Se ainda não existe no FS, copia; se já existe, sobrescreve (ajuste se quiser manter)
      await fs.promises.copyFile(diskPath, savedPath);

      // Agora processa SEMPRE a partir do arquivo salvo em disco (savedPath)
      const ext = path.extname(f.originalname).toLowerCase();
      let fullText = '';
      if (ext === '.pdf') {
        const buf = fs.readFileSync(savedPath);
        fullText = await extractTextFromPdf(buf, savedPath);
      } else {
        fullText = await extractTextFromImage(savedPath);
      }

      const db = await getDb();
      const catsCol = db.collection(catsCollectionName);
      const chunksCol = db.collection(chunksCollectionName);

      fullText = normalizeSpaces(fullText || '');
      if (!fullText) {
        results.push({ source: targetVirtual, savedPath, skipped: true, reason: 'no_text' });
      } else {
        await chunksCol.deleteMany({ companyId: oid(companyId), source: targetVirtual });
        await catsCol.updateOne(
          { companyId: oid(companyId), source: targetVirtual },
          {
            $set: {
              companyId: oid(companyId),
              source: targetVirtual,
              fileName: f.originalname,
              gestor,
              fullText,
              processedAt: new Date(),
            },
          },
          { upsert: true }
        );

        let idx = 0, chunkCount = 0;
        for (const ctext of chunkTextGenerator(fullText)) {
          const emb = await embedText(ctext);
          await chunksCol.insertOne({
            companyId: oid(companyId),
            source: targetVirtual,
            gestor,
            chunkIndex: idx++,
            text: ctext,
            embedding: emb,
          });
          chunkCount++;
          await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 40)));
        }

        await catsCol.updateOne(
          { companyId: oid(companyId), source: targetVirtual },
          { $set: { chunkCount } }
        );

        results.push({ source: targetVirtual, savedPath, chunkCount });
      }

      // Remove o temporário do multer
      try { fs.unlinkSync(diskPath); } catch {}
    }

    res.json({ ok: true, companyId, gestor, processed: results.length, results });
  } catch (e) {
    console.error('cats upload error:', e);
    res.status(500).json({ error: e.message });
  }
}


module.exports = {
  listCats,
  getCatsCount,
  syncFromDisk,
  syncStatus,
  uploadCats,
};
