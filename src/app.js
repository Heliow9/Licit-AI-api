// src/app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

/* ======================= ENV / PATHS ======================= */
const PORT = parseInt(process.env.PORT || '3001', 10);
const DIST_DIR = path.resolve(process.cwd(), 'dist');       // onde o front builda (se existir)
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
const HAS_DIST = fs.existsSync(DIST_INDEX);

/* ======================= MIDDLEWARES BASE ================== */
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

app.use((req, res, next) => { res.header('Vary', 'Origin'); next(); });

app.use(cors({
  origin: true, credentials: true,
  methods: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
  exposedHeaders: ['Content-Disposition'],
}));
app.options('*', cors());

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

/* ======================= HEALTH / VERSION =================== */
const { AZ_KEY, AZ_ENDPOINT, AZ_VER } = require('./Config/env');
app.get('/health', (_req, res) => {
  res.json({ ok: true, azure: { endpoint: AZ_ENDPOINT, ver: AZ_VER, key: !!AZ_KEY }, frontend: HAS_DIST ? 'ON' : 'OFF' });
});
app.get('/api/edital/version', (_req, res) => {
  res.json({ app: 'ok', controller: 'editalController v3.2 DOMAIN-GATED', cats: process.env.DISABLE_CATS === '1' ? 'OFF' : 'AUTO' });
});

/* ======================= ROTAS DE API ======================= */
// importe suas rotas aqui (sempre ANTES de qualquer static/fallback)
app.use('/api/auth',           require('./routes/authRoutes'));
app.use('/api/cats',           require('./routes/catsRoutes'));
app.use('/api/pastas',         require('./routes/pastasRoutes'));
app.use('/api/me',             require('./routes/settingsRoutes'));
app.use('/api/company',        require('./routes/companyRoutes'));
app.use('/api/company/users',  require('./routes/companyUsersRoutes'));

app.use('/api/edital', require('./routes/editalRoutes'));

/* ======================= 404 /api =========================== */
// garante que qualquer rota /api desconhecida retorne JSON, não SPA
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found', method: req.method, path: req.originalUrl });
});

/* ======================= FRONTEND (opcional) ================ */
// Em desenvolvimento SEM build, NÃO servimos o SPA.
// Se um dia você rodar `npm run build` na UI e gerar dist/index.html,
// o bloco abaixo passa a funcionar automaticamente.
if (HAS_DIST) {
  app.use(express.static(DIST_DIR));
  // SPA fallback apenas para rotas que NÃO começam com /api
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(DIST_INDEX));
} else {
  console.warn('[warn] Frontend não buildado — servindo apenas as APIs.');
}

/* ======================= ERROR HANDLER ====================== */
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  if (req.path.startsWith('/api')) {
    res.status(500).json({ error: err.message || 'Internal error' });
  } else if (HAS_DIST) {
    res.sendFile(DIST_INDEX);
  } else {
    res.status(500).send('Server error');
  }
});


module.exports = app;
