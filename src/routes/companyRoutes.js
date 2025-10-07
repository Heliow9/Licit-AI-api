// src/routes/companyRoutes.js
const express = require('express');
const router = express.Router();

const { authMiddleware, requireRole } = require('../middlewares/authMiddleware');
const {
  getMyCompany,
  updateMyCompany,
  getComplianceChecklist,
  updateComplianceChecklist,
} = require('../controllers/companyController');

const auth = authMiddleware();

// Dados da empresa
router.get('/my', auth, getMyCompany);
router.patch('/my', auth, requireRole('owner', 'admin'), updateMyCompany);

// Checklist de exigências
router.get('/my/checklist', auth, getComplianceChecklist);
router.patch('/my/checklist', auth, requireRole('owner', 'admin'), updateComplianceChecklist);

module.exports = router;
