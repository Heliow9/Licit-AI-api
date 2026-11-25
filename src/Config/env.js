// src/Config/env.js
require('dotenv').config();
const path = require('path');

/* ================= Helpers ================= */
function bool(v, d = false) {
  if (v == null) return d;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}
function int(v, d = 0) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : d;
}

/* ============== CATS_ROOT absoluto (fix do "Nenhum arquivo...") ============= */
const rawCatsRoot = (process.env.CATS_ROOT || path.join(__dirname, '..', '..', 'data', 'cats_poc'))
  .replace(/^["']|["']$/g, '') // remove aspas acidentais
  .trim();
const CATS_ROOT = path.resolve(rawCatsRoot);

/* ================= Azure OpenAI (mapeia ambos padrões) ====================== */
// O código em services/azure.js espera: AZ_ENDPOINT, AZ_VER, AZ_KEY, CHAT_DEPLOY, EMBED_DEPLOY
// Mapeamos também para quem usa AZURE_OPENAI_* no .env
const AZ_ENDPOINT =
  (process.env.AZ_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');

const AZ_VER =
  (process.env.AZ_VER || process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview').trim();

const AZ_KEY =
  (process.env.AZ_KEY || process.env.AZURE_OPENAI_API_KEY || '').trim();

const CHAT_DEPLOY =
  (process.env.CHAT_DEPLOY || process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o').trim();

const EMBED_DEPLOY =
  (process.env.EMBED_DEPLOY || process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || 'text-embedding-3-large').trim();

/* ================= Azure Document Intelligence (OCR) ======================== */
const AZURE_DOCINTELLIGENCE_ENDPOINT = (process.env.AZURE_DOCINTELLIGENCE_ENDPOINT || 'https://licit-ai-di.cognitiveservices.azure.com/').trim();
const AZURE_DOCINTELLIGENCE_KEY = (process.env.AZURE_DOCINTELLIGENCE_KEY || '').trim();
const AZURE_DOCINTELLIGENCE_API_VERSION = (process.env.AZURE_DOCINTELLIGENCE_API_VERSION || '').trim();

const OCR_ENABLED   = bool(process.env.OCR_ENABLED, true);
const OCR_MAX_PAGES = int(process.env.OCR_MAX_PAGES, 15);

/* ======= Novos ajustes para rate-limit/poll e blocos de páginas do OCR ====== */
const AZURE_READ_RPM        = int(process.env.AZURE_READ_RPM, 6);   // chamadas ANALYZE por minuto
const AZURE_OCR_BLOCK_PAGES = int(process.env.AZURE_OCR_BLOCK_PAGES, 3); // páginas por chamada
const AZURE_POLL_MIN_SEC    = int(process.env.AZURE_POLL_MIN_SEC, 6);
const AZURE_POLL_MAX_SEC    = int(process.env.AZURE_POLL_MAX_SEC, 15);

/* ================= Outros ajustes comuns =================================== */
const MAX_EDITALTEXT_CHARS = int(process.env.MAX_EDITALTEXT_CHARS, 50000);
const MAX_CHUNKS_PER_FILE  = int(process.env.MAX_CHUNKS_PER_FILE, 1200);

/* ================= Auth / Server =========================================== */
const PORT          = int(process.env.PORT, 3001);
const JWT_SECRET    = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES   = process.env.JWT_EXPIRES || '7d';
const BCRYPT_ROUNDS = int(process.env.BCRYPT_ROUNDS, 10);
const ALLOW_OPEN_REG = bool(process.env.ALLOW_OPEN_REG, false);

/* ================= Export =================================================== */
module.exports = {
  // Server
  PORT,

  // FS / ingestão
  CATS_ROOT,
  MAX_EDITALTEXT_CHARS,
  MAX_CHUNKS_PER_FILE,

  // OCR
  OCR_ENABLED,
  OCR_MAX_PAGES,
  AZURE_DOCINTELLIGENCE_ENDPOINT,
  AZURE_DOCINTELLIGENCE_KEY,
  AZURE_DOCINTELLIGENCE_API_VERSION,
  AZURE_READ_RPM,
  AZURE_OCR_BLOCK_PAGES,
  AZURE_POLL_MIN_SEC,
  AZURE_POLL_MAX_SEC,

  // Azure OpenAI
  AZ_ENDPOINT,
  AZ_VER,
  AZ_KEY,
  CHAT_DEPLOY,
  EMBED_DEPLOY,

  // Auth
  JWT_SECRET,
  JWT_EXPIRES,
  BCRYPT_ROUNDS,
  ALLOW_OPEN_REG,
};
