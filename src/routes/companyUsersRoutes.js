// src/routes/companyUsersRoutes.js
const express = require('express');
const router = express.Router();

const { authMiddleware, requireRole } = require('../middlewares/authMiddleware');
const {
  listUsers,
  inviteUser,
  updateUser,
  removeUser
} = require('../controllers/companyUsersController');

const auth = authMiddleware();

/**
 * @route   GET /api/company/users
 * @desc    Lista usuários da empresa do logado
 * @access  owner | admin
 */
router.get('/', auth, requireRole('owner', 'admin'), listUsers);

/**
 * @route   POST /api/company/users/invite
 * @desc    Convida/cria usuário na empresa do logado
 * @access  owner | admin
 */
router.post('/invite', auth, requireRole('owner', 'admin'), inviteUser);

/**
 * @route   PATCH /api/company/users/:id
 * @desc    Atualiza papel/status/nome de um usuário da empresa
 * @access  owner | admin
 */
router.patch('/:id', auth, requireRole('owner', 'admin'), updateUser);

/**
 * @route   DELETE /api/company/users/:id
 * @desc    Remove usuário da empresa (exceto owner)
 * @access  owner | admin
 */
router.delete('/:id', auth, requireRole('owner', 'admin'), removeUser);

module.exports = router;
