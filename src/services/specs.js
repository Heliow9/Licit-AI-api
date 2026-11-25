// src/services/specs.js
// Extrai e normaliza especificações técnicas de textos de CATs/Atestados/TR.
// Combina heurísticas (regex) + fallback via LLM (Azure) para enriquecer.

const { chatText } = require('../services/azure');
const { AZ_ENDPOINT, AZ_KEY, CHAT_DEPLOY } = require('../Config/env');

/* ========================= Gate do LLM ========================= */
const LLM_READY = !!(AZ_ENDPOINT && AZ_KEY && CHAT_DEPLOY);

/* ========================= Mapeamento e normalização ========================= */

const UNIT_ALIASES = {
  W:  ['w', 'watt', 'watts', 'wats', 'wtts'],
  KW: ['kw', 'kilowatt', 'kilowatts'],
  MW: ['mw', 'megawatt', 'megawatts'],
  KVA:['kva', 'kva(s)', "kva's"],
  KV: ['kv', 'kilovolt', 'kilovolts'],
  V:  ['v', 'volt', 'volts'],
  // ⚠️ NUNCA mapear 'a' (preposição) para Ampere
  A:  ['ampere', 'amperes', 'amps', 'amp'],
  HZ: ['hz', 'hertz'],
  LM: ['lm', 'lumen', 'lumens'],
  // ⚠️ NUNCA mapear 'k' minúsculo puro para Kelvin
  K:  ['kelvin', '°k'], // manteremos 'K' explícito no regex, e 'kelvin' aqui
  PF: ['fp', 'pf', 'fator de potência', 'power factor'],
  IP: ['ip'],
  IK: ['ik'],
  THD:['thd', 'dht', 'distorção harmônica', 'total harmonic distortion'],
  COSPHI: ['cos φ', 'cos phi', 'cosφ', 'cos-phi'],
};

const NORMALIZE_UNIT = (() => {
  const map = new Map();
  for (const [norm, arr] of Object.entries(UNIT_ALIASES)) {
    map.set(norm.toLowerCase(), norm);
    for (const a of arr) map.set(a.toLowerCase(), norm);
  }
  return (u) => map.get(String(u || '').toLowerCase()) || null;
})();

