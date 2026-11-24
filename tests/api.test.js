'use strict';

const assert = require('assert');
const http = require('http');

const base = process.env.CLIMAGRID_TEST_URL || 'http://localhost:4173';

function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data ? (res.headers['content-type'].includes('application/json') ? JSON.parse(data) : data) : null
      }));
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
  const filteredStations = await request('GET', '/api/v1/stations?provinsi=Jawa%20Timur&sensor=Hujan&type=pesisir&operator=BMKG');
  assert.ok(filteredStations.body.count > 0);
  assert.ok(filteredStations.body.stations.every(station => station.type === 'pesisir' && station.operator.includes('BMKG')));
  const searchedStations = await request('GET', '/api/v1/stations?q=Sukolilo');
  assert.strictEqual(searchedStations.body.count, 1);
  assert.strictEqual(searchedStations.body.stations[0].id, 'SBY-01');

  const health = await request('GET', '/api/v1/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.dht.length, 3);

  const reading = {
    timestamp: new Date().toISOString(),
    temp: 30.5, rh: 70, rain: 1.2, wind: 12
  };
  const batchKey = `test-batch-${Date.now()}`;
  const first = await request('POST', '/api/v1/stations/SBY-01/readings', reading, { 'Idempotency-Key': batchKey });
  assert.ok(first.status === 201 || (first.status === 200 && first.body.duplicate === true));
  const duplicate = await request('POST', '/api/v1/stations/SBY-01/readings', reading, { 'Idempotency-Key': batchKey });
  assert.strictEqual(duplicate.status, 200);
  assert.strictEqual(duplicate.body.duplicate, true);

  const history = await request('GET', '/api/v1/stations/SBY-01/readings');
  assert.strictEqual(history.status, 200);
  assert.ok(history.body.readings.length >= 1);
  assert.strictEqual(history.body.readings[history.body.readings.length - 1].station_id, 'SBY-01');

  const jobKey = `test-job-${Date.now()}`;
  const job = await request('POST', '/api/v1/analytics/jobs', { type: 'stats', station_id: 'SBY-01' }, { 'Idempotency-Key': jobKey });
  assert.strictEqual(job.status, 202);
  let jobStatus;
  for (let attempt = 0; attempt < 30; attempt++) {
    jobStatus = await request('GET', `/api/v1/analytics/jobs/${job.body.id}`);
    if (jobStatus.body.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.strictEqual(jobStatus.status, 200);
  assert.strictEqual(jobStatus.body.status, 'completed');
  assert.ok(jobStatus.body.result.execution_engine);
  assert.strictEqual(jobStatus.body.result.serial_matches, true);
  const deletedJob = await request('DELETE', `/api/v1/analytics/jobs/${job.body.id}`);
  assert.strictEqual(deletedJob.status, 204);

  const map = await request('GET', '/api/v1/maps/temp?time=0');
  assert.strictEqual(map.status, 200);
  assert.strictEqual(map.body.width, 95);
  assert.ok(map.body.data_source.includes('readings'));
  const cachedMap = await request('GET', '/api/v1/maps/temp?time=0', undefined, { 'If-None-Match': map.headers.etag });
  assert.strictEqual(cachedMap.status, 304);

  const updatedReading = await request('POST', '/api/v1/stations/SBY-01/readings', {
    ...reading, timestamp: new Date(Date.now() + 1000).toISOString(), temp: 37
  }, { 'Idempotency-Key': `${batchKey}-update` });
  assert.strictEqual(updatedReading.status, 201);
  const updatedHistory = await request('GET', '/api/v1/stations/SBY-01/readings');
  assert.ok(updatedHistory.body.readings.length >= 2);
  const updatedMap = await request('GET', '/api/v1/maps/temp?time=0');
  assert.notStrictEqual(updatedMap.headers.etag, map.headers.etag);

  const alerts = await request('GET', '/api/v1/alerts');
  assert.strictEqual(alerts.status, 200);
  assert.strictEqual(alerts.body.count, alerts.body.alerts.length);
  assert.ok(alerts.body.alerts.every(alert => ['heat', 'rain', 'dry', 'wind'].includes(alert.type)));

  const metrics = await request('GET', '/metrics');
  assert.strictEqual(metrics.status, 200);
  assert.ok(metrics.body.includes('# TYPE climagrid_http_request_duration_ms histogram'));
  assert.ok(metrics.body.includes('climagrid_dht_node_up{id="chord-a"} 1'));

  console.log('API tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
