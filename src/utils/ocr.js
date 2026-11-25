// src/utils/ocr.js
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { normalizeSpaces } = require('./text');

const {
  OCR_ENABLED,
  OCR_MAX_PAGES,
  AZURE_DOCINTELLIGENCE_ENDPOINT,
  AZURE_DOCINTELLIGENCE_KEY,
  AZURE_DOCINTELLIGENCE_API_VERSION, // pode deixar vazio para autodetect
  AZURE_READ_RPM,
  AZURE_OCR_BLOCK_PAGES,
  AZURE_POLL_MIN_SEC,
  AZURE_POLL_MAX_SEC, // não usado diretamente no SDK, mas mantido p/ compat
} = require('../Config/env');

const TEMP_PATH = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH);

/* ========================= Utils ========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function normEndpoint(e = '') { return String(e || '').replace(/\/+$/, ''); }
function hasTextEnough(t = '') { return (t || '').trim().length >= 450; }
function countPdfMarkers(pdfBuffer) {
  const slice = pdfBuffer.slice(0, Math.min(pdfBuffer.length, 2_000_000));
  const s = slice.toString('latin1');
  const count = (re) => (s.match(re) || []).length;
  const nFont = count(/\/Font/gi) + count(/\bTj\b/g) + count(/\bTJ\b/g);
  const nImg  = count(/\/Image/gi) + count(/\bDo\b/g);
  return { nFont, nImg };
}
function isLikelyImageOnlyPdf(pdfBuffer) {
  const { nFont, nImg } = countPdfMarkers(pdfBuffer);
  if (nFont <= 2 && nImg >= 2) return true;
  if (nFont === 0 && nImg >= 1) return true;
  return false;
}
function hasManyImages(pdfBuffer) { return countPdfMarkers(pdfBuffer).nImg >= 2; }

/* ========================= Rate limit (analyze) ========================= */
// Limite simples por processo: N chamadas de ANALYZE por minuto
const _rate = {
  rpm: Math.max(1, Number(AZURE_READ_RPM || 1)),
  lastAnalyzeAt: 0
};
async function rateGate(label = '') {
  const minIntervalMs = Math.ceil(60_000 / _rate.rpm);
  const now = Date.now();
  const wait = _rate.lastAnalyzeAt + minIntervalMs - now;
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000);
    console.log(`[azureReadExtract][rate] aguardando ${secs}s ${label}`);
    await sleep(wait);
  }
  _rate.lastAnalyzeAt = Date.now();
}

/* ============ Azure Document Intelligence (SDK) ============ */
const createDocIntel = require('@azure-rest/ai-document-intelligence').default;
const { getLongRunningPoller, isUnexpected } = require('@azure-rest/ai-document-intelligence');

let _sdkClientCache = new Map();
function getSdkClient(endpoint, key, apiVersion) {
  const k = `${endpoint}|${apiVersion}`;
  if (_sdkClientCache.has(k)) return _sdkClientCache.get(k);
  const c = createDocIntel(endpoint, { key, apiVersion });
  _sdkClientCache.set(k, c);
  return c;
}

/**
 * OCR com modelo prebuilt-read usando **sempre o SDK**:
 *  - Se `url` existir → usa urlSource (JSON)
 *  - Caso contrário → envia `bin` (Buffer) com contentType octet-stream
 *  - Tenta múltiplas apiVersions até funcionar
 *
 * @param {Buffer|null} bin
 * @param {Object} opts
 *   - mime: string (default 'application/pdf')
 *   - pages: "1-5" | "7"
 *   - url: string (SAS/URL pública)
 *   - locale: string (default 'pt-BR')
 *   - readingOrder: 'natural' | 'basic' (default 'natural')
 * @returns {Promise<string>} texto extraído
 */
async function azureReadExtract(bin, opts = {}) {
  const {
    mime = 'application/pdf',
    pages,
    url,
    locale = 'pt-BR',
    readingOrder = 'natural'
  } = opts;

  const endpoint = normEndpoint(AZURE_DOCINTELLIGENCE_ENDPOINT);
  const key = AZURE_DOCINTELLIGENCE_KEY;
  if (!endpoint || !key) throw new Error('Azure OCR: configuração ausente (endpoint/key).');

  const pageLimit = Math.max(1, Number(OCR_MAX_PAGES) || 15);
  const pagesParam = pages ? String(pages) : `1-${pageLimit}`;

  await rateGate(`[prebuilt-read ${pagesParam}]`);

  const pollMin = Math.max(3, Number(AZURE_POLL_MIN_SEC || 6));

  // Ordem de tentativa (a 1ª é a do .env se houver)
  const envV = (AZURE_DOCINTELLIGENCE_API_VERSION || '').trim();
  const tryVersions = Array.from(new Set([
    envV || '2024-11-30',
    '2024-02-29-preview',
    '2023-10-31',
    '2023-07-31',
    '2022-08-31',
  ])).filter(Boolean);

  let lastErr = null;

  for (const apiVersion of tryVersions) {
    try {
      const client = getSdkClient(endpoint, key, apiVersion);
      const route = client.path('/documentModels/{modelId}:analyze', 'prebuilt-read');

      // Com URL (igual ao quickstart) ou com Buffer binário
      const postArgs = url
        ? {
            contentType: 'application/json',
            body: {
              urlSource: url,
              parameters: { pages: pagesParam, locale, readingOrder }
            }
          }
        : {
            contentType: mime || 'application/octet-stream',
            body: bin,
            // para binário, os parâmetros vão na query
            queryParameters: { pages: pagesParam, locale, readingOrder }
          };

      console.log(`[azureReadExtract][SDK] analyze api=${apiVersion} pages=${pagesParam} url=${!!url} mime=${mime}`);

      const initial = await route.post(postArgs);

      if (isUnexpected(initial)) {
        const errBody = initial.body?.error || initial.body || {};
        throw new Error(`${initial.status}: ${JSON.stringify(errBody).slice(0,300)}`);
      }

      const poller = getLongRunningPoller(client, initial);
      poller.intervalInMs = pollMin * 1000;

      const done = await poller.pollUntilDone();
      const ar = done.body?.analyzeResult;
      if (!ar) throw new Error('Analyze retornou sem analyzeResult');

      if (ar.content) return normalizeSpaces(ar.content);

      const parts = [];
      for (const p of (ar.pages || [])) for (const ln of (p.lines || [])) if (ln.content) parts.push(ln.content);
      return normalizeSpaces(parts.join('\n'));
    } catch (e) {
      lastErr = e;
      console.warn(`[azureReadExtract][SDK] falhou em api-version=${apiVersion}: ${String(e.message || e).slice(0,200)}`);
      // tenta próxima versão
    }
  }

  throw new Error(`Azure Read falhou em todas as versões (${tryVersions.join(', ')}): ${String(lastErr && lastErr.message || lastErr)}`);
}

