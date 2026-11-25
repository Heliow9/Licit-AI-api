const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

test('first boot seeds a hashed owner and later boots preserve it', async () => {
  const seed = require('../src/Config/bootstrap').seedRealenergy;
  const users = [];
  let initialized = false;
  const conn = {
    async execute(sql, params = []) {
      if (sql.startsWith('SELECT completed')) return [[{ completed: initialized }]];
      if (sql.startsWith('SELECT id FROM users')) return [users];
      if (sql.startsWith('INSERT INTO users')) users.push(params);
      if (sql.startsWith('UPDATE app_bootstrap')) initialized = true;
      return [[]];
    },
  };
  await seed(conn, 'test-password', 4);
  await seed(conn, 'different-password', 4);
  assert.equal(users.length, 1);
  const [, email, hash] = users[0];
  assert.equal(email, 'admin@realenergy.com.br');
  assert.equal(await bcrypt.compare('test-password', hash), true);
  assert.equal(await bcrypt.compare('different-password', hash), false);
});

test('initial seed requires a password', async () => {
  const seed = require('../src/Config/bootstrap').seedRealenergy;
  const conn = {
    async execute(sql) {
      if (sql.startsWith('SELECT completed')) return [[{ completed: false }]];
      return [[]];
    },
  };
  await assert.rejects(seed(conn, '', 4), /REALENERGY_ADMIN_PASSWORD/);
});
