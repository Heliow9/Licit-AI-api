const { PORT } = require('./Config/env');
const { initializeDatabase } = require('./Config/bootstrap');
const { closePool } = require('./Config/db');

async function start() {
  await initializeDatabase();
  const app = require('./app');
  const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`API rodando na porta ${PORT}`);
  });
  server.once('error', fail);
}

async function fail(error) {
  console.error('[boot]', error.code || error.message);
  try {
    await closePool();
  } finally {
    process.exitCode = 1;
  }
}

start().catch(fail);