/* ========================= Fluxo principal: PDF (blocos) ==================== */
async function extractTextFromPdf(pdfBuffer, filePath) {
  let parsedText = '';
  let numpages = 0;

  try {
    const data = await pdfParse(pdfBuffer);
    parsedText = normalizeSpaces(data.text || '');
    numpages = Number(data.numpages || data.numrender) || 0;
  } catch (e) {
    console.error('[extractTextFromPdf] Falha no pdf-parse:', filePath || '(buffer)', e.message);
  }

  // Se já há bastante texto e OCR off
  if (hasTextEnough(parsedText) && !OCR_ENABLED) return parsedText;

  // Decide se vamos de híbrido/blocos
  const looksImageOnly = isLikelyImageOnlyPdf(pdfBuffer) || hasManyImages(pdfBuffer);
  const shouldOcr = OCR_ENABLED && (looksImageOnly || !hasTextEnough(parsedText));
  if (!shouldOcr) return parsedText || '';

  // OCR por blocos (respeitando RPM e OCR_MAX_PAGES)
  const rawBlock = Math.max(1, Number(AZURE_OCR_BLOCK_PAGES || 5));
  const totalPages = Math.max(numpages || 0, 1);
  const capByMax = Math.max(1, Math.min(totalPages, Number(OCR_MAX_PAGES) || totalPages));
  const blockSize = Math.min(rawBlock, capByMax);
  const chunks = [];

  // Se não temos numpages, tenta uma chamada única
  if (!numpages) {
    try {
      console.log('[extractTextFromPdf] OCR (numpages desconhecido) em chamada única');
      const t = await azureReadExtract(pdfBuffer, { mime: 'application/pdf' });
      const merged = normalizeSpaces((parsedText + '\n' + (t || '')).trim());
      return merged || parsedText || '';
    } catch (e) {
      console.error('[extractTextFromPdf] Azure OCR falhou:', e.message);
      return parsedText || '';
    }
  }

  console.log(`[extractTextFromPdf] OCR em blocos: ${totalPages} páginas, bloco=${blockSize}, rpm=${_rate.rpm}`);

  for (let start = 1; start <= totalPages; start += blockSize) {
    const end = Math.min(start + blockSize - 1, totalPages);
    const range = start === end ? String(start) : `${start}-${end}`;
    try {
      console.log(`[extractTextFromPdf] bloco ${range} → Azure`);
      const blockText = await azureReadExtract(pdfBuffer, { mime: 'application/pdf', pages: range });
      console.log(`[extractTextFromPdf] bloco ${range} OK (${(blockText || '').length} chars)`);
      chunks.push(blockText || '');
    } catch (e) {
      console.warn(`[extractTextFromPdf] Bloco ${range} falhou: ${e.message}`);
      // continua para os próximos blocos
    }
  }

  const ocrText = normalizeSpaces(chunks.join('\n'));
  const merged = normalizeSpaces((parsedText + '\n' + ocrText).trim());
  return merged || parsedText || '';
}

/* ========================= Imagem (via Azure Read) ========================= */
async function extractTextFromImage(imagePath, originalName = imagePath) {
  try {
    if (!OCR_ENABLED) return '';
    const buf = fs.readFileSync(imagePath);
    const ext = path.extname(originalName || '').toLowerCase();
    const mime =
      ext === '.png'                    ? 'image/png'  :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.tif' || ext === '.tiff' ? 'image/tiff' :
      'application/octet-stream';
    const text = await azureReadExtract(buf, { mime });
    return normalizeSpaces(text || '');
  } catch (e) {
    console.error('[extractTextFromImage] falhou:', e.message);
    return '';
  }
}

module.exports = {
  extractTextFromPdf,
  extractTextFromImage,
  // helpers opcionais
  countPdfMarkers,
  isLikelyImageOnlyPdf
};
