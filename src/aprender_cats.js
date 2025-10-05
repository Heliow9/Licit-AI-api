// src/server.js — Azure OpenAI (Top-K on-the-fly, OCR opcional, fallback Mongo opcional)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const OpenAI = require('openai');
const { MongoClient } = require('mongodb');
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const poppler = require('pdf-poppler');

// ===== 1) CONFIG =====
const app = express();
const PORT = process.env.PORT || 3001;

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const TEMP_PATH = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH);

// Limites de segurança de memória
const MAX_EDITALTEXT_CHARS = parseInt(process.env.MAX_EDITALTEXT_CHARS || '50000', 10);
const MAX_CHUNKS_PER_FILE  = parseInt(process.env.MAX_CHUNKS_PER_FILE  || '1200', 10);
const OCR_ENABLED          = String(process.env.OCR_ENABLED || 'false').toLowerCase() === 'true';
const OCR_MAX_PAGES        = parseInt(process.env.OCR_MAX_PAGES || '1', 10);

// ===== Azure OpenAI via SDK oficial =====
if (!process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
  console.warn('⚠️  Configure AZURE_OPENAI_API_KEY e AZURE_OPENAI_ENDPOINT no .env');
}

const rawEndpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
// garante que tenha /openai no final
const baseURL = /\/openai$/i.test(rawEndpoint) ? rawEndpoint : `${rawEndpoint}/openai`;

const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-06-01';
const CHAT_DEPLOYMENT  = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT  || 'chat-model';
const EMBED_DEPLOYMENT = process.env.AZURE_OPENAI_EMBED_DEPLOYMENT || 'embed-model';

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL,
  defaultQuery: { 'api-version': AZURE_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY }
});

console.log(`🔗 Azure baseURL: ${baseURL} | api-version=${AZURE_API_VERSION}`);
console.log(`🧩 Deployments: chat=${CHAT_DEPLOYMENT} | embed=${EMBED_DEPLOYMENT}`);

// ===== Mongo (opcional) =====
const mongoClient = process.env.MONGO_URI ? new MongoClient(process.env.MONGO_URI) : null;
const dbName = 'analista_digital_db';
const chunksCollectionName = 'chunks';

// Middlewares
app.use(cors());
app.use(express.json());
const upload = multer({ dest: uploadDir });

// ===== 2) UTILS =====
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function azureWithRetry(apiCallFunction, {
  totalTimeoutMs = parseInt(process.env.AZURE_TOTAL_TIMEOUT_MS || '900000', 10), // 15m
  baseDelayMs = 1500,
  maxDelayMs = 60000,
  maxAttempts = 12,
  label = 'AzureCall'
} = {}) {
  const start = Date.now();
  let attempt = 0;
  let lastErr;
  while ((Date.now() - start) < totalTimeoutMs && attempt < maxAttempts) {
    attempt++;
    try {
      return await apiCallFunction();
    } catch (error) {
      lastErr = error;
      const status = error?.statusCode || error?.status || error?.response?.status;
      const isRate = status === 429;
      const isBusy = status === 503 || status === 500;
      if (!isRate && !isBusy) throw error;

      // Retry-After header (se existir)
      let retryDelayMs = null;
      const ra = error?.response?.headers?.['retry-after'] || error?.response?.headers?.get?.('retry-after');
      if (ra) {
        const s = parseInt(String(ra), 10);
        if (!Number.isNaN(s)) retryDelayMs = (s + 1) * 1000;
      }
      if (!retryDelayMs) {
        const expo = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        const jitter = Math.floor(Math.random() * 1000);
        retryDelayMs = expo + jitter;
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`   -> ⏳ [${label} | Tentativa ${attempt}] status=${status}. ${elapsed}s. Aguardando ${Math.round(retryDelayMs/1000)}s...`);
      if ((Date.now() - start) + retryDelayMs > totalTimeoutMs) break;
      await delay(retryDelayMs);
    }
  }
  throw new Error(`Falha na chamada da API (${label}): tempo total excedido / tentativas esgotadas. Último erro: ${lastErr?.message || lastErr}`);
}

