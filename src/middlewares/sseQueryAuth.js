// src/middlewares/sseQueryAuth.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../Config/env');

// Permite autenticar SSE via ?token=... (EventSource não envia Authorization)
function sseQueryAuth() {
  return (req, _res, next) => {
    try {
      const token = req.query?.token;
      if (!token) return next();

      // valida token; se ok, injeta Authorization p/ authMiddleware padrão
      jwt.verify(String(token), JWT_SECRET);
      req.headers.authorization = `Bearer ${token}`;
    } catch {
      // se inválido, authMiddleware vai barrar normalmente
    }
    next();
  };
}

module.exports = { sseQueryAuth };
