// services/azure.js
const { AZ_ENDPOINT, AZ_VER, AZ_KEY, CHAT_DEPLOY, EMBED_DEPLOY } = require('../Config/env');

// --- util: garante que não haja barras duplicadas ---
function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(suffix || '').replace(/^\/+/, '');
  return `${b}/${s}`;
}
const BASE_OPENAI = joinUrl(AZ_ENDPOINT, 'openai');

// --- fetch (Node 18+ tem global; fallback p/ node-fetch se necessário) ---
const _fetch = (typeof fetch === 'function') ? fetch : (...args) => import('node-fetch').then(m => m.default(...args));

// --- sleep ---
const delay = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Retry com backoff exponencial + timeout por tentativa.
 */
async function withRetry(
  doCall,
  {
    totalTimeoutMs = 15 * 60 * 1000,
    baseDelayMs = 1200,
    maxDelayMs = 60_000,
    maxAttempts = 12,
    attemptTimeoutMs = 45_000, // timeout por tentativa
    label = 'AzureCall',
  } = {}
) {
  const start = Date.now();
  let attempt = 0, lastErr;

  while ((Date.now() - start) < totalTimeoutMs && attempt < maxAttempts) {
    attempt++;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error('Attempt timeout')), attemptTimeoutMs);

    try {
      return await doCall({ signal: controller.signal });
    } catch (error) {
      lastErr = error;
      const status = error?.statusCode || error?.status || error?.response?.status;
      const isRate = status === 429;
      const isBusy = status === 500 || status === 503 || error?.name === 'AbortError';

      if (!isRate && !isBusy) {
        clearTimeout(t);
        throw error;
      }

      let retryDelayMs = null;
      const ra = error?.response?.headers?.get?.('retry-after') || error?.response?.headers?.['retry-after'];
      if (ra) {
        const s = parseInt(String(ra), 10);
        if (!Number.isNaN(s)) retryDelayMs = (s + 1) * 1000;
      }
      if (!retryDelayMs) {
        const expo = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
        retryDelayMs = expo + Math.floor(Math.random() * 1000);
      }
      if ((Date.now() - start) + retryDelayMs > totalTimeoutMs) {
        clearTimeout(t);
        break;
      }
      clearTimeout(t);
      await delay(retryDelayMs);
    } finally {
      clearTimeout(t);
    }
  }
  const msg = lastErr?.message || '(sem mensagem)';
  throw new Error(`Falha Azure (${label}) após ${attempt} tentativas. Último erro: ${msg}`);
}

/**
 * Chat de texto simples.
 * @param {string} prompt
 * @param {{
 *  temperature?: number,
 *  system?: string,
 *  user?: string,
 *  max_tokens?: number,
 *  response_format?: { type: 'json_object' | 'text' | string }
 * }} [opts]
 */
async function chatText(prompt, opts = {}) {
  const {
    temperature = 0.2,
    system = 'Você é um expert em processos licitatórios e editais',
    user,
    max_tokens = 2000,
    response_format // opcional; algumas versões do Azure ainda não suportam
  } = opts;

  const url = joinUrl(BASE_OPENAI, `deployments/${CHAT_DEPLOY}/chat/completions?api-version=${AZ_VER}`);
  const body = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    temperature,
    max_tokens,
    ...(user ? { user } : {}),
    ...(response_format ? { response_format } : {})
  };

  return await withRetry(async ({ signal }) => {
    const r = await _fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZ_KEY
      },
      body: JSON.stringify(body),
      signal
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      const err = new Error(`HTTP ${r.status} - ${txt}`);
      err.response = r;
      throw err;
    }
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || '').trim();
  }, { label: 'Chat' });
}

/**
 * Uma string -> um embedding.
 * @param {string} text
 * @param {{user?: string}} [opts]
 */
async function embedText(text, opts = {}) {
  const url = joinUrl(BASE_OPENAI, `deployments/${EMBED_DEPLOY}/embeddings?api-version=${AZ_VER}`);
  const body = { input: text, ...(opts.user ? { user: opts.user } : {}) };

  return await withRetry(async ({ signal }) => {
    const r = await _fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZ_KEY
      },
      body: JSON.stringify(body),
      signal
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      const err = new Error(`HTTP ${r.status} - ${txt}`);
      err.response = r;
      throw err;
    }
    const j = await r.json();
    return j.data?.[0]?.embedding || [];
  }, { label: 'Embed' });
}

/**
 * Lote de textos -> lote de embeddings (com chunking + pool de concorrência).
 * @param {string[]} texts
 * @param {{user?: string, chunkSize?: number, concurrency?: number}} [opts]
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts, opts = {}) {
  if (!texts || texts.length === 0) return [];
  const { user, chunkSize = 32, concurrency = 3 } = opts; // pool leve p/ estabilidade

  const url = joinUrl(BASE_OPENAI, `deployments/${EMBED_DEPLOY}/embeddings?api-version=${AZ_VER}`);

  // separa em blocos
  const chunks = [];
  for (let i = 0; i < texts.length; i += chunkSize) {
    chunks.push(texts.slice(i, i + chunkSize));
  }

  const results = new Array(texts.length); // manter posição global
  let next = 0;

  async function worker() {
    while (next < chunks.length) {
      const myIdx = next++;
      const chunk = chunks[myIdx];
      const baseIndex = myIdx * chunkSize;

      const body = { input: chunk, ...(user ? { user } : {}) };

      const vecs = await withRetry(async ({ signal }) => {
        const r = await _fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZ_KEY
          },
          body: JSON.stringify(body),
          signal
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          const err = new Error(`HTTP ${r.status} - ${txt}`);
          err.response = r;
          throw err;
        }
        const j = await r.json();
        // Azure retorna data[{ index, embedding }]
        const map = new Map(j.data.map(item => [item.index, item.embedding]));
        return chunk.map((_, idx) => map.get(idx) || []);
      }, { label: 'EmbedBatch' });

      for (let i = 0; i < vecs.length; i++) {
        results[baseIndex + i] = vecs[i];
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

module.exports = {
  chatText,
  embedText,
  embedTexts,
  withRetry
};
