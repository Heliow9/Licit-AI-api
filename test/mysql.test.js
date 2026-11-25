const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

test('MySQL initializes, authenticates, preserves the owner and isolates CAT evidence', {
  skip: process.env.RUN_MYSQL_TEST !== '1',
}, async t => {
  assert.match(process.env.MYSQL_DATABASE || '', /^licitai_test(?:_[a-z0-9]+)?$/);
  process.env.REALENERGY_ADMIN_PASSWORD = 'test-only-password';
  const { initializeDatabase } = require('../src/Config/bootstrap');
  const { closePool, query } = require('../src/Config/db');
  const Companies = require('../src/models/companyModel');
  const Cats = require('../src/models/catModel');
  t.after(closePool);

  await initializeDatabase();
  const server = require('../src/app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function login(password) {
    return fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@realenergy.com.br', password }),
    });
  }
  const response = await login('test-only-password');
  assert.equal(response.status, 200);
  const { user, token } = await response.json();
  assert.equal(user.role, 'owner');
  const company = await Companies.findById(user.companyId);
  assert.equal(company.name, 'REALENERGY');

  process.env.REALENERGY_ADMIN_PASSWORD = 'different-password';
  await initializeDatabase();
  assert.equal((await login('test-only-password')).status, 200);
  assert.equal((await login('different-password')).status, 401);
  assert.equal((await fetch(`${url}/api/edital/analisar`, { method: 'POST' })).status, 401);

  const otherCompany = await Companies.create({ name: 'Empresa de teste' });
  const source = `teste/${otherCompany._id}.pdf`;
  const text = 'Manutenção preventiva de transformadores e componentes da rede elétrica.';
  try {
    await Cats.replace({
      companyId: user.companyId, source, fileName: 'teste.pdf', gestor: 'teste',
      fullText: text, docType: 'CAT', meta: {}, keywords: [], processedAt: new Date(),
    }, [{ text, embedding: [0.2, 0.8] }]);
    const list = await fetch(`${url}/api/cats?q=${otherCompany._id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(list.status, 200);
    const { items } = await list.json();
    assert.equal(items[0].source, source);
    const hits = await Cats.searchChunks(user.companyId, ['transformadores'], 5);
    assert.ok(hits.some(row => row.source === source));
    assert.deepEqual(await Cats.searchChunks(otherCompany._id, ['transformadores'], 5), []);
  } finally {
    await Cats.remove(user.companyId, source);
    await query('DELETE FROM companies WHERE id = ?', [otherCompany._id]);
  }
});
