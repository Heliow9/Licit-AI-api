const { query, transaction } = require('../Config/db');
const { decode, insert, update } = require('./sqlRecords');

const jsonFields = ['settings'];
const editable = ['email', 'passwordHash', 'name', 'role', 'companyId', 'status', 'settings', 'lastLoginAt', 'updatedAt'];

async function findByEmail(email) {
  const [row] = await query('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase().trim()]);
  return decode(row, jsonFields);
}

async function findById(id) {
  const [row] = await query('SELECT * FROM users WHERE id = ?', [id]);
  return decode(row, jsonFields);
}

async function create({ email, passwordHash, name, role = 'user', companyId = null, status = 'active', settings = {} }, connection) {
  const now = new Date();
  return insert('users', {
    email: String(email).toLowerCase().trim(), passwordHash, name: name || null,
    role, companyId, status, settings, createdAt: now, updatedAt: now,
  }, jsonFields, connection);
}

async function updateById(id, patch) {
  return transaction(connection => update('users', id, patch, editable, jsonFields, connection));
}

async function findAllByCompany(companyId) {
  const rows = await query('SELECT * FROM users WHERE companyId = ?', [companyId]);
  return rows.map(row => decode(row, jsonFields));
}

async function removeById(id) {
  await query('DELETE FROM users WHERE id = ?', [id]);
}

module.exports = { findByEmail, findById, create, updateById, findAllByCompany, removeById };
