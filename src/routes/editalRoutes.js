// src/routes/editalRoutes.js
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireCompany } = require('../middlewares/companyScope');

const controller = require('../controllers/editalController');

/* ================== Upload dir ================== */
const UPLOAD_DIR = path.resolve(process.cwd(), 'tmp', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
console.log('[editalRoutes] upload dir ready:', UPLOAD_DIR);

/* ================== Multer ================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

/* ================== Auth / Company Scope ================== */
// todas as rotas de edital exigem usuário autenticado e empresa definida
router.use(authMiddleware(), requireCompany);

/* ================== Rotas ================== */
// POST /api/edital/analisar (?async=0|1)
// - async=0  → retorna resultado síncrono (report/pdf/score)
// - async=1  → dispara job; retorna { jobId }, acompanhar via /status ou /events/:jobId
router.post(
  '/analisar',
  upload.fields([
    { name: 'editalPdf',  maxCount: 1  },
    { name: 'arquivos[]', maxCount: 50 },
  ]),
  controller.analisarEdital
);

// GET /api/edital/status?jobId=...
// - polling de progresso: { jobId, status: running|completed|error, progress, result? }
router.get('/status', controller.editalStatus);

// GET /api/edital/events/:jobId
// - Server-Sent Events (tempo real) com { pct, phase, status }
router.get('/events/:jobId', controller.editalEvents);

// POST /api/edital/gerar-pdf
router.post('/gerar-pdf', express.json({ limit: '1mb' }), controller.gerarPdfFromBody);

// GET /api/edital/analisar/history
router.get('/analisar/history', controller.listarHistorico);

// GET /api/edital/report/:name
router.get('/report/:name', controller.serveReportByName);

module.exports = router;
