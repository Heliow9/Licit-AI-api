// src/controllers/settingsController.js
const bcrypt = require('bcryptjs');
const Users = require('../models/userModel');
const { BCRYPT_ROUNDS } = require('../Config/env');

function sanitize(u) {
  if (!u) return null;
  const { _id, email, name, role, status, companyId, settings, createdAt } = u;
  return {
    id: String(_id),
    email,
    name: name || null,
    role: role || 'user',
    status: status || 'active',
    companyId: companyId ? String(companyId) : null,
    settings: settings || {},
    createdAt,
  };
}

async function getMySettings(req, res) {
  try {
    const me = await Users.findById(req.auth.sub);
    if (!me) return res.status(404).json({ error: 'Usuário não encontrado.' });
    return res.json({ user: sanitize(me) });
  } catch (e) {
    console.error('getMySettings error:', e);
    return res.status(500).json({ error: 'Erro ao carregar seu perfil.' });
  }
}

async function updateMySettings(req, res) {
  try {
    const { name, settings } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (settings && typeof settings === 'object') {
      // merge raso de settings
      patch.settings = settings;
    }
    patch.updatedAt = new Date();

    const updated = await Users.updateById(req.auth.sub, patch);
    return res.json({ user: sanitize(updated) });
  } catch (e) {
    console.error('updateMySettings error:', e);
    return res.status(500).json({ error: 'Erro ao atualizar seu perfil.' });
  }
}

async function changeMyPassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
    }
    const me = await Users.findById(req.auth.sub);
    if (!me) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const ok = await bcrypt.compare(currentPassword, me.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta.' });

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS || 10);
    const updated = await Users.updateById(req.auth.sub, { passwordHash: hash, updatedAt: new Date() });
    return res.json({ user: sanitize(updated) });
  } catch (e) {
    console.error('changeMyPassword error:', e);
    return res.status(500).json({ error: 'Erro ao alterar senha.' });
  }
}

module.exports = { getMySettings, updateMySettings, changeMyPassword };
