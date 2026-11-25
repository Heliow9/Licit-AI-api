// src/routes/catsRoutes.js
const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const upload = multer({ dest: path.join(__dirname, '..', '..', 'uploads') });

const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireCompany } = require('../middlewares/companyScope');
const ctrl = require('../controllers/catsController');
const { getJob, sseSubscribe } = require('../jobs/progress');

// Todas exigem auth + company
router.use(authMiddleware(), requireCompany);

// Listagem/contagem
router.get('/', ctrl.listCats);
router.get('/count', ctrl.getCatsCount);

// Sync por empresa
router.post('/sync-from-disk', ctrl.syncFromDisk);
router.get('/sync-status', ctrl.syncStatus);

// Uploads
router.post('/upload', upload.array('files', 50), ctrl.uploadCats);
router.get('/sync-events/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.sendStatus(404);
  if (job.meta?.companyId !== String(req.companyId)) return res.sendStatus(403);
  return sseSubscribe(req, res, job.id);
});

// ===== DEBUG opcional do FS (ligar com DEBUG_FS=1 no .env) ===================
const { DEBUG_FS, CATS_ROOT } = require('../Config/env');
if (DEBUG_FS) {
  const fs = require('fs');
  const { walkFiles } = require('../utils/files');
  router.get('/debug/fs', (req, res) => {
    const companyRoot = path.resolve(CATS_ROOT, String(req.companyId));
    const exists = fs.existsSync(companyRoot);
    const files = exists ? walkFiles(companyRoot) : [];
    res.json({
      companyRoot,
      exists,
      count: files.length,
      sample: files.slice(0, 50),
    });
  });
}

module.exports = router;
