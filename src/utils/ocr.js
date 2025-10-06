// src/utils/ocr.js
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const { OCR_ENABLED } = require('../Config/env');
const { normalizeSpaces } = require('./text');

// (mantido caso você precise de temporários futuramente)
const TEMP_PATH = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH);

/**
 * Extrai texto de um PDF a partir do buffer.
 * 1) Usa pdf-parse (texto nativo).
 * 2) Se não houver texto suficiente, retorna string vazia.
 *    (OCR de PDF foi removido porque dependia do pdf-poppler, que não roda em Linux)
 * @param {Buffer} pdfBuffer
 * @param {string} [filePath]
 * @returns {Promise<string>}
 */
async function extractTextFromPdf(pdfBuffer, filePath) {
  try {
    const data = await pdfParse(pdfBuffer);
    const text = normalizeSpaces(data.text || '');
    if (text && text.trim().length > 0) {
      return text;
    }
  } catch (e) {
    console.error('[extractTextFromPdf] Falha no pdf-parse:', filePath || '(buffer)', e.message);
  }

  // Se chegou aqui, não conseguimos texto nativo.
  // OBS: OCR de PDF (via poppler) foi removido por incompatibilidade em Linux.
  // Opções futuras: usar serviço externo (Azure Read) ou rasterizar com pdfjs + canvas (requer deps nativas).
  if (OCR_ENABLED) {
    console.warn('[extractTextFromPdf] OCR de PDF indisponível (sem poppler). Retornando vazio.');
  }
  return '';
}

/**
 * Extrai texto de uma imagem (PNG/JPG/TIFF) com Tesseract.
 * @param {string} imagePath
 * @returns {Promise<string>}
 */
async function extractTextFromImage(imagePath) {
  let worker;
  try {
    // createWorker é síncrono; load/initialize são assíncronos
    worker = await createWorker();
    await worker.load();
    // idiomas: ajuste conforme necessário
    await worker.loadLanguage('por+eng');
    await worker.initialize('por+eng');

    const { data: { text } } = await worker.recognize(imagePath);
    return normalizeSpaces(text || '');
  } catch (e) {
    console.error('[extractTextFromImage] OCR imagem falhou:', imagePath, e.message);
    return '';
  } finally {
    try {
      if (worker) await worker.terminate();
    } catch {}
  }
}

module.exports = { extractTextFromPdf, extractTextFromImage };
