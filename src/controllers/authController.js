// controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { BCRYPT_ROUNDS, JWT_SECRET, JWT_EXPIRES, ALLOW_OPEN_REG } = require('../Config/env');
const Users = require('../models/userModel');
const Companies = require('../models/companyModel');
const { transaction } = require('../Config/db');

function sanitize(u) {
  if (!u) return null;
  const { _id, email, name, role, createdAt, companyId, status, settings } = u;
  return { id: String(_id), email, name, role, createdAt, companyId: companyId ? String(companyId) : null, status, settings };
}

function sign(user) {
  const payload = {
    sub: String(user._id),
    email: user.email,
    role: user.role || 'user',
    companyId: user.companyId ? String(user.companyId) : null
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

async function register(req, res) {
  if (!ALLOW_OPEN_REG) return res.status(403).json({ error: 'Registro desabilitado.' });
  const { email, password, name, company } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

  try {
    const exists = await Users.findByEmail(email);
    if (exists) return res.status(409).json({ error: 'Email já cadastrado.' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await transaction(async connection => {
      const comp = company?.name ? await Companies.create({
        name: company.name, cnpj: company.cnpj, contact: company.contact, address: company.address,
        plan: company.plan || 'free',
      }, connection) : null;
      const created = await Users.create({
        email, passwordHash, name, companyId: comp?._id, role: comp ? 'owner' : 'user',
      }, connection);
      if (comp) await Companies.updateById(comp._id, { createdBy: created._id }, connection);
      return created;
    });

    const token = sign(user);
    res.json({ token, user: sanitize(user) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email ou CNPJ já cadastrado.' });
    console.error('register error:', e.code || e.name);
    res.status(500).json({ error: 'Erro ao registrar.' });
  }
}

async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  try {
    const user = await Users.findByEmail(email);
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas.' });
    if (user.status === 'disabled') return res.status(403).json({ error: 'Usuário desativado.' });

    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const token = sign(user);
    // opcional: salvar lastLoginAt
    await Users.updateById(user._id, { lastLoginAt: new Date() });

    res.json({ token, user: sanitize(user) });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'Erro ao autenticar.' });
  }
}

async function me(req, res) {
  try {
    const user = await Users.findById(req.auth.sub);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ user: sanitize(user) });
  } catch (e) {
    console.error('me error:', e);
    res.status(500).json({ error: 'Erro ao consultar usuário.' });
  }
}

module.exports = { register, login, me };
