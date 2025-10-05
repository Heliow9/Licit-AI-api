function normalizeSpaces(t='') {
  return t.replace(/\r/g,' ')
          .replace(/\t/g,' ')
          .replace(/[ \f\v]+/g,' ')
          .replace(/\u00A0/g,' ')
          .replace(/\s+\n/g,'\n')
          .trim();
}

function* chunkTextGenerator(text, maxLen = 2000, overlap = 120) {
  let i = 0; const N = text.length;
  while (i < N) {
    const end = Math.min(N, i + maxLen);
    yield text.slice(i, end);
    if (end >= N) break;
    i = Math.max(0, end - overlap);
  }
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
function maintainTopK(top, item, k = 4) { top.push(item); top.sort((a,b)=>b.score-a.score); if (top.length>k) top.pop(); }

module.exports = { normalizeSpaces, chunkTextGenerator, cosineSim, maintainTopK };
