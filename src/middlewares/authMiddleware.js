const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../Config/env');

function authMiddleware() {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token ausente.' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.auth = payload; // { sub, email, role, companyId? }
      next();
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Não autenticado.' });
    if (!roles.includes(req.auth.role)) return res.status(403).json({ error: 'Sem permissão.' });
    next();
  };
}

module.exports = { authMiddleware, requireRole };
