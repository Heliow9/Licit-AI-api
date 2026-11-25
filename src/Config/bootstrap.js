const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');
const schema = require('./schema');

const email = 'admin@realenergy.com.br';

async function seedRealenergy(connection, password, rounds) {
  await connection.execute('INSERT INTO app_bootstrap (id, completed) VALUES (1, 0) ON DUPLICATE KEY UPDATE id = id');
  const [[state]] = await connection.execute('SELECT completed FROM app_bootstrap WHERE id = 1 FOR UPDATE');
  if (state.completed) return;
  if (!password || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Defina REALENERGY_ADMIN_PASSWORD com até 72 bytes para o primeiro boot.');
  }
  const [users] = await connection.execute('SELECT id FROM users WHERE email = ?', [email]);
  if (users.length) throw new Error('O e-mail inicial da REALENERGY já existe no banco.');

  const companyId = randomBytes(12).toString('hex');
  const userId = randomBytes(12).toString('hex');
  const passwordHash = await bcrypt.hash(password, rounds);
  await connection.execute(
    `INSERT INTO companies (id, name, contact, address, plan, createdBy, createdAt, updatedAt)
     VALUES (?, 'REALENERGY', ?, '{}', 'free', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [companyId, JSON.stringify({ email }), userId]
  );
  await connection.execute(
    `INSERT INTO users (id, email, passwordHash, name, role, companyId, status, settings, createdAt, updatedAt)
     VALUES (?, ?, ?, 'Administrador', 'owner', ?, 'active', '{}', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    [userId, email, passwordHash, companyId]
  );
  await connection.execute('UPDATE app_bootstrap SET completed = 1 WHERE id = 1');
}

async function initializeDatabase() {
  const { query, transaction } = require('./db');
  const { BCRYPT_ROUNDS, JWT_SECRET } = require('./env');
  if (process.env.NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET === 'dev-secret' || JWT_SECRET.length < 32)) {
    throw new Error('Configure JWT_SECRET com pelo menos 32 caracteres em produção.');
  }
  for (const sql of schema) await query(sql);
  await transaction(connection => seedRealenergy(connection, process.env.REALENERGY_ADMIN_PASSWORD, BCRYPT_ROUNDS));
}

module.exports = { initializeDatabase, seedRealenergy };
