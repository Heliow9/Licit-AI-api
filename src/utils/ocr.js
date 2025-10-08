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
  AZURE_DOCINTELLIGENCE_API_VERSION,
} = require('../Config/env');

const TEMP_PATH = path.join(__dirname, '..', '..', 'temp');
if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH);

/* ========================= Helpers ========================= */
function maskKey(k = '') {
  if (!k) return '';
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-4)}`;
}
function normEndpoint(e = '') {
  return String(e || '').replace(/\/+$/, '');
}
function hasTextEnough(t = '') {
  return (t || '').trim().length >= 450; // ajuste se quiser
}

/**
 * Heurística baratíssima para detectar PDF “imagem-only”:
 * - Conta ocorrências de marcadores típicos de texto (/Font, Tj, TJ)
 * - Compara com ocorrências de imagem (/Image, Do)
 * Retorna true se parecer escaneado (sem texto real).
 */
function isLikelyImageOnlyPdf(pdfBuffer) {
  // limitamos leitura a 2MB pra não custar RAM
  const slice = pdfBuffer.slice(0, Math.min(pdfBuffer.length, 2_000_000));
  const s = slice.toString('latin1');

  const count = (re) => (s.match(re) || []).length;

  const nFont = count(/\/Font/gi) + count(/\bTj\b/g) + count(/\bTJ\b/g);
  const nImg  = count(/\/Image/gi) + count(/\bDo\b/g);

  // se tem MUITO mais imagem do que texto, é escaneado
  // e se praticamente não tem marcadores de texto
  if (nFont <= 2 && nImg >= 2) return true;
  if (nFont === 0 && nImg >= 1) return true;

  // fallback conservador
  return false;
}

/* ========================= Azure Document Intelligence (Read) ========================= */
async function azureReadExtract(pdfBuffer, mime = 'application/pdf') {
  const endpoint = normEndpoint(AZURE_DOCINTELLIGENCE_ENDPOINT);
  const key = AZURE_DOCINTELLIGENCE_KEY;
  const apiVersion = AZURE_DOCINTELLIGENCE_API_VERSION || '2023-10-31';

  if (!endpoint || !key) {
    throw new Error('Azure OCR: configuração ausente (endpoint/key).');
  }

  // limite de páginas por custo
  const pageLimit = Math.max(1, Number(OCR_MAX_PAGES) || 8);
  const pagesParam = `pages=1-${pageLimit}`;

  const basePaths = ['documentintelligence', 'formrecognizer']; // novo e legado
  const headerVariants = [
    (k) => ({ 'Ocp-Apim-Subscription-Key': k, 'Content-Type': mime }),
    (k) => ({ 'api-key': k, 'Content-Type': mime }),
  ];

  let lastErr = null;

  for (const base of basePaths) {
    for (const headerBuilder of headerVariants) {
      try {
        const analyzeUrl =
          `${endpoint}/${base}/documentModels/prebuilt-read:analyze?api-version=${apiVersion}&${pagesParam}`;

        console.log(`[azureReadExtract] POST ${analyzeUrl} (key=${maskKey(key)})`);

        const res = await fetch(analyzeUrl, {
          method: 'POST',
          headers: headerBuilder(key),
          body: pdfBuffer,
        });

        if (res.status === 401) {
          const body = await res.text().catch(() => '');
          console.warn(`[azureReadExtract] 401 ${base}/${Object.keys(headerBuilder(key))[0]} → ${body.slice(0, 200)}`);
          lastErr = new Error('401');
          continue;
        }
        if (!res.ok && res.status !== 202) {
          const body = await res.text().catch(() => '');
          throw new Error(`Azure analyze HTTP ${res.status} - ${body.slice(0, 300)}`);
        }

        const opLoc = res.headers.get('operation-location') || res.headers.get('Operation-Location');
        if (!opLoc) {
          const body = await res.text().catch(() => '');
          throw new Error(`Sem Operation-Location. HTTP ${res.status} - ${body.slice(0, 200)}`);
        }

        // polling
        for (let tries = 0; tries < 60; tries++) {
          await new Promise(r => setTimeout(r, 1000));
          const pr = await fetch(opLoc, { headers: headerBuilder(key) });

          if (pr.status === 401) {
            const body = await pr.text().catch(() => '');
            console.warn(`[azureReadExtract] Poll 401 ${base}/${Object.keys(headerBuilder(key))[0]} → ${body.slice(0, 200)}`);
            lastErr = new Error('401-poll');
            break;
          }
          if (!pr.ok) {
            const body = await pr.text().catch(() => '');
            throw new Error(`Azure poll HTTP ${pr.status} - ${body.slice(0, 300)}`);
          }
          const jr = await pr.json();
          const status = jr.status || jr.analyzeResult?.status || jr?.result?.status;

          if (status === 'succeeded') {
            const ar = jr.analyzeResult || jr.result || jr;
            let text = '';

            if (ar?.content) {
              text = ar.content; // novo
            } else if (Array.isArray(ar?.pages)) {
              const parts = [];
              for (const p of ar.pages) {
                if (Array.isArray(p.lines)) {
                  for (const ln of p.lines) if (ln.content) parts.push(ln.content);
                }
              }
              text = parts.join('\n');
            }
            return normalizeSpaces(text || '');
          }
          if (status === 'failed') {
            throw new Error(`Azure status=failed: ${JSON.stringify(jr).slice(0, 400)}`);
          }
          // running → segue
        }

        throw new Error('Azure poll timeout.');
      } catch (err) {
        console.warn(`[azureReadExtract] tentativa falhou (${base}/${Object.keys(headerBuilder(key))[0]}): ${err.message}`);
        lastErr = err;
      }
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('Azure OCR falhou por motivo desconhecido.');
}

/* ========================= Fluxo principal: PDF ========================= */
async function extractTextFromPdf(pdfBuffer, filePath) {
  // 1) tenta texto nativo (barato)
  try {
    const data = await pdfParse(pdfBuffer);
    const text = normalizeSpaces(data.text || '');

    // Se tem “bastante” texto → já retorna e NÃO faz OCR
    if (hasTextEnough(text)) return text;

    // Se tem pouco texto mas o PDF NÃO é imagem-only → evita OCR pra reduzir custo
    if (!isLikelyImageOnlyPdf(pdfBuffer)) {
      if (text && text.trim().length > 0) {
        return text; // retorna o pouco que tiver, mas não chama Azure
      }
      // ainda sem texto? se OCR não estiver habilitado, retorna vazio
      if (!OCR_ENABLED) return '';
      // com OCR habilitado, só cai no Azure se for imagem-only (abaixo)
    }
  } catch (e) {
    console.error('[extractTextFromPdf] Falha no pdf-parse:', filePath || '(buffer)', e.message);
    // se pdf-parse falhar, ainda podemos decidir por OCR se for imagem-only
  }

  // 2) Se OCR habilitado e PDF parece imagem-only → Azure (páginas limitadas)
  if (OCR_ENABLED && isLikelyImageOnlyPdf(pdfBuffer)) {
    try {
      console.log('[extractTextFromPdf] PDF parece escaneado → Azure OCR');
      const text = await azureReadExtract(pdfBuffer, 'application/pdf');
      return text || '';
    } catch (e) {
      console.error('[extractTextFromPdf] Azure OCR falhou:', e.message);
      return '';
    }
  }

  // 3) caso restante: sem OCR ou não parece imagem-only
  return '';
}

/* ========================= (Opcional) imagem ========================= */
async function extractTextFromImage(_imagePath) {
  return ''; // mantido vazio; foco é Azure OCR para PDF
}

module.exports = { extractTextFromPdf, extractTextFromImage };
