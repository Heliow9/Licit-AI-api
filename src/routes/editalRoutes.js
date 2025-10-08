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

// auth: precisamos do companyId/userId em req.auth
const { authMiddleware } = require('../middlewares/authMiddleware');
const auth = authMiddleware();

const router = Router();

const upload = multer({
  dest: path.join(process.cwd(), 'tmp', 'uploads'),
  limits: { fileSize: 40 * 1024 * 1024 }
});

/**
 * Middleware que permite token via query (?token=JWT) — útil para SSE
 * Se não houver Authorization, move ?token= para headers.Authorization.
 */
function authFromQueryToken(req, _res, next) {
  if (!req.headers.authorization && req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

/* ========= Rotas síncronas (opcional) ========= */
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
      const companyId = req.companyId || req.auth?.companyId;
      const userId = req.userId || req.auth?.userId;

      const job = createJob({ filename: mainEditalFile.originalname, companyId, userId });

      setImmediate(async () => {
        try {
          const onProgress = (pct, phase) => updateJob(job.id, { pct, phase });
          const result = await analisarEditalCore({ mainEditalFile, annexFiles }, onProgress, { companyId });
          completeJob(job.id, result);
        } catch (err) {
          failJob(job.id, err?.message || 'Erro interno');
        }
      });

      res.json({ jobId: job.id });
    } catch (e) {
      res.status(500).json({ error: 'Falha ao iniciar análise.', details: e.message });
    }
  }
);

// STATUS (polling)
router.get('/analisar/status/:id', auth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.meta?.companyId && job.meta.companyId !== (req.companyId || req.auth?.companyId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { id, status, pct, phase, startedAt, finishedAt, meta, error } = job;
  res.json({ id, status, pct, phase, startedAt, finishedAt, meta, error });
});

// STREAM (SSE) — aceita token via query (?token=JWT) porque EventSource não envia headers
router.get('/analisar/stream/:id', authFromQueryToken, auth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

  // multi-tenant guard
  if (job.meta?.companyId && job.meta.companyId !== (req.companyId || req.auth?.companyId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  sseSubscribe(req, res, req.params.id);
});

// RESULT final
router.get('/analisar/result/:id', auth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.meta?.companyId && job.meta.companyId !== (req.companyId || req.auth?.companyId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (job.status !== 'done') return res.status(202).json({ status: job.status, pct: job.pct, phase: job.phase });
  res.json(job.result);
});

/* ========= Utilidades para o front ========= */

// Gera PDF a partir de markdown atual
router.post('/gerar-pdf', auth, require('express').json({ limit: '2mb' }), gerarPdfFromBody);

// Histórico de PDFs gerados (deverá filtrar por empresa no controller)
router.get('/analisar/history', auth, listarHistorico);

// Servir PDF específico (vamos ajustar path com companyId quando mexermos na parte de PDFs)
router.get('/report/:name', auth, serveReportByName);

module.exports = router;
