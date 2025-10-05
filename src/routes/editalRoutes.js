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

const router = Router();

const upload = multer({
  dest: path.join(process.cwd(), 'tmp', 'uploads'),
  limits: { fileSize: 40 * 1024 * 1024 }
});

/* ========= Rotas síncronas (opcional) ========= */
router.post(
  '/analisar',
  upload.fields([{ name: 'editalPdf', maxCount: 1 }, { name: 'arquivos[]', maxCount: 20 }]),
  analisarEdital
);

/* ========= Fluxo assíncrono ========= */
// START
router.post(
  '/analisar/start',
  upload.fields([{ name: 'editalPdf', maxCount: 10 }, { name: 'arquivos[]', maxCount: 20 }]),
  async (req, res) => {
    try {
      if (!req.files || !req.files.editalPdf || req.files.editalPdf.length < 1) {
        return res.status(400).json({ error: 'Envie ao menos 1 editalPdf.' });
      }
      const mainEditalFile = req.files.editalPdf[0];
      const annexFiles = req.files['arquivos[]'] || [];
      const job = createJob({ filename: mainEditalFile.originalname });

      setImmediate(async () => {
        try {
          const onProgress = (pct, phase) => updateJob(job.id, { pct, phase });
          const result = await analisarEditalCore({ mainEditalFile, annexFiles }, onProgress);
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
router.get('/analisar/status/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  const { id, status, pct, phase, startedAt, finishedAt, meta } = job;
  res.json({ id, status, pct, phase, startedAt, finishedAt, meta });
});

// STREAM (SSE)
router.get('/analisar/stream/:id', (req, res) => {
  sseSubscribe(req, res, req.params.id);
});

// RESULT final
router.get('/analisar/result/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'done') return res.status(202).json({ status: job.status, pct: job.pct, phase: job.phase });
  res.json(job.result);
});

/* ========= Utilidades para o front ========= */

// Gera PDF a partir de markdown atual (botão "Gerar PDF")
router.post('/gerar-pdf', require('express').json({ limit: '2mb' }), gerarPdfFromBody);

// Histórico de PDFs gerados
router.get('/analisar/history', listarHistorico);

// Servir um PDF específico pelo nome
router.get('/report/:name', serveReportByName);

module.exports = router;
