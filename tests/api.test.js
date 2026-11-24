'use strict';

const assert = require('assert');
const http = require('http');

const base = process.env.CLIMAGRID_TEST_URL || 'http://localhost:4173';

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

(async () => {
  const stations = await request('GET', '/api/v1/stations');
  assert.strictEqual(stations.status, 200);
  assert.strictEqual(stations.body.count, 20);

  const health = await request('GET', '/api/v1/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.dht.length, 3);

  const reading = {
    timestamp: '2026-11-24T03:00:00Z',
    temp: 30.5, rh: 70, rain: 1.2, wind: 12
  };
  const first = await request('POST', '/api/v1/stations/SBY-01/readings', reading, { 'Idempotency-Key': 'test-batch-1' });
  assert.ok(first.status === 201 || (first.status === 200 && first.body.duplicate === true));
  const duplicate = await request('POST', '/api/v1/stations/SBY-01/readings', reading, { 'Idempotency-Key': 'test-batch-1' });
  assert.strictEqual(duplicate.status, 200);
  assert.strictEqual(duplicate.body.duplicate, true);

  const history = await request('GET', '/api/v1/stations/SBY-01/readings');
  assert.strictEqual(history.status, 200);
  assert.ok(history.body.readings.length >= 1);

  const job = await request('POST', '/api/v1/analytics/jobs', { type: 'idw', variable: 'temp', time: 0 }, { 'Idempotency-Key': 'test-job-1' });
  assert.strictEqual(job.status, 202);
  const jobStatus = await request('GET', job.body.id ? `/api/v1/analytics/jobs/${job.body.id}` : '/api/v1/analytics/jobs/missing');
  assert.strictEqual(jobStatus.status, 200);

  const map = await request('GET', '/api/v1/maps/temp?time=0');
  assert.strictEqual(map.status, 200);
  assert.strictEqual(map.body.width, 95);

  console.log('API tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
