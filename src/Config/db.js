const mysql = require('mysql2/promise');
require('./env');

let pool;

function getPool() {
  if (!pool) {
    const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;
    if (!MYSQL_USER || !MYSQL_PASSWORD || !MYSQL_DATABASE) {
      throw new Error('Configure MYSQL_USER, MYSQL_PASSWORD e MYSQL_DATABASE.');
    }
    const port = Number(MYSQL_PORT || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MYSQL_PORT inválida.');
    pool = mysql.createPool({
      host: MYSQL_HOST || '127.0.0.1',
      port,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      charset: 'utf8mb4',
      timezone: 'Z',
      jsonStrings: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

async function query(sql, params = [], connection = getPool()) {
  const [result] = await connection.execute(sql, params);
  return result;
}

async function transaction(run) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await run(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function closePool() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = { query, transaction, closePool };
