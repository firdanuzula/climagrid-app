'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { StationAttributeIndex } = require('../backend/attribute-index');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climagrid-load-'));
const stateFile = path.join(tempDir, 'state.json');

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
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: route,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let responseBody = raw;
        if (raw && res.headers['content-type'].includes('application/json')) responseBody = JSON.parse(raw);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: responseBody,
          duration: performance.now() - started
        });
      });
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function stop(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
}

function percentiles(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const at = percentile => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
  return { p50: at(0.50), p95: at(0.95) };
}

function report(name, samples, targetMs) {
  const { p50, p95 } = percentiles(samples);
  console.log(`${name}: n=${samples.length}, p50=${p50.toFixed(2)} ms, p95=${p95.toFixed(2)} ms, target p95 < ${targetMs} ms: ${p95 < targetMs ? 'PASS' : 'OVER TARGET'}`);
}

async function waitForJob(port, jobId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(port, 'GET', `/api/v1/analytics/jobs/${jobId}`);
    if (response.body.status === 'completed') return response.body;
    if (response.body.status === 'failed') throw new Error(`Job failed: ${response.body.error}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} did not complete`);
}

(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), GRPC_PORT: '0', HOST: '127.0.0.1',
      CLIMAGRID_STATE_FILE: stateFile, CLIMAGRID_ENABLE_DEBUG: 'true',
      CLIMAGRID_RATE_LIMIT: '500'
    },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw new Error(`Backend exited: ${child.exitCode}`);
      try {
        if ((await request(port, 'GET', '/api/v1/health')).status === 200) {
          ready = true;
          break;
        }
      } catch (_) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(ready, 'backend did not start');

    const ingestSamples = [];
    const readingStamps = [];
    for (let index = 0; index < 20; index++) {
      const timestamp = new Date(Date.now() + index).toISOString();
      readingStamps.push(timestamp);
      const response = await request(port, 'POST', '/api/v1/stations/SBY-01/readings', {
        timestamp, temp: 25 + index / 100, rh: 70, rain: 0.1, wind: 5
      }, { 'Idempotency-Key': `load-reading-${index}` });
      assert.strictEqual(response.status, 201);
      ingestSamples.push(response.duration);
    }
    report('Ingest API', ingestSamples, 250);

    assert.strictEqual((await request(port, 'GET', '/api/v1/maps/temp?time=0')).status, 200);
    const mapSamples = [];
    for (let index = 0; index < 30; index++) {
      const response = await request(port, 'GET', '/api/v1/maps/temp?time=0');
      assert.strictEqual(response.status, 200);
      mapSamples.push(response.duration);
    }
    report('Map API (warm cache)', mapSamples, 100);

    const submitSamples = [];
    const jobIds = [];
    const jobsProcessedBeforeLoad = (await request(port, 'GET', '/api/v1/health')).body.master.jobs_processed;
    for (let index = 0; index < 10; index++) {
      const response = await request(port, 'POST', '/api/v1/analytics/jobs', {
        type: 'stats', station_id: 'SBY-01'
      }, { 'Idempotency-Key': `load-job-${index}` });
      assert.strictEqual(response.status, 202);
      jobIds.push(response.body.id);
      submitSamples.push(response.duration);
    }
    report('Submit job API', submitSamples, 150);
    let jobsFinished = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const health = await request(port, 'GET', '/api/v1/health');
      if (health.body.master.jobs_processed >= jobsProcessedBeforeLoad + jobIds.length) {
        jobsFinished = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(jobsFinished, 'load-test jobs did not finish');

    const lookupRoute = `/api/v1/debug/dht/kv?key=${encodeURIComponent(`reading:SBY-01:${readingStamps[0]}`)}`;
    const lookupSamples = [];
    for (let index = 0; index < 20; index++) {
      const response = await request(port, 'GET', lookupRoute);
      assert.strictEqual(response.status, 200);
      lookupSamples.push(response.duration);
    }
    report('Chord lookup API', lookupSamples, 50);

    const offline = await request(port, 'POST', '/api/v1/debug/dht/chord-a', { online: false });
    assert.strictEqual(offline.status, 200);
    const failoverReading = {
      timestamp: new Date(Date.now() + 5000).toISOString(),
      temp: 26, rh: 70, rain: 0, wind: 4
    };
    const firstWrite = await request(port, 'POST', '/api/v1/stations/SBY-02/readings', failoverReading, {
      'Idempotency-Key': 'failover-reading-once'
    });
    const retry = await request(port, 'POST', '/api/v1/stations/SBY-02/readings', failoverReading, {
      'Idempotency-Key': 'failover-reading-once'
    });
    assert.strictEqual(firstWrite.status, 201);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body.duplicate, true);
    const history = await request(port, 'GET', '/api/v1/stations/SBY-02/readings');
    assert.strictEqual(history.body.readings.filter(item => item.timestamp === failoverReading.timestamp).length, 1);
    assert.strictEqual((await request(port, 'POST', '/api/v1/debug/dht/chord-a', { online: true })).status, 200);

    const workerOffline = await request(port, 'POST', '/api/v1/debug/worker', { online: false });
    assert.strictEqual(workerOffline.body.master.worker_online, false);
    const before = workerOffline.body.master.jobs_processed;
    const queued = await request(port, 'POST', '/api/v1/analytics/jobs', {
      type: 'stats', station_id: 'SBY-02'
    }, { 'Idempotency-Key': 'worker-failover-once' });
    assert.strictEqual(queued.body.status, 'queued');
    await new Promise(resolve => setTimeout(resolve, 150));
    const stillQueued = await request(port, 'GET', `/api/v1/analytics/jobs/${queued.body.id}`);
    assert.strictEqual(stillQueued.body.status, 'queued');
    assert.strictEqual((await request(port, 'POST', '/api/v1/debug/worker', { online: true })).status, 200);
    const completed = await waitForJob(port, queued.body.id);
    assert.strictEqual(completed.status, 'completed');
    const duplicateJob = await request(port, 'POST', '/api/v1/analytics/jobs', {
      type: 'stats', station_id: 'SBY-02'
    }, { 'Idempotency-Key': 'worker-failover-once' });
    assert.strictEqual(duplicateJob.body.id, queued.body.id);
    const after = await request(port, 'GET', '/api/v1/health');
    assert.strictEqual(after.body.master.jobs_processed, before + 1);

    const simulated = Array.from({ length: 5000 }, (_, index) => ({
      id: `SIM-${String(index + 1).padStart(5, '0')}`,
      name: `Simulated station ${index + 1}`,
      area: `Synthetic area ${index % 100}`,
      kab: `Synthetic district ${index % 50}`,
      provinsi: 'Jawa Timur',
      sensors: index % 2 ? 'Suhu · Hujan' : 'Suhu · RH',
      type: index % 3 ? 'pesisir' : 'dataran',
      operator: index % 2 ? 'BMKG Sintetis' : 'ClimaGrid Simulasi'
    }));
    const generatedAt = performance.now();
    const index = new StationAttributeIndex(simulated);
    const matched = index.query({ provinsi: 'Jawa Timur', sensor: 'Hujan', type: 'pesisir' });
    const syntheticMs = performance.now() - generatedAt;
    assert.strictEqual(simulated.length, 5000);
    assert.ok(matched.length > 0);
    console.log(`Synthetic station index: ${simulated.length} generated; ${matched.length} matched; build+query=${syntheticMs.toFixed(2)} ms (synthetic only)`);
    console.log('DHT/worker failover and duplicate-execution checks passed');
  } finally {
    await stop(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
