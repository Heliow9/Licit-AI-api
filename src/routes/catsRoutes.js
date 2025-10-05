// src/routes/catsRoutes.js
const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const upload = multer({ dest: path.join(__dirname, '..', '..', 'uploads') });

const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireCompany } = require('../middlewares/companyScope');
const ctrl = require('../controllers/catsController');

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

module.exports = router;
