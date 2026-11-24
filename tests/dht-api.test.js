'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climagrid-dht-'));
const stateFile = path.join(tempDir, 'state.json');

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: route,
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function getPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitReady(child, port) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`Backend exited: ${child.exitCode}`);
    try {
      if ((await request(port, 'GET', '/api/v1/health')).status === 200) return;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Backend did not start');
}

function stop(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
}

(async () => {
  const port = await getPort();
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), GRPC_PORT: '0', HOST: '127.0.0.1', CLIMAGRID_STATE_FILE: stateFile, CLIMAGRID_ENABLE_DEBUG: 'true' },
    stdio: 'ignore'
  });
  try {
    await waitReady(child, port);
    const off = await request(port, 'POST', '/api/v1/debug/dht/chord-a', { online: false });
    assert.strictEqual(off.status, 200);
    const written = await request(port, 'POST', '/api/v1/debug/dht/kv', { key: 'failover-check', value: { ok: true } });
    assert.strictEqual(written.status, 200);
    assert.strictEqual(written.body.acknowledgements, 2);
    const read = await request(port, 'GET', '/api/v1/debug/dht/kv?key=failover-check');
    assert.deepStrictEqual(read.body.value, { ok: true });
    const online = await request(port, 'POST', '/api/v1/debug/dht/chord-a', { online: true });
    assert.strictEqual(online.status, 200);
    assert.strictEqual(online.body.node.hinted_handoff, 0);
    const entropy = await request(port, 'POST', '/api/v1/debug/dht/anti-entropy', {});
    assert.strictEqual(entropy.status, 200);
    console.log('DHT endpoint failover test passed');
  } finally {
    await stop(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
