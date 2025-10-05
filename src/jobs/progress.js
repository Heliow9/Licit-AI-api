// server/jobs/progress.js
const { EventEmitter } = require('events');
const crypto = require('crypto');

const jobs = new Map(); // { id: { status, pct, phase, logs[], startedAt, finishedAt, result, error } }
const bus  = new EventEmitter();

function newId() { return crypto.randomBytes(12).toString('hex'); }

function createJob(meta = {}) {
  const id = newId();
  const job = {
    id,
    status: 'running', // running | done | error
    pct: 0,
    phase: 'Inicializando',
    logs: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
    meta
  };
  jobs.set(id, job);
  return job;
}

function updateJob(id, patch = {}) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  if (patch.log) job.logs.push(patch.log);
  bus.emit(`job:${id}`, { type: 'update', job });
}

function completeJob(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  job.result = result;
  job.pct = 100;
  bus.emit(`job:${id}`, { type: 'done', job });
}

function failJob(id, error) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'error';
  job.finishedAt = new Date().toISOString();
  job.error = typeof error === 'string' ? error : (error?.message || 'Erro');
  bus.emit(`job:${id}`, { type: 'error', job });
}

function getJob(id) { return jobs.get(id) || null; }

/** SSE subscription */
function sseSubscribe(req, res, id) {
  const job = getJob(id);
  if (!job) {
    res.status(404).end();
    return;
  }
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const push = (evt) => {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify({
      id: job.id,
      status: job.status,
      pct: job.pct,
      phase: job.phase,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // não mandamos result completo em todo update pra não pesar; cliente busca no /result
    })}\n\n`);
  };

  // manda um snapshot inicial
  push({ type: 'snapshot' });

  const onUpdate = (evt) => push(evt);
  bus.on(`job:${id}`, onUpdate);

  req.on('close', () => {
    bus.off(`job:${id}`, onUpdate);
    try { res.end(); } catch {}
  });
}

module.exports = {
  createJob, updateJob, completeJob, failJob, getJob, sseSubscribe
};
