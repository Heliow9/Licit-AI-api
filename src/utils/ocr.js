const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const poppler = require('pdf-poppler');
const { OCR_ENABLED, OCR_MAX_PAGES } = require('../Config/env');
const { normalizeSpaces } = require('./text');

const TEMP_PATH = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH);

async function extractTextFromPdf(pdfBuffer, filePath) {
  try {
    const data = await pdfParse(pdfBuffer);
    if (data.text && data.text.trim().length > 50) return normalizeSpaces(data.text);
  } catch { /* fallback OCR abaixo */ }

  if (!OCR_ENABLED) return '';

  const tempPdfPath = path.join(TEMP_PATH, path.basename(filePath || `tmp_${Date.now()}.pdf`));
  fs.writeFileSync(tempPdfPath, pdfBuffer);
  try {
    let finalText = '';
    for (let page = 1; page <= OCR_MAX_PAGES; page++) {
      const outPrefix = path.join(TEMP_PATH, `${path.basename(tempPdfPath, '.pdf')}_p${page}`);
      const opts = { format: 'png', out_dir: TEMP_PATH, out_prefix: path.basename(outPrefix), page };
      try {
        await poppler.convert(tempPdfPath, opts);
        const imagePath = `${outPrefix}-${page}.png`;
        const worker = await createWorker('por');
        const { data: { text } } = await worker.recognize(imagePath);
        await worker.terminate();
        finalText += (text || '') + '\n';
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      } catch (e) {
        if (page === 1) console.log(' -> ⚠️ OCR falhou na primeira página:', e.message);
        break;
      }
    }
    return normalizeSpaces(finalText);
  } finally {
    try { fs.existsSync(tempPdfPath) && fs.unlinkSync(tempPdfPath); } catch {}
  }
}

async function extractTextFromImage(imagePath) {
  try {
    const worker = await createWorker('por');
    const { data: { text } } = await worker.recognize(imagePath);
    await worker.terminate();
    return normalizeSpaces(text || '');
  } catch (e) {
    console.log(' -> ⚠️ OCR imagem falhou:', e.message);
    return '';
  }
}

module.exports = { extractTextFromPdf, extractTextFromImage };
