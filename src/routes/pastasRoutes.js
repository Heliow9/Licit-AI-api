// src/routes/pastasRoutes.js
const { Router } = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ObjectId } = require('mongodb');

const { authMiddleware } = require('../middlewares/authMiddleware');
const { getDb } = require('../Config/db');
const { CATS_ROOT } = require('../Config/env');

const router = Router();

// ---------- helpers ----------
function ensureCompanyRoot(companyId) {
  const root = path.join(CATS_ROOT, String(companyId || ''));
  return root;
}
function resolveSafe(base, ...parts) {
  const baseRes = path.resolve(base);
  const full = path.resolve(base, ...parts);
  // Garante que full está DENTRO de base
  if (full !== baseRes && !full.startsWith(baseRes + path.sep)) {
    const err = new Error('Caminho inválido.');
    err.status = 400;
    throw err;
  }
  return full;
}
function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'application/octet-stream';
}
function isAdminRole(role) {
  return role === 'admin' || role === 'owner';
}

// Todas as rotas abaixo exigem auth
router.use(authMiddleware());

// ========== ROTA 1: Listar pastas (gestores) da empresa ==========
// GET /api/pastas
router.get('/', async (req, res) => {
  try {
    const companyId = req.auth?.companyId;
    const companyRoot = ensureCompanyRoot(companyId);

    // Se não existir a pasta da empresa ainda, retorna vazio
    let items = [];
    try {
      items = await fsp.readdir(companyRoot, { withFileTypes: true });
    } catch {
      return res.json([]); // sem diretório da empresa => sem pastas
    }

    const dirs = items.filter((d) => d.isDirectory());
    const colors = ['blue', 'green', 'indigo', 'pink', 'sky', 'amber'];

    const pastasData = await Promise.all(
      dirs.map(async (dir) => {
        const gestorPath = path.join(companyRoot, dir.name);
        let arquivos = [];
        try {
          arquivos = await fsp.readdir(gestorPath, { withFileTypes: true });
        } catch {
          arquivos = [];
        }
        const totalFiles = arquivos.filter((a) => a.isFile()).length;
        return {
          id: dir.name, // gestor
          nome: `Pasta do Gestor ${dir.name}`,
          descricao: `Documentos e CATs do gestor ${dir.name}.`,
          totalCats: totalFiles,
          cor: colors[Math.floor(Math.random() * colors.length)],
        };
      })
    );

    res.json(pastasData);
  } catch (error) {
    console.error('Erro ao ler pastas:', error);
    res.status(500).json({ error: 'Não foi possível carregar as pastas do servidor.' });
  }
});

// ========== ROTA 2: Listar arquivos dentro de uma pasta (gestor) ==========
// GET /api/pastas/:folderId
router.get('/:folderId', async (req, res) => {
  try {
    const companyId = req.auth?.companyId;
    const folderIdRaw = String(req.params.folderId || '');
    const folderId = decodeURIComponent(folderIdRaw);

    const companyRoot = ensureCompanyRoot(companyId);
    const folderPath = resolveSafe(companyRoot, folderId);

    const items = await fsp.readdir(folderPath, { withFileTypes: true });
    const filesData = items
      .filter((it) => it.isFile())
      .map((f) => ({ name: f.name }));

    res.json({ folder: folderId, files: filesData });
  } catch (error) {
    console.error(`Erro ao ler arquivos da pasta ${req.params.folderId}:`, error);
    res.status(404).json({ error: `Pasta '${req.params.folderId}' não encontrada.` });
  }
});

// ========== ROTA 3: Servir arquivo (download/preview) ==========
// GET /api/pastas/:folderId/:fileName(*)
router.get('/:folderId/:fileName(*)', async (req, res) => {
  try {
    const companyId = req.auth?.companyId;
    const folderId = decodeURIComponent(String(req.params.folderId || ''));
    const fileName = decodeURIComponent(String(req.params.fileName || ''));

    const companyRoot = ensureCompanyRoot(companyId);
    const filePath = resolveSafe(companyRoot, folderId, fileName);

    // set headers
    res.setHeader('Content-Type', guessMime(fileName));
    // inline; o front decide baixar se quiser
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);

    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('Erro ao enviar arquivo:', err.message);
        if (!res.headersSent) {
          res.status(404).send('Arquivo não encontrado.');
        }
      }
    });
  } catch (error) {
    const status = error.status || 400;
    res.status(status).json({ error: error.message || 'Falha ao servir arquivo.' });
  }
});

// ========== NOVA ROTA 4: Excluir arquivo (apenas admin/owner) ==========
// DELETE /api/pastas/:folderId/:fileName(*)
router.delete('/:folderId/:fileName(*)', async (req, res) => {
  try {
    const role = req.auth?.role;
    if (!isAdminRole(role)) {
      return res.status(403).json({ error: 'Apenas admin/owner podem excluir CATs.' });
    }

    const companyId = req.auth?.companyId;
    const folderId = decodeURIComponent(String(req.params.folderId || ''));
    const fileName = decodeURIComponent(String(req.params.fileName || ''));

    const companyRoot = ensureCompanyRoot(companyId);
    const filePath = resolveSafe(companyRoot, folderId, fileName);

    // 1) remove arquivo do disco
    let removedFile = false;
    try {
      await fsp.unlink(filePath);
      removedFile = true;
    } catch (e) {
      // Se já não existir no disco, seguimos para limpar banco
      if (e.code !== 'ENOENT') throw e;
    }

    // 2) limpa Mongo (cats + chunks)
    const db = await getDb();
    const src = `${folderId}/${fileName}`;
    const companyOid = new ObjectId(companyId);

    const chunksRes = await db.collection('chunks').deleteMany({ companyId: companyOid, source: src });
    const catsRes   = await db.collection('cats').deleteOne({ companyId: companyOid, source: src });

    return res.json({
      ok: true,
      file: { path: filePath, removed: removedFile },
      mongo: {
        catsDeleted: catsRes?.deletedCount || 0,
        chunksDeleted: chunksRes?.deletedCount || 0,
        source: src,
      },
    });
  } catch (error) {
    console.error('Erro ao excluir CAT:', error);
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Falha ao excluir CAT.' });
  }
});

module.exports = router;
