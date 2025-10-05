// src/models/userModel.js
const { ObjectId } = require('mongodb');
const { getDb } = require('../Config/db');

const COLLECTION = 'users';

async function ensureIndexes() {
  const db = await getDb();
  await db.collection(COLLECTION).createIndex({ email: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ companyId: 1 });
}

async function findByEmail(email) {
  const db = await getDb();
  return db.collection(COLLECTION).findOne({ email: String(email).toLowerCase().trim() });
}

async function findById(id) {
  const db = await getDb();
  return db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });
}

async function create({ email, passwordHash, name, role = 'user', companyId = null, status = 'active', settings = {} }) {
  await ensureIndexes();
  const db = await getDb();
  const doc = {
    email: String(email).toLowerCase().trim(),
    passwordHash,
    name: name || null,
    role,
    companyId: companyId ? new ObjectId(companyId) : null,
    status,
    settings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const ins = await db.collection(COLLECTION).insertOne(doc);
  return { ...doc, _id: ins.insertedId };
}

async function updateById(id, patch) {
  const db = await getDb();
  // converte companyId se vier string
  if (patch.companyId && typeof patch.companyId === 'string') {
    patch.companyId = new ObjectId(patch.companyId);
  }
  const { value } = await db.collection(COLLECTION).findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: patch },
    { returnDocument: 'after' }
  );
  return value;
}

async function findAllByCompany(companyId) {
  const db = await getDb();
  return db
    .collection(COLLECTION)
    .find({ companyId: new ObjectId(companyId) })
    .toArray();
}

async function removeById(id) {
  const db = await getDb();
  await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
}

module.exports = { findByEmail, findById, create, updateById, findAllByCompany, removeById };
