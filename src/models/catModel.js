const { query, transaction } = require('../Config/db');
const { decode, newId } = require('./sqlRecords');

const fields = ['meta', 'linkKeys', 'keywords'];

async function findBySource(companyId, source) {
  const [row] = await query('SELECT chunkCount FROM cats WHERE companyId = ? AND source = ?', [companyId, source]);
  return row || null;
}

async function replace(document, chunks) {
  const { companyId, source, fileName, gestor, fullText, docType, meta, linkKeys, domain, keywords, processedAt } = document;
  await transaction(async connection => {
    await query(`INSERT INTO cats
      (id, companyId, source, fileName, gestor, fullText, docType, meta, linkKeys, domain, keywords, chunkCount, processedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS incoming
      ON DUPLICATE KEY UPDATE fileName = incoming.fileName, gestor = incoming.gestor,
      fullText = incoming.fullText, docType = incoming.docType, meta = incoming.meta, linkKeys = incoming.linkKeys,
      domain = incoming.domain, keywords = incoming.keywords, chunkCount = incoming.chunkCount, processedAt = incoming.processedAt`,
    [newId(), companyId, source, fileName, gestor, fullText, docType ?? null, JSON.stringify(meta),
      JSON.stringify(linkKeys ?? null), domain ?? null, JSON.stringify(keywords), chunks.length, processedAt], connection);
    await query('DELETE FROM chunks WHERE companyId = ? AND source = ?', [companyId, source], connection);
    for (const [index, chunk] of chunks.entries()) {
      await query('INSERT INTO chunks (companyId, source, chunkIndex, text, embedding) VALUES (?, ?, ?, ?, ?)',
        [companyId, source, index, chunk.text, JSON.stringify(chunk.embedding ?? null)], connection);
    }
  });
}

async function list(companyId, { limit, skip = 0, search = '', includeText = false }) {
  const columns = includeText ? '*' : 'id, source, fileName, gestor, docType, meta, linkKeys, domain, keywords, chunkCount, processedAt';
  const params = [companyId];
  let filter = '';
  if (search) {
    filter = ` AND LOCATE(?, CONCAT_WS(' ', source, gestor, fileName, docType, domain,
      CAST(keywords AS CHAR), CAST(meta AS CHAR)) COLLATE utf8mb4_0900_ai_ci) > 0`;
    params.push(search);
  }
  const rows = await query(`SELECT ${columns} FROM cats WHERE companyId = ?${filter} ORDER BY processedAt DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(skip)]);
  return rows.map(row => decode(row, fields));
}

async function count(companyId) {
  const [row] = await query('SELECT COUNT(*) AS total FROM cats WHERE companyId = ?', [companyId]);
  return Number(row.total);
}

async function remove(companyId, source) {
  return transaction(async connection => {
    const [document] = await query('SELECT id FROM cats WHERE companyId = ? AND source = ? FOR UPDATE',
      [companyId, source], connection);
    if (!document) return { catsDeleted: 0, chunksDeleted: 0 };
    const chunks = await query('DELETE FROM chunks WHERE companyId = ? AND source = ?', [companyId, source], connection);
    const cats = await query('DELETE FROM cats WHERE id = ?', [document.id], connection);
    return { catsDeleted: cats.affectedRows, chunksDeleted: chunks.affectedRows };
  });
}

async function listChunks(companyId, limit) {
  return query('SELECT source, text FROM chunks WHERE companyId = ? ORDER BY source, chunkIndex LIMIT ?', [companyId, String(limit)]);
}

async function searchChunks(companyId, tokens, limit, { domains = [], sources = [] } = {}) {
  if (!companyId || !tokens.length) return [];
  const params = [companyId];
  let filter = 'chunks.companyId = ?';
  if (domains.length) {
    filter += ` AND cats.domain IN (${domains.map(() => '?').join(', ')})`;
    params.push(...domains);
  }
  if (sources.length) {
    filter += ` AND cats.docType IN (${sources.map(() => '?').join(', ')})`;
    params.push(...sources);
  }
  const from = `FROM chunks JOIN cats USING (companyId, source) WHERE ${filter}`;
  const search = tokens.join(' ');
  const rows = await query(`SELECT chunks.source, chunks.text, MATCH(chunks.text) AGAINST (?) AS score
    ${from} AND MATCH(chunks.text) AGAINST (?) > 0 ORDER BY score DESC, chunks.source, chunks.chunkIndex LIMIT ?`,
    [search, ...params, search, String(limit)]);
  if (rows.length) return rows;
  const alternatives = tokens.map(() => 'LOCATE(?, chunks.text) > 0').join(' OR ');
  return query(`SELECT chunks.source, chunks.text ${from} AND (${alternatives}) ORDER BY chunks.source, chunks.chunkIndex LIMIT ?`,
    [...params, ...tokens, String(limit)]);
}

module.exports = { findBySource, replace, list, count, remove, listChunks, searchChunks };