function chunkTextGenerator(text, maxLen = 2000, overlap = 100) {
  return (function* () {
    let i = 0;
    const N = text.length;
    while (i < N) {
      const end = Math.min(N, i + maxLen);
      yield text.slice(i, end);
      if (end >= N) break;
      i = end - overlap;
      if (i < 0) i = 0;
    }
  })();
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function maintainTopK(top, item, k = 4) {
  top.push(item);
  top.sort((a, b) => b.score - a.score);
  if (top.length > k) top.pop();
}

// ===== 3) PDF/TEXTO (OCR opcional) =====
async function extractTextFromPdf(pdfBuffer, filePath) {
  try {
    const data = await pdfParse(pdfBuffer);
    if (data.text && data.text.trim().length > 50) return data.text;
  } catch {
    console.log(' -> ⚠️ Falha no pdf-parse; avaliando OCR...');
  }

  if (!OCR_ENABLED) {
    console.log(' -> OCR desativado (OCR_ENABLED=false). Retornando vazio.');
    return '';
  }

  const tempPdfPath = path.join(TEMP_PATH, path.basename(filePath));
  fs.writeFileSync(tempPdfPath, pdfBuffer);
  try {
    let finalText = '';
    for (let page = 1; page <= OCR_MAX_PAGES; page++) {
      const outPrefix = path.join(TEMP_PATH, `${path.basename(filePath, '.pdf')}_p${page}`);
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
    return finalText;
  } finally {
    try { fs.existsSync(tempPdfPath) && fs.unlinkSync(tempPdfPath); } catch {}
  }
}

// ===== 4) Azure OpenAI wrappers =====
async function embedText(text) {
  const r = await azureWithRetry(
    () => openai.embeddings.create({ model: EMBED_DEPLOYMENT, input: text }),
    { label: 'Embed' }
  );
  return r.data[0].embedding;
}

async function chatText(prompt) {
  const r = await azureWithRetry(
    () => openai.chat.completions.create({
      model: CHAT_DEPLOYMENT,
      messages: [
        { role: 'system', content: 'Você é um assistente especializado em leitura de editais.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    }),
    { label: 'Chat' }
  );
  return r.choices?.[0]?.message?.content || '';
}

// ===== 5) IA (prompts) =====
async function extractRequirementsFromBid(bidText) {
  console.log(' -> Etapa 1: Extraindo requisitos do edital com a IA...');
  const prompt = `Analise o texto a seguir (edital e/ou anexos) e extraia **APENAS** os principais requisitos de habilitação (técnica/administrativa) em **JSON array**.
Exemplos:
- "Apresentar documentos conforme Anexo XV."
- "Comprovar experiência em serviços de manutenção."
- "Apresentar CAT do responsável técnico."
Texto (parcial): --- ${bidText.substring(0, 25000)} ---`;
  const t = await chatText(prompt);
  const m = t.match(/(\[[\s\S]*\])/);
  if (!m) {
    console.error('Resposta IA (sem JSON array):', t);
    throw new Error('Não foi possível obter um JSON array de requisitos.');
  }
  return JSON.parse(m[0]);
}

async function analyzeSingleRequirement(requirement, evidence) {
  const ev = evidence.map(e => `- Trecho do arquivo '${e.source}' (similaridade: ${typeof e.score === 'number' ? e.score.toFixed(2) : e.score}): "${e.text}"`).join('\n');
  const prompt = `Análise de Requisito de Edital:
- Requisito: "${requirement}"
- Evidências (apenas os trechos abaixo):
${ev || 'Nenhuma evidência encontrada.'}

Com base **APENAS** nas evidências acima, responda em 1-2 parágrafos, começando com o status em negrito: '**ATENDIDO**', '**ATENDIDO PARCIALMENTE**' ou '**NÃO ATENDIDO**', seguido da justificativa.`;
  const txt = await chatText(prompt);
  return `### Requisito: ${requirement}\n\n${txt}\n\n---\n\n`;
}

async function generateExecutiveSummary(detailedAnalyses) {
  const prompt = `Com base nas análises abaixo, produza um "Sumário Executivo" em Markdown com:
1. **Recomendação Final**
2. **Pontos Fortes**
3. **Pontos de Atenção / GAPs**

Análises:
---
${detailedAnalyses.join('')}`;
  return await chatText(prompt);
}

// ===== 6) EVIDÊNCIA (Top-K on-the-fly) =====
async function findEvidenceOnTheFly(requirement, filesMeta, collection) {
  const qv = await embedText(requirement);

  const anexMatch = requirement.match(/anexo\s+([xivlcdm0-9]+)/i);
  const anexHint = anexMatch ? String(anexMatch[1]).toUpperCase() : null;
  const rxAnexo = anexHint ? new RegExp(`anexo\\s*${anexHint}`, 'i') : null;

  let topLocal = [];

  for (const fm of filesMeta) {
    const { source, getText } = fm;
    const text = await getText();
    if (!text || !text.trim()) continue;

    let count = 0;
    for (const ctext of chunkTextGenerator(text)) {
      if (!ctext || !ctext.trim()) continue;
      if (++count > MAX_CHUNKS_PER_FILE) break;

      const chVec = await embedText(ctext);
      let score = cosineSim(qv, chVec);

      if (anexHint) {
        const srcUp = (source || '').toUpperCase();
        if (srcUp.includes('ANEXO') && srcUp.includes(anexHint)) score += 0.15;
        if (rxAnexo?.test(ctext)) score += 0.10;
      }

      maintainTopK(topLocal, { source, text: ctext, score }, 4);
      await delay(40 + Math.floor(Math.random() * 60));
    }
  }
  return topLocal;
}

// ===== 7) ROTA PRINCIPAL =====
app.post('/api/analisar-edital', upload.fields([
  { name: 'arquivos',   maxCount: 20 },
  { name: 'arquivos[]', maxCount: 20 },
  { name: 'editalPdf',  maxCount: 20 },
  { name: 'file',       maxCount: 20 },
]), async (req, res) => {
  const allFiles = [
    ...(req.files?.['arquivos'] || []),
    ...(req.files?.['arquivos[]'] || []),
    ...(req.files?.['editalPdf'] || []),
    ...(req.files?.['file'] || []),
  ];
  if (allFiles.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo foi enviado.' });
  }

  const tz = 'America/Recife';
  console.log(`\n-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=`);
  console.log(`[${new Date().toLocaleString('pt-BR', { timeZone: tz })}] Nova análise com ${allFiles.length} arquivo(s).`);

  let mongoConnection = null;
  let collection = null;

  try {
    if (mongoClient) {
      try {
        mongoConnection = await mongoClient.connect();
        collection = mongoConnection.db(dbName).collection(chunksCollectionName);
        console.log(' -> Conectado ao MongoDB.');
      } catch {
        console.log(' -> Aviso: não foi possível conectar ao Mongo. Seguindo só com PDFs enviados.');
      }
    }

    let totalLen = 0;
    const filesMeta = [];
    let editalTextForReqs = '';

    for (const f of allFiles) {
      const source = f.originalname;
      const buf = fs.readFileSync(f.path);
      const text = await extractTextFromPdf(buf, f.path);

      filesMeta.push({ source, getText: async () => text });

      if (totalLen < MAX_EDITALTEXT_CHARS && text && text.length) {
        const remaining = MAX_EDITALTEXT_CHARS - totalLen;
        const slice = text.slice(0, remaining);
        editalTextForReqs += `\n\n=== ARQUIVO: ${source} ===\n\n${slice}`;
        totalLen += slice.length;
      }
    }

    if (!editalTextForReqs.trim()) {
      throw new Error('Não foi possível extrair texto dos PDFs.');
    }

    const requirements = await extractRequirementsFromBid(editalTextForReqs);
    console.log(` -> Requisitos extraídos: ${requirements.length}`);
    if (!Array.isArray(requirements) || requirements.length === 0) {
      return res.json({ report: '# RELATÓRIO DE VIABILIDADE\n\nNenhum requisito identificado automaticamente.' });
    }

    const detailedAnalyses = [];
    console.log('\n🔎 Iniciando análise requisito a requisito...');
    for (let i = 0; i < requirements.length; i++) {
      const reqTxt = String(requirements[i] || '').trim();
      if (!reqTxt) continue;

      console.log(`   -> Requisito ${i + 1}/${requirements.length}: "${reqTxt.substring(0, 60)}..."`);
      const evidence = await findEvidenceOnTheFly(reqTxt, filesMeta, collection);
      const single = await analyzeSingleRequirement(reqTxt, evidence);
      detailedAnalyses.push(single);

      await delay(900 + Math.floor(Math.random() * 700));
    }

    console.log('\n🧠 Gerando Sumário Executivo...');
    const summary = await generateExecutiveSummary(detailedAnalyses);
    const finalReport = `# RELATÓRIO DE VIABILIDADE\n\n## SUMÁRIO EXECUTIVO\n${summary}\n\n---\n\n## ANÁLISE DETALHADA\n\n${detailedAnalyses.join('')}`;

    console.log(' -> Análise concluída!');
    res.json({ report: finalReport });

  } catch (error) {
    console.error(' -> ❌ Erro:', error);
    res.status(500).json({ error: 'Erro interno.', details: error.message });
  } finally {
    if (mongoConnection) {
      try { await mongoConnection.close(); } catch {}
      console.log(' -> Conexão DB fechada.');
    }
    const clean = (arr=[]) => arr.forEach(f => { if (f?.path && fs.existsSync(f.path)) { try { fs.unlinkSync(f.path); } catch {} }});
    clean(req.files?.['arquivos']);
    clean(req.files?.['arquivos[]']);
    clean(req.files?.['editalPdf']);
    clean(req.files?.['file']);
    console.log(' -> Uploads removidos.');
    console.log(`-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=\n`);
  }
});

// ===== 8) START =====
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`💳 Azure OpenAI em uso (chat=${CHAT_DEPLOYMENT}, embed=${EMBED_DEPLOYMENT})`);
});
