// src/controllers/companyUsersController.js
const bcrypt = require('bcryptjs');
const Users = require('../models/userModel');
const { BCRYPT_ROUNDS } = require('../Config/env');

/** Retorna apenas campos seguros para o frontend */
function sanitize(u) {
  if (!u) return null;
  const { _id, email, name, role, status, createdAt } = u;
  return { id: String(_id), email, name: name || null, role, status, createdAt };
}

/** Gera senha aleatória simples para convite/reset (caso não seja informada) */
function genTempPassword(len = 10) {
  return Math.random().toString(36).slice(2, 2 + len);
}

/**
 * GET /api/company/users
 * Lista usuários da empresa do logado (owner/admin)
 */
async function listUsers(req, res) {
  try {
    if (!req.auth?.companyId) {
      return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });
    }
    const users = await Users.findAllByCompany(req.auth.companyId);
    return res.json({ users: users.map(sanitize) });
  } catch (e) {
    console.error('listUsers error:', e);
    return res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
}

/**
 * POST /api/company/users/invite
 * Cria/Convida um usuário para a empresa do logado (owner/admin)
 * body: { email, name?, role='user', tempPassword? }
 */
async function inviteUser(req, res) {
  try {
    if (!req.auth?.companyId) {
      return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });
    }
    const { email, name, role = 'user', tempPassword } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email é obrigatório.' });

    const existing = await Users.findByEmail(email);
    if (existing) {
      // Se já existe (mesmo que em outra empresa), por simplicidade bloqueamos
      return res.status(409).json({ error: 'Email já cadastrado.' });
    }

    const rawPass = tempPassword || genTempPassword();
    const passwordHash = await bcrypt.hash(rawPass, BCRYPT_ROUNDS || 10);

    const user = await Users.create({
      email,
      passwordHash,
      name,
      role, // 'user' | 'admin' (owner só manualmente no banco)
      companyId: req.auth.companyId,
      status: 'active'
    });

    // Se quiser enviar a senha temporária por e-mail, faça aqui.
    // Por segurança, não retornamos a senha no response. Logue internamente se necessário.

    return res.status(201).json({ user: sanitize(user) });
  } catch (e) {
    console.error('inviteUser error:', e);
    return res.status(500).json({ error: 'Erro ao convidar/criar usuário.' });
  }
}

/**
 * PATCH /api/company/users/:id
 * Atualiza papel, status ou nome de um usuário da mesma empresa (owner/admin)
 * body: { role?, status?, name? }
 */
async function updateUser(req, res) {
  try {
    const { id } = req.params;
    if (!req.auth?.companyId) {
      return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });
    }
    const target = await Users.findById(id);
    if (!target || String(target.companyId) !== String(req.auth.companyId)) {
      return res.status(404).json({ error: 'Usuário não encontrado nesta empresa.' });
    }

    const { role, status, name } = req.body || {};
    const patch = {};

    // Proteções básicas:
    if (role) {
      if (!['user', 'admin', 'owner'].includes(role)) {
        return res.status(400).json({ error: 'Papel inválido.' });
      }
      // Não permitir rebaixar/promover owner por aqui (evita perder acesso)
      if (target.role === 'owner' && role !== 'owner') {
        return res.status(400).json({ error: 'Não é permitido alterar o papel do owner por esta rota.' });
      }
      if (role === 'owner') {
        return res.status(400).json({ error: 'Criação/transferência de owner não é permitida por esta rota.' });
      }
      patch.role = role;
    }

    if (status) {
      if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido.' });
      }
      // Impede desativar a si mesmo para evitar lockout acidental
      if (String(target._id) === String(req.auth.sub) && status === 'disabled') {
        return res.status(400).json({ error: 'Você não pode desativar seu próprio usuário.' });
      }
      // Nunca desativar o owner
      if (target.role === 'owner' && status === 'disabled') {
        return res.status(400).json({ error: 'Não é permitido desativar o owner.' });
      }
      patch.status = status;
    }

    if (name !== undefined) patch.name = name;

    const updated = await Users.updateById(id, patch);
    return res.json({ user: sanitize(updated) });
  } catch (e) {
    console.error('updateUser error:', e);
    return res.status(500).json({ error: 'Erro ao atualizar usuário.' });
  }
}

/**
 * DELETE /api/company/users/:id
 * Remove um usuário da empresa (owner/admin)
 */
async function removeUser(req, res) {
  try {
    const { id } = req.params;
    if (!req.auth?.companyId) {
      return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });
    }
    const target = await Users.findById(id);
    if (!target || String(target.companyId) !== String(req.auth.companyId)) {
      return res.status(404).json({ error: 'Usuário não encontrado nesta empresa.' });
    }

    // Não remover owner
    if (target.role === 'owner') {
      return res.status(400).json({ error: 'Não é possível remover o owner.' });
    }

    // Evita remover a si mesmo
    if (String(target._id) === String(req.auth.sub)) {
      return res.status(400).json({ error: 'Você não pode remover seu próprio usuário.' });
    }

    await Users.removeById(id);
    return res.status(204).end();
  } catch (e) {
    console.error('removeUser error:', e);
    return res.status(500).json({ error: 'Erro ao remover usuário.' });
  }
}

module.exports = {
  listUsers,
  inviteUser,
  updateUser,
  removeUser
};
