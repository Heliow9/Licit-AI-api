// src/models/companyModel.js
const { ObjectId } = require('mongodb');
const { getDb } = require('../Config/db');

const COLLECTION = 'companies';

async function ensureIndexes() {
  const db = await getDb();
  // cnpj único (opcionalmente sparse se nem todas têm cnpj)
  await db.collection(COLLECTION).createIndex({ cnpj: 1 }, { unique: true, sparse: true });
}

async function findById(id) {
  const db = await getDb();
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

async function findByCnpj(cnpjDigits) {
  const db = await getDb();
  return db.collection(COLLECTION).findOne({ cnpj: String(cnpjDigits) });
}

async function create({ name, cnpj, contact, address, plan = 'free', createdBy = null }) {
  await ensureIndexes();
  const db = await getDb();
  const doc = {
    name,
    cnpj: cnpj ? String(cnpj).replace(/\D/g, '') : null,
    contact: contact || {},
    address: address || {},
    plan,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const ins = await db.collection(COLLECTION).insertOne(doc);
  return { ...doc, _id: ins.insertedId };
}

async function updateById(id, patch) {
  const db = await getDb();
  const { value } = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: patch },
    { returnDocument: 'after' }
  );
  return value;
}

module.exports = { findById, findByCnpj, create, updateById };
