// src/routes/settingsRoutes.js
const router = require('express').Router();
const { authMiddleware } = require('../middlewares/authMiddleware');
const {
  getMySettings,
  updateMySettings,
  changeMyPassword,
} = require('../controllers/settingsController');

const auth = authMiddleware();

// Perfil do usuário logado
router.get('/settings', auth, getMySettings);
router.patch('/settings', auth, updateMySettings);
router.patch('/password', auth, changeMyPassword);

module.exports = router;