function toNumberBr(s) {
  if (s == null) return null;
  const t = String(s).trim();
  const n = t.replace(/\./g, '').replace(',', '.').replace(/\s/g, '');
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

/* ========================= Tipos genéricos ====================== */

const TYPE_FROM_UNIT = {
  W: 'POWER_ACTIVE',
  KW: 'POWER_ACTIVE',
  MW: 'POWER_ACTIVE',
  KVA: 'POWER_APPARENT',
  KV: 'VOLTAGE_LEVEL',
  V: 'VOLTAGE',
  A: 'CURRENT',
  HZ: 'FREQUENCY',
  LM: 'LUMINOUS_FLUX',
  K: 'COLOR_TEMP',
  PF: 'POWER_FACTOR',
  THD: 'THD',
};

function kvToV(v) { return v * 1000; }
function kwToW(v) { return v * 1000; }
function mwToW(v) { return v * 1_000_000; }

function normalizeValueUnit(value, unit) {
  if (unit === 'KW') return { normalizedValue: kwToW(value), normalizedUnit: 'W' };
  if (unit === 'MW') return { normalizedValue: mwToW(value), normalizedUnit: 'W' };
  if (unit === 'KV') return { normalizedValue: kvToV(value), normalizedUnit: 'V' };
  return { normalizedValue: value, normalizedUnit: unit };
}

/* ========================= Regex heurísticos ================================ */
/**
 * Valor + unidade “genérica”. Observações:
 * - mantemos apenas unidades que não causam ambiguidade aqui;
 * - 'a' minúsculo NÃO entra; 'A' será verificada via NORMALIZE e ainda com guarda de período;
 * - Kelvin: evitamos 'k' puro; aceitamos 'K' explícito ou 'kelvin'.
 */
const RX_VALUE_UNIT = new RegExp(
  String.raw`(?<![A-Za-z0-9])` +
  String.raw`(\d{1,3}(?:[\.\s]\d{3})*(?:\,\d+)?|\d+(?:\,\d+)?)\s*` +
  // w|watts?|kw|mw|kv|kva|v|A|amp...|hz|lm|K|kelvin
  String.raw`(w|watts?|kw|mw|kv|kva|v|A|amp(?:ere|eres|s)?|hz|lm|K|kelvin)\b`,
  'g'
);

// IP/IK/PF/THD
const RX_IP  = /\bIP\s*([0-6][0-9])\b/ig;
const RX_IK  = /\bIK\s*(?:[0-9]|1[0])\b/ig; // 0–10
const RX_PF  = /\b(?:fator(?:\s+de)?\s+pot[eê]ncia|pf|cos\s*[φphi])\s*[:=]?\s*(\d+(?:[\,\.]\d+)?)/ig;
const RX_THD = /\b(?:thd|dht|distor[cç][aã]o\s+harm[oô]nica)\s*[:=]?\s*(\d+(?:[\,\.]\d+)?)\s*%?/ig;

// Guarda: “ a dd/mm/yyyy” após o match (período de datas)
const AHEAD_PERIOD_DATE = /^(?:\s*[aà]\s*\d{1,2}\/\d{1,2}\/\d{2,4})/i;

/* ========================= Util ================================ */
function snippetAround(text, idx, span = 80) {
  const start = Math.max(0, idx - span);
  const end = Math.min(text.length, idx + span);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function dedupEntities(arr) {
  const key = (e) => `${e.type}|${e.normalizedValue}|${e.normalizedUnit}`;
  const seen = new Set();
  const out  = [];
  for (const e of arr) {
    const k = key(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/* ========================= Extração principal (regex) ====================== */

function extractEntitiesHeuristic(text, { domainHint } = {}) {
  const entities = [];
  const push = (e) => entities.push({ ...e, confidence: e.confidence ?? 0.7 });
  const s = String(text || '');

  let m;
  while ((m = RX_VALUE_UNIT.exec(s))) {
    const rawVal = toNumberBr(m[1]);
    const rawUnitToken = m[2]; // como apareceu no texto
    if (rawVal == null) continue;

    // normaliza unidade (considera aliases)
    let unit = NORMALIZE_UNIT(rawUnitToken);
    // caso especial: 'A' explícito vem como 'A' (NORMALIZE_UNIT não tem 'a' simples)
    if (!unit && rawUnitToken === 'A') unit = 'A';
    if (!unit) continue;

    // guarda contra período de datas quando “A”
    if (unit === 'A') {
      const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 16);
      if (AHEAD_PERIOD_DATE.test(tail)) continue; // é "a dd/mm/yyyy", não Ampere
    }

    const type = TYPE_FROM_UNIT[unit] || 'UNKNOWN_QUANTITY';
    const { normalizedValue, normalizedUnit } = normalizeValueUnit(rawVal, unit);

    push({
      type,
      value: rawVal,
      unit,
      normalizedValue,
      normalizedUnit,
      raw: m[0],
      context: snippetAround(s, m.index),
    });
  }

  // IP
  while ((m = RX_IP.exec(s))) {
    push({
      type: 'INGRESS_PROTECTION',
      value: `IP${m[1]}`,
      unit: 'IP',
      normalizedValue: `IP${m[1]}`,
      normalizedUnit: 'IP',
      raw: m[0],
      context: snippetAround(s, m.index),
    });
  }

  // IK (0–10)
  const RX_IK_ALL = /\bIK\s*([0-9]|1[0])\b/ig;
  while ((m = RX_IK_ALL.exec(s))) {
    push({
      type: 'IMPACT_PROTECTION',
      value: `IK${m[1]}`,
      unit: 'IK',
      normalizedValue: `IK${m[1]}`,
      normalizedUnit: 'IK',
      raw: m[0],
      context: snippetAround(s, m.index),
    });
  }

  // PF
  while ((m = RX_PF.exec(s))) {
    const v = toNumberBr(m[1]);
    if (v != null) {
      push({
        type: 'POWER_FACTOR',
        value: v,
        unit: 'PF',
        normalizedValue: v,
        normalizedUnit: 'PF',
        raw: m[0],
        context: snippetAround(s, m.index),
      });
    }
  }

  // THD
  while ((m = RX_THD.exec(s))) {
    const v = toNumberBr(m[1]);
    if (v != null) {
      push({
        type: 'THD',
        value: v,
        unit: 'THD',
        normalizedValue: v,
        normalizedUnit: 'THD',
        raw: m[0],
        context: snippetAround(s, m.index),
      });
    }
  }

  return dedupEntities(entities);
}

/* ========================= Enriquecimento via LLM (opcional) ========================== */

async function extractEntitiesLLM(text, { domainHint } = {}) {
  if (!LLM_READY) return []; // sem env/azure: não tenta

  const prompt = `
Extraia do TEXTO as especificações técnicas relevantes como uma lista de objetos JSON,
cada objeto com: { "type", "value", "unit", "normalizedValue", "normalizedUnit", "raw", "note" }.
Use estes types quando couberem: POWER_ACTIVE(W), POWER_APPARENT(KVA), VOLTAGE_LEVEL(KV), VOLTAGE(V),
CURRENT(A), FREQUENCY(Hz), LUMINOUS_FLUX(lm), COLOR_TEMP(K), INGRESS_PROTECTION(IP), IMPACT_PROTECTION(IK),
POWER_FACTOR(PF), THD(%). Normalize unidades (kV->V, kW->W, MW->W).
Responda **apenas** com JSON de array.

DOMÍNIO (dica): ${domainHint || 'geral'}
TEXTO:
"""${String(text || '').slice(0, 20000)}"""
  `.trim();

  try {
    const out = await chatText(prompt, {
      temperature: 0.1,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
    });
    let json = null;
    try { json = JSON.parse(out); } catch {
      const m = out && out.match && out.match(/\[[\s\S]*\]/);
      if (m) json = JSON.parse(m[0]);
    }
    if (!Array.isArray(json)) return [];
    return json
      .map((e) => {
        const v = Number(e.value);
        const u = e.unit || null;
        const norm = normalizeValueUnit(Number(e.normalizedValue ?? v), e.normalizedUnit ?? u);
        return {
          type: e.type || null,
          value: Number.isFinite(v) ? v : null,
          unit: u,
          normalizedValue: norm.normalizedValue,
          normalizedUnit: norm.normalizedUnit,
          raw: e.raw || null,
          context: e.note || null,
          confidence: 0.9,
        };
      })
      .filter((e) => e.type && e.unit && Number.isFinite(e.normalizedValue));
  } catch (err) {
    console.warn('[extractEntitiesLLM] falhou:', err.message);
    return [];
  }
}

/* ========================= API pública ========================== */

async function extractSpecs(text, { domainHint } = {}) {
  const base = extractEntitiesHeuristic(text, { domainHint });
  const llmEnriched = await extractEntitiesLLM(text, { domainHint });
  const merged = dedupEntities([...base, ...llmEnriched]);
  return merged;
}

function compareSpecs(entities, constraints) {
  let score = 0, total = 0;
  const details = [];

  for (const c of constraints || []) {
    total++;

    const uNorm = NORMALIZE_UNIT(c.unit);
    let vNorm = c.value;
    if (uNorm === 'KW') vNorm = kwToW(c.value);
    if (uNorm === 'MW') vNorm = mwToW(c.value);
    if (uNorm === 'KV') vNorm = kvToV(c.value);

    const matches = entities.filter(e => e.type === c.type);
    let ok = false;

    if (!matches.length) {
      details.push({ constraint: c, ok: false, reason: 'no_entity' });
      continue;
    }

    if (['IP','IK'].includes(uNorm)) {
      ok = matches.some(e => String(e.normalizedValue).toUpperCase() === String(vNorm).toUpperCase());
    } else if (typeof vNorm === 'number') {
      ok = matches.some(e => checkOp(e.normalizedValue, vNorm, c.op));
    } else {
      ok = false;
    }

    score += ok ? 1 : 0;
    details.push({ constraint: c, ok, examples: matches.slice(0,3) });
  }

  return { score, total, pass: score === total, details };
}

function checkOp(entityVal, reqVal, op) {
  switch (op) {
    case '>=': return entityVal >= reqVal;
    case '<=': return entityVal <= reqVal;
    case '==': return entityVal === reqVal;
    case '>':  return entityVal >  reqVal;
    case '<':  return entityVal <  reqVal;
    default:   return false;
  }
}

module.exports = {
  extractSpecs,
  compareSpecs,
  NORMALIZE_UNIT,
  normalizeValueUnit
};
