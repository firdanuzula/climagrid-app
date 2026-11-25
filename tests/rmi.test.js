'use strict';

const assert = require('assert');
const http = require('http');

const base = process.env.CLIMAGRID_TEST_URL || 'http://localhost:4173';

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(base + pathname, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (error) { return reject(error); }
        resolve({ status: response.statusCode, body: parsed });
      });
    }).on('error', reject);
  });
}

(async () => {
  const query = '?from=2000-01-01T00%3A00%3A00.000Z&to=2099-12-31T23%3A59%3A59.000Z';
  const [rest, rpc, rmi] = await Promise.all([
    get(`/api/v1/stations/SBY-01/readings${query}`),
    get(`/api/v1/rpc/stations/SBY-01/readings${query}`),
    get(`/api/v1/rmi/stations/SBY-01/readings${query}`)
  ]);
  for (const response of [rest, rpc, rmi]) assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(rpc.body, rest.body);
  assert.deepStrictEqual(rmi.body, rest.body);

  const missing = await get('/api/v1/rmi/stations/UNKNOWN/readings');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error.code, 'STATION_NOT_FOUND');

  console.log('RMI bridge and REST/RPC/RMI reading parity tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
