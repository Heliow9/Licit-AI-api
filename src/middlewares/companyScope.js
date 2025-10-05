// src/middlewares/companyScope.js
function requireCompany(req, res, next) {
  const cid = req?.auth?.companyId;
  if (!cid) return res.status(400).json({ error: 'Usuário sem empresa vinculada.' });
  req.companyId = cid; // string
  next();
}
module.exports = { requireCompany };
