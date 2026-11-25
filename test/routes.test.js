const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/Config/env');
const { completeJob, createJob } = require('../src/jobs/progress');

test('document routes require the company that owns the request or job', async t => {
  const server = require('../src/app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = companyId => ({
    Authorization: `Bearer ${jwt.sign({ sub: 'user', companyId }, JWT_SECRET)}`,
  });
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/edital/analisar`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/api/pastas`, { headers: headers(null) })).status, 400);
  const job = createJob({ companyId: 'other-company' });
  completeJob(job.id, {});
  const response = await fetch(`${url}/api/cats/sync-events/${job.id}`, { headers: headers('company') });
  await response.body?.cancel();
  assert.equal(response.status, 403);
});
