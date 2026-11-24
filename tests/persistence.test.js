'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climagrid-persist-'));
const stateFile = path.join(stateDir, 'state.json');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: route,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startServer(port) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), GRPC_PORT: '0', HOST: '127.0.0.1', CLIMAGRID_STATE_FILE: stateFile },
    stdio: 'ignore'
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${child.exitCode}`);
    try {
      const health = await request(port, 'GET', '/api/v1/health');
      if (health.status === 200) return child;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error('Backend did not start');
}

function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
}

(async () => {
  const port = await freePort();
  let server = await startServer(port);
  const now = new Date().toISOString();
  const key = `persist-${Date.now()}`;
  const reading = { timestamp: now, temp: 29.5, rh: 71, rain: 0.4, wind: 8 };

  const inserted = await request(port, 'POST', '/api/v1/stations/SBY-01/readings', reading, { 'Idempotency-Key': key });
  assert.strictEqual(inserted.status, 201);
  const sameObservation = await request(port, 'POST', '/api/v1/stations/SBY-01/readings', reading, { 'Idempotency-Key': `${key}-retry` });
  assert.strictEqual(sameObservation.status, 200);
  assert.strictEqual(sameObservation.body.duplicate, true);
  const conflict = await request(port, 'POST', '/api/v1/stations/SBY-01/readings', { ...reading, temp: 29.6 }, { 'Idempotency-Key': `${key}-conflict` });
  assert.strictEqual(conflict.status, 409);

  const job = await request(port, 'POST', '/api/v1/analytics/jobs', { type: 'stats', station_id: 'SBY-01' }, { 'Idempotency-Key': `${key}-job` });
  assert.strictEqual(job.status, 202);
  let completedJob;
  for (let attempt = 0; attempt < 100; attempt++) {
    completedJob = await request(port, 'GET', `/api/v1/analytics/jobs/${job.body.id}`);
    if (completedJob.body.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.strictEqual(completedJob.body.status, 'completed');
  await stopServer(server);

  server = await startServer(port);
  const history = await request(port, 'GET', '/api/v1/stations/SBY-01/readings');
  assert.strictEqual(history.status, 200);
  assert.ok(history.body.readings.some(item => item.timestamp === now));
  const jobAfterRestart = await request(port, 'GET', `/api/v1/analytics/jobs/${job.body.id}`);
  assert.strictEqual(jobAfterRestart.status, 200);
  assert.strictEqual(jobAfterRestart.body.status, 'completed');
  const health = await request(port, 'GET', '/api/v1/health');
  assert.ok(health.body.storage.hourly_aggregates > 0);

  await stopServer(server);
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('Persistence and restart tests passed');
})().catch(error => {
  console.error(error);
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(1);
});
