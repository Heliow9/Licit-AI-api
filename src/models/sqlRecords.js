const { randomBytes } = require('node:crypto');
const { query } = require('../Config/db');

function newId() {
  return randomBytes(12).toString('hex');
}

function decode(row, fields = []) {
  if (!row) return null;
  const { id, ...data } = row;
  for (const field of fields) {
    if (typeof data[field] === 'string') data[field] = JSON.parse(data[field]);
  }
  return { ...data, _id: id };
}

function encode(data, fields) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key, value == null ? null : fields.includes(key) ? JSON.stringify(value) : value,
  ]));
}

async function insert(table, data, jsonFields, connection) {
  const record = { id: newId(), ...encode(data, jsonFields) };
  const keys = Object.keys(record);
  await query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(record), connection);
  return { ...data, _id: record.id };
}

async function update(table, id, patch, allowed, jsonFields, connection) {
  const selected = Object.fromEntries(allowed.filter(key => patch[key] !== undefined).map(key => [key, patch[key]]));
  const record = encode(selected, jsonFields);
  const keys = Object.keys(record);
  if (keys.length) {
    await query(`UPDATE ${table} SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(record), id], connection);
  }
  const [row] = await query(`SELECT * FROM ${table} WHERE id = ?`, [id], connection);
  return decode(row, jsonFields);
}

module.exports = { newId, decode, insert, update };
