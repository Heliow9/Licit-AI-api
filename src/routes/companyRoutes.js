const express = require('express');
const router = express.Router();

// Importa o middleware de autenticação
const { authMiddleware, requireRole } = require('../middlewares/authMiddleware');

// Controllers
const {
  getMyCompany,
  updateMyCompany
} = require('../controllers/companyController');

// Instancia o middleware
const auth = authMiddleware();

/**
 * @route   GET /api/company/my
 * @desc    Retorna os dados da empresa vinculada ao usuário logado
 * @access  Autenticado
 */
router.get('/my', auth, getMyCompany);

/**
 * @route   PATCH /api/company/my
 * @desc    Atualiza os dados da empresa vinculada (apenas owner/admin)
 * @access  owner | admin
 */
router.patch('/my', auth, requireRole('owner', 'admin'), updateMyCompany);

module.exports = router;
