const { query, transaction } = require('../Config/db');
const { decode, insert, update } = require('./sqlRecords');

const jsonFields = ['contact', 'address', 'complianceChecklist'];
const editable = ['name', 'cnpj', 'contact', 'address', 'plan', 'createdBy', 'complianceChecklist', 'updatedAt'];

async function findById(id) {
  const [row] = await query('SELECT * FROM companies WHERE id = ?', [id]);
  return decode(row, jsonFields);
}

async function findByCnpj(cnpjDigits) {
  const [row] = await query('SELECT * FROM companies WHERE cnpj = ?', [String(cnpjDigits)]);
  return decode(row, jsonFields);
}

async function create({ name, cnpj, contact, address, plan = 'free', createdBy = null }, connection) {
  const now = new Date();
  return insert('companies', {
    name, cnpj: cnpj ? String(cnpj).replace(/\D/g, '') || null : null,
    contact: contact || {}, address: address || {}, plan, createdBy, createdAt: now, updatedAt: now,
  }, jsonFields, connection);
}

async function updateById(id, patch, connection) {
  if (connection) return update('companies', id, patch, editable, jsonFields, connection);
  return transaction(conn => update('companies', id, patch, editable, jsonFields, conn));
}

module.exports = { findById, findByCnpj, create, updateById };
