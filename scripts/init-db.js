const { initializeDatabase } = require('../src/Config/bootstrap');
const { closePool } = require('../src/Config/db');

initializeDatabase()
  .then(() => console.log('Esquema e inicialização da REALENERGY verificados.'))
  .catch(error => {
    console.error('[db:init]', error.code || error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
