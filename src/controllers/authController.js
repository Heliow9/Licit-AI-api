// controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { BCRYPT_ROUNDS, JWT_SECRET, JWT_EXPIRES, ALLOW_OPEN_REG } = require('../Config/env');
const Users = require('../models/userModel');
const Companies = require('../models/companyModel');

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

    // Se veio um objeto company, criamos a empresa e o usuário como 'owner'
    let companyId = null;
    if (company?.name) {
      const comp = await Companies.create({
        name: company.name,
        cnpj: company.cnpj,
        createdBy: null, // definiremos depois que tivermos o _id do user
        contact: company.contact,
        address: company.address,
        plan: company.plan || 'free'
      });
      companyId = comp._id;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const role = companyId ? 'owner' : 'user';

    const user = await Users.create({ email, passwordHash, name, role, companyId });
    // se criamos empresa acima, set createdBy
    if (companyId) {
      await Companies.updateMy(companyId, { createdBy: user._id });
    }

    const token = sign(user);
    res.json({ token, user: sanitize(user) });
  } catch (e) {
    console.error('register error:', e);
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
