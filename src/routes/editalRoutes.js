// src/routes/editalRoutes.js
const { Router } = require('express');
const path = require('path');
const multer = require('multer');

const {
  analisarEdital,
  gerarPdfFromBody,
  listarHistorico,
  serveReportByName,
} = require('../controllers/editalController');

const { analisarEditalCore } = require('../controllers/editalControllerCore');
const { createJob, getJob, updateJob, completeJob, failJob, sseSubscribe } = require('../jobs/progress');

// Auth (para req.companyId / req.auth)
const { authMiddleware } = require('../middlewares/authMiddleware');
const auth = authMiddleware();

const router = Router();

const upload = multer({
  dest: path.join(process.cwd(), 'tmp', 'uploads'),
  limits: { fileSize: 40 * 1024 * 1024 }
});

/* ===== Helper para SSE: aceita token via query (EventSource não envia Authorization) ===== */
function bearerFromQuery(req, _res, next) {
  if (!req.headers.authorization && req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

/* ========= Rotas síncronas (legado) ========= */
router.post(
  '/analisar',
  auth,
  upload.fields([{ name: 'editalPdf', maxCount: 1 }, { name: 'arquivos[]', maxCount: 20 }]),
  analisarEdital
);

/* ========= Fluxo assíncrono ========= */
// START
router.post(
  '/analisar/start',
  auth,
  upload.fields([{ name: 'editalPdf', maxCount: 10 }, { name: 'arquivos[]', maxCount: 20 }]),
  async (req, res) => {
    try {
      if (!req.files || !req.files.editalPdf || req.files.editalPdf.length < 1) {
        return res.status(400).json({ error: 'Envie ao menos 1 editalPdf.' });
      }
      const mainEditalFile = req.files.editalPdf[0];
      const annexFiles = req.files['arquivos[]'] || [];
      const companyId = req.companyId || req.auth?.companyId || null;
      const userId = req.userId || req.auth?.userId || null;

      const job = createJob({
        filename: mainEditalFile.originalname,
        companyId,
        userId
      });

      setImmediate(async () => {
        try {
          const onProgress = (pct, phase) => updateJob(job.id, { pct, phase });
          const result = await analisarEditalCore(
            { mainEditalFile, annexFiles },
            onProgress,
            { companyId }
          );
          completeJob(job.id, result);
        } catch (err) {
          console.error('[jobs] fail:', err?.stack || err);
          failJob(job.id, err?.message || 'Erro interno');
        }
      });

      return res.json({ jobId: job.id });
    } catch (e) {
      console.error('/analisar/start error:', e);
      return res.status(500).json({ error: 'Falha ao iniciar análise.', details: e.message });
    }
  }
);

// STATUS (polling)
router.get('/analisar/status/:id', auth, (req, res) => {
  try {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

    if (job.meta?.companyId && job.meta.companyId !== (req.companyId || req.auth?.companyId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { id, status, pct, phase, startedAt, finishedAt, meta } = job;
    return res.json({ id, status, pct, phase, startedAt, finishedAt, meta });
  } catch (e) {
    console.error('/analisar/status error:', e);
    return res.status(500).json({ error: 'Falha ao consultar status.', details: e.message });
  }
});

// STREAM (SSE) — aceita token via query
router.get('/analisar/stream/:id', bearerFromQuery, auth, (req, res) => {
  try {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
    if (job.meta?.companyId && job.meta.companyId !== (req.companyId || req.auth?.companyId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    sseSubscribe(req, res, req.params.id);
  } catch (e) {
    console.error('/analisar/stream error:', e);
    return res.status(500).json({ error: 'Falha no stream.', details: e.message });
  }
});

// RESULT
router.get('/analisar/result/:id', auth, (req, res) => {
  try {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

    if (job.meta?.companyId && job.meta.companyId !== (req.companyId || req.auth?.companyId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (job.status !== 'done') {
      return res.status(202).json({
        status: job.status,
        pct: job.pct ?? 0,
        phase: job.phase ?? 'Processando'
      });
    }

    const result = job.result || {};
    const safe = {
      report: typeof result.report === 'string' ? result.report : '',
      pdf: result.pdf && result.pdf.url ? result.pdf : null
    };

    return res.json(safe);
  } catch (e) {
    console.error('/analisar/result error:', e);
    return res.status(500).json({ error: 'Falha ao obter resultado final.', details: e.message });
  }
});

/* ========= Utilidades ========= */
router.post('/gerar-pdf', auth, require('express').json({ limit: '2mb' }), gerarPdfFromBody);
router.get('/analisar/history', auth, listarHistorico);
router.get('/report/:name', auth, serveReportByName);

module.exports = router;
