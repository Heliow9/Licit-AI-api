const { AZ_ENDPOINT, AZ_VER, AZ_KEY, CHAT_DEPLOY, EMBED_DEPLOY } = require('../Config/env');
const BASE_OPENAI = `${AZ_ENDPOINT}/openai`;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(doCall, { totalTimeoutMs = 15 * 60 * 1000, baseDelayMs = 1200, maxDelayMs = 60_000, maxAttempts = 12, label = 'AzureCall' } = {}) {
  const start = Date.now();
  let attempt = 0,
    lastErr;
  while ((Date.now() - start) < totalTimeoutMs && attempt < maxAttempts) {
    attempt++;
    try {
      return await doCall();
    } catch (error) {
      lastErr = error;
      const status = error?.statusCode || error?.status || error?.response?.status;
      const isRate = status === 429;
      const isBusy = status === 500 || status === 503;
      if (!isRate && !isBusy) throw error;
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
      if ((Date.now() - start) + retryDelayMs > totalTimeoutMs) break;
      await delay(retryDelayMs);
    }
  }
  throw new Error(`Falha Azure (${label}) após ${attempt} tentativas. Último erro: ${lastErr?.message}`);
}

async function chatText(prompt) {
  const url = `${BASE_OPENAI}/deployments/${CHAT_DEPLOY}/chat/completions?api-version=${AZ_VER}`;
  const body = {
    messages: [{
      role: 'system',
      content: 'Você é um expert em processos licitórios e editais'
    }, {
      role: 'user',
      content: prompt
    }],
    temperature: 0.2
  };
  return await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZ_KEY
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const txt = await r.text();
      const err = new Error(`HTTP ${r.status} - ${txt}`);
      err.response = r;
      throw err;
    }
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }, {
    label: 'Chat'
  });
}

async function embedText(text) {
  const url = `${BASE_OPENAI}/deployments/${EMBED_DEPLOY}/embeddings?api-version=${AZ_VER}`;
  const body = {
    input: text
  };
  return await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZ_KEY
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const txt = await r.text();
      const err = new Error(`HTTP ${r.status} - ${txt}`);
      err.response = r;
      throw err;
    }
    const j = await r.json();
    return j.data?.[0]?.embedding || [];
  }, {
    label: 'Embed'
  });
}

// <<-- FUNÇÃO ADICIONADA -->>
/**
 * Gera embeddings para um LOTE de textos de uma só vez.
 * @param {string[]} texts Array de textos a serem processados.
 * @returns {Promise<number[][]>} Um array de vetores (embeddings), na mesma ordem da entrada.
 */
async function embedTexts(texts) {
  // Se o array estiver vazio, retorna vazio para evitar chamadas desnecessárias à API.
  if (!texts || texts.length === 0) {
    return [];
  }

  const url = `${BASE_OPENAI}/deployments/${EMBED_DEPLOY}/embeddings?api-version=${AZ_VER}`;
  // O corpo da requisição agora envia um array de textos
  const body = {
    input: texts
  };

  return await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZ_KEY
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const txt = await r.text();
      const err = new Error(`HTTP ${r.status} - ${txt}`);
      err.response = r;
      throw err;
    }
    const j = await r.json();

    // A resposta da API em lote inclui um 'index' para cada embedding.
    // Este código garante que o array de vetores retornado esteja na mesma ordem dos textos de entrada.
    const embeddingsMap = new Map(j.data.map(item => [item.index, item.embedding]));
    const sortedEmbeddings = texts.map((_, index) => embeddingsMap.get(index) || []);

    return sortedEmbeddings;
  }, {
    label: 'EmbedBatch'
  });
}


// <<-- EXPORT ATUALIZADO -->>
module.exports = {
  chatText,
  embedText,
  embedTexts, // Nova função exportada
  withRetry
};