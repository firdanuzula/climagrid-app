'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climagrid-observability-'));
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
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: route,
      headers: { 'Content-Type': 'application/json', ...headers }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: raw && res.headers['content-type'].includes('application/json') ? JSON.parse(raw) : raw
      }));
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

(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), GRPC_PORT: '0', HOST: '127.0.0.1',
      CLIMAGRID_STATE_FILE: stateFile, CLIMAGRID_ENABLE_DEBUG: 'true'
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

    const traceId = 'trace-observability-test';
    const reading = {
      timestamp: new Date().toISOString(), temp: 28, rh: 72, rain: 0.1, wind: 5
    };
    const ingested = await request(port, 'POST', '/api/v1/stations/SBY-01/readings', reading, {
      'Idempotency-Key': 'observability-reading',
      'X-Trace-Id': traceId
    });
    assert.strictEqual(ingested.status, 201);
    assert.strictEqual(ingested.headers['x-trace-id'], traceId);

    const trace = await request(port, 'GET', `/api/v1/debug/traces?trace_id=${traceId}`);
    const spans = trace.body.spans.map(item => item.span);
    assert.ok(spans.includes('gateway.request'));
    assert.ok(spans.includes('ingest.batch'));
    assert.ok(spans.includes('dht.write'));
    assert.ok(spans.includes('gateway.response'));

    const metrics = await request(port, 'GET', '/metrics');
    assert.strictEqual(metrics.status, 200);
    assert.ok(metrics.body.includes('climagrid_ingest_readings_total{result="accepted"} 1'));
    assert.ok(metrics.body.includes('climagrid_cache_requests_total{result="miss"}'));
    assert.ok(metrics.body.includes('climagrid_dht_node_up{id="chord-a"} 1'));
    console.log('Prometheus metrics and gateway-ingest-DHT trace tests passed');
  } finally {
    await stop(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
