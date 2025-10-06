

// --- debug: rastrear quem imprime "not supported" ---
const _stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  try {
    const s = (chunk && chunk.toString) ? chunk.toString() : String(chunk);
    if (s.toLowerCase().includes('not supported')) {
      console.log('[TRACE not supported] stack:\n', new Error().stack);
    }
  } catch {}
  return _stderrWrite(chunk, ...rest);
};

const _origError = console.error;
console.error = (...args) => {
  if (args.join(' ').toLowerCase().includes('not supported')) {
    _origError('[TRACE not supported] stack:\n', new Error().stack);
  }
  return _origError(...args);
};



// app.js
const express = require('express');
const cors = require('cors');
const fs = require('fs'); // <-- faltava isso
const path = require('path');
const multer = require('multer');
const { analisarEdital } = require('../src/controllers/editalController');
const { AZ_KEY, AZ_ENDPOINT, AZ_VER } = require('./Config/env');
const upload = multer({ dest: 'uploads/' });
const distIndex = path.join(process.cwd(), 'dist', 'index.html');
const app = express();
app.use(cors({
  origin: true,         // reflete o Origin do request
  credentials: false,   // não precisamos de cookies
  exposedHeaders: ['Content-Disposition']
}));
app.use(express.json({limit: '10mb'}));

// Rotas de API



app.use('/api/auth',   require('./routes/authRoutes'));
app.use('/api/cats',   require('./routes/catsRoutes'));
app.use('/api/edital', require('./routes/editalRoutes'));
app.use('/api/pastas', require('./routes/pastasRoutes'));
app.use('/api/me',        require('./routes/settingsRoutes'));
app.use('/api/company',   require('./routes/companyRoutes'));
app.use('/api/company/users', require('./routes/companyUsersRoutes'));
app.get('/health', (req,res)=>res.json({ ok:true, azure:{ endpoint:AZ_ENDPOINT, ver:AZ_VER, key: !!AZ_KEY } }));

// (Opcional) rota síncrona antiga
app.post('/api/edital/analisar', 
  upload.fields([{ name: 'editalPdf', maxCount: 1 }]), 
  analisarEdital
);

// SPA fallback (deixe por último)
app.get('*', (req, res) => {
  fs.access(distIndex, fs.constants.F_OK, (err) => {
    if (err) {
      // quando não há frontend buildado, responda 404 limpinho
      return res.status(404).json({ error: 'Frontend não está buildado (dist/index.html ausente).' });
    }
    res.sendFile(distIndex);
  });
});

module.exports = app;
