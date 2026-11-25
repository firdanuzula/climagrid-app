#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createGateway } = require('./backend/gateway');
const { MasterNode } = require('./backend/master');
const { ChordRing } = require('./backend/dht');
const { JsonStore } = require('./backend/store');
const { StationAttributeIndex } = require('./backend/attribute-index');
const { RpcTransport, normalizeReading } = require('./backend/rpc');
const { EdgeCache } = require('./backend/edge-cache');
const { PrometheusMetrics } = require('./backend/metrics');
const { TraceBuffer } = require('./backend/trace');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 0;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.CLIMAGRID_TOKEN || '';
const RMI_BRIDGE_URL = process.env.CLIMAGRID_RMI_BRIDGE_URL || 'http://127.0.0.1:8765';
const STATE_FILE = process.env.CLIMAGRID_STATE_FILE || path.join(ROOT, 'data', 'backend-state.json');
const STATION_FILE = path.join(ROOT, 'data', 'stations.json');
const gateway = createGateway({ token: AUTH_TOKEN, limit: Number(process.env.CLIMAGRID_RATE_LIMIT) || 120 });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'
};

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const stationDefinitions = loadJson(STATION_FILE, []);
const stations = new Map(stationDefinitions.map(s => [s.id, s]));
const stationIndex = new StationAttributeIndex(stationDefinitions);
const edgeCache = new EdgeCache({ redisUrl: process.env.REDIS_URL || '' });
const metrics = new PrometheusMetrics();
const traces = new TraceBuffer();
const store = new JsonStore(STATE_FILE);
const readings = store.readings;
const batches = store.batches;
const jobs = store.jobs;
const jobResults = store.jobResults;
const maps = store.maps;
const alertsStore = store.alerts;
const readingUnique = store.readingUnique;
const payloadIndex = store.payloadIndex;
let duplicateCount = store.counters.duplicateCount;
let ingestedCount = store.counters.ingestedCount;

function persistState() {
  store.counters.duplicateCount = duplicateCount;
  store.counters.ingestedCount = ingestedCount;
  store.persist();
}

let dht;
dht = new ChordRing(['chord-a', 'chord-b', 'chord-c'], {
  state: store.dhtState,
  antiEntropyMs: Number(process.env.DHT_ANTI_ENTROPY_MS) || 300000,
  onChange: () => {
    store.dhtState = dht.exportState();
    persistState();
  }
});
let master;
const rpc = new RpcTransport({
  host: process.env.GRPC_HOST || '127.0.0.1',
  port: process.env.GRPC_PORT === undefined ? 8443 : Number(process.env.GRPC_PORT),
  context: {
    stations, readings, batches, payloadIndex, readingUnique, store, dht,
    jobResults, alerts: alertsStore, persist: persistState,
    incrementDuplicate: count => { duplicateCount += count; },
    incrementIngested: count => { ingestedCount += count; },
    trace: (traceId, span, attributes) => traces.record(traceId, span, attributes),
    master: null
  }
});

master = new MasterNode({
  jobs,
  persist: persistState,
  onResult: async job => {
    if (job.type === 'idw') {
      const variable = ['temp', 'rain', 'rh'].includes(job.payload.variable) ? job.payload.variable : 'temp';
      const time = Number(job.payload.time) || 0;
      const key = `map:${variable}:${time}`;
      const map = {
        ...job.result,
        variable,
        time,
        lease_seconds: 30,
        generated_at: new Date().toISOString()
      };
      maps.set(key, map);
      persistState();
      await edgeCache.set(key, map, 30000);
    }
    const payload = JSON.stringify(job.result);
    await rpc.call(rpc.clients.results, 'store', {
      job_id: job.id,
      payload_json: payload,
      payload_sha256: sha256(stableJson(job.result))
    });
  },
  heartbeatMs: Number(process.env.WORKER_HEARTBEAT_MS) || 5000
});
rpc.context.master = master;
store.prune();
const retentionTimer = setInterval(() => {
  store.prune();
  persistState();
}, Number(process.env.RETENTION_SWEEP_MS) || 3600000);
retentionTimer.unref();

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Length': Buffer.byteLength(payload),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(payload);
}
function sendError(res, status, code, message, extra = {}) {
  send(res, status, { error: { code, message, ...extra } });
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error('PAYLOAD_TOO_LARGE'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { reject(new Error('INVALID_JSON')); }
    });
  });
}
function idw(stationsList, variable, timeOffset) {
  const points = [];
  for (let y = 0; y < 56; y++) {
    for (let x = 0; x < 95; x++) {
      const lon = 110.85 + (x + 0.5) / 95 * 3.80;
      const lat = -6.65 - (y + 0.5) / 56 * 2.20;
      let num = 0, den = 0;
      const cos = Math.cos(lat * Math.PI / 180);
      for (const s of stationsList) {
        const dx = (lon - s.lon) * cos, dy = lat - s.lat;
        const d2 = dx * dx + dy * dy;
        const base = s.values && s.values[variable] !== undefined ? s.values[variable] : (s[`${variable}Base`] || 0);
        const variation = timeOffset === 0 ? 0 : (timeOffset / 6) * ((lon + lat) % 0.6);
        const w = 1 / (Math.pow(d2, 1.12) + 0.00035);
        num += (base - variation) * w; den += w;
      }
      points.push(Number((num / den).toFixed(3)));
    }
  }
  return points;
}
function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = path.normalize(clean).replace(/^([/\\])+/, '');
  const abs = path.join(ROOT, rel);
  return abs.startsWith(ROOT) ? abs : null;
}

function routeLabel(pathname) {
  return pathname
    .replace(/\/stations\/[^/]+/g, '/stations/:stationId')
    .replace(/\/analytics\/jobs\/[^/]+/g, '/analytics/jobs/:jobId');
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const started = process.hrtime.bigint();
  const route = routeLabel(pathname);
  const suppliedTraceId = req.headers['x-trace-id'];
  req.traceId = typeof suppliedTraceId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(suppliedTraceId)
    ? suppliedTraceId
    : crypto.randomUUID();
  res.setHeader('X-Trace-Id', req.traceId);
  traces.record(req.traceId, 'gateway.request', { method: req.method, route });
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.observe(req.method, route, res.statusCode, durationMs);
    traces.record(req.traceId, 'gateway.response', {
      method: req.method, route, status: res.statusCode, duration_ms: Number(durationMs.toFixed(3))
    });
  });

  if (req.method === 'GET' && pathname === '/metrics') {
    const body = metrics.render({
      ingestedCount, duplicateCount, cache: edgeCache.health(), dht: dht.health()
    });
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (!gateway.authorize(req, res, sendError)) return;

    try {
      if (req.method === 'POST' && /^\/api\/v1\/stations\/[^/]+\/readings$/.test(pathname)) {
        const stationId = decodeURIComponent(pathname.split('/')[4]);
        const body = await parseBody(req);
        const reading = normalizeReading({
          station_id: stationId,
          timestamp: body.timestamp,
          temp: body.temp,
          rh: body.rh,
          rain: body.rain,
          wind: body.wind
        });
        const batchId = req.headers['idempotency-key'] || sha256(stableJson(reading));
        const rpcResult = await rpc.call(rpc.clients.weather, 'ingestBatch', {
          batch_id: batchId,
          readings: [reading],
          checksum_crc32: 0,
          resend: true,
          payload_sha256: sha256(stableJson([reading]))
        }, 2, { 'x-trace-id': req.traceId });
        const duplicate = rpcResult.accepted === 0 && rpcResult.duplicates > 0;
        persistState();
        if (!duplicate) {
          for (const key of [...maps.keys()]) {
            if (key.startsWith('map:')) maps.delete(key);
          }
          await Promise.all([
            edgeCache.invalidatePrefix(`history:${stationId}:`),
            edgeCache.invalidatePrefix('map:'),
            edgeCache.invalidatePrefix('alerts:')
          ]);
          persistState();
        }
        return send(res, duplicate ? 200 : 201, {
          accepted: true,
          duplicate,
          station_id: stationId,
          idempotency_key: batchId,
          payload_sha256: sha256(stableJson(reading))
        });
      }

      if (req.method === 'GET' && /^\/api\/v1\/stations\/[^/]+\/readings$/.test(pathname)) {
        const stationId = decodeURIComponent(pathname.split('/')[4]);
        if (!stations.has(stationId)) return sendError(res, 404, 'STATION_NOT_FOUND', 'Station not found');
        const key = `history:${stationId}:${url.search}`;
        let body = await edgeCache.get(key);
        if (!body) {
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to');
          const result = await rpc.call(rpc.clients.weather, 'getReadings', {
            station_id: stationId,
            from: from || '',
            to: to || ''
          }, 2);
          let items = result.readings;
          if (from) items = items.filter(item => item.timestamp >= new Date(from).toISOString());
          if (to) items = items.filter(item => item.timestamp <= new Date(to).toISOString());
          body = { station_id: stationId, readings: items };
          await edgeCache.set(key, body, 30000);
        }
        const tag = gateway.etag(body);
        if (req.headers['if-none-match'] === tag) return send(res, 304, '', { ETag: tag });
        return send(res, 200, body, { ETag: tag, 'Cache-Control': 'private, max-age=30' });
      }

      const rpcReadingsMatch = pathname.match(/^\/api\/v1\/rpc\/stations\/([^/]+)\/readings$/);
      if (req.method === 'GET' && rpcReadingsMatch) {
        const stationId = decodeURIComponent(rpcReadingsMatch[1]);
        if (!stations.has(stationId)) return sendError(res, 404, 'STATION_NOT_FOUND', 'Station not found');
        const result = await rpc.call(rpc.clients.weather, 'getReadings', {
          station_id: stationId,
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || ''
        });
        return send(res, 200, { station_id: stationId, readings: result.readings }, { 'Cache-Control': 'no-store' });
      }

      const rmiReadingsMatch = pathname.match(/^\/api\/v1\/rmi\/stations\/([^/]+)\/readings$/);
      if (req.method === 'GET' && rmiReadingsMatch) {
        const stationId = decodeURIComponent(rmiReadingsMatch[1]);
        if (!stations.has(stationId)) return sendError(res, 404, 'STATION_NOT_FOUND', 'Station not found');
        try {
          const target = new URL(
            `/api/v1/stations/${encodeURIComponent(stationId)}/readings${url.search}`,
            RMI_BRIDGE_URL
          );
          const response = await fetch(target, { signal: AbortSignal.timeout(6000) });
          const body = await response.text();
          if (!response.ok) {
            return sendError(res, 502, 'RMI_CALL_FAILED', `RMI bridge returned HTTP ${response.status}`);
          }
          return send(res, 200, JSON.parse(body), { 'Cache-Control': 'no-store' });
        } catch (error) {
          return sendError(res, 503, 'RMI_UNAVAILABLE', `RMI bridge unavailable: ${error.message}`);
        }
      }

      if (req.method === 'GET' && pathname === '/api/v1/stations') {
        const list = stationIndex.query({
          provinsi: url.searchParams.get('provinsi'),
          sensor: url.searchParams.get('sensor'),
          type: url.searchParams.get('type'),
          operator: url.searchParams.get('operator'),
          status: url.searchParams.get('status'),
          q: url.searchParams.get('q')
        }).map(station => {
          const history = readings.get(station.id) || [];
          const latestReading = history.length ? history[history.length - 1] : null;
          return {
            ...station,
            latest_reading: latestReading,
            data_source: latestReading ? 'readings' : 'seed'
          };
        });
        const body = { count: list.length, stations: list };
        const tag = gateway.etag(body);
        if (req.headers['if-none-match'] === tag) return send(res, 304, '', { ETag: tag });
        return send(res, 200, body, { ETag: tag, 'Cache-Control': 'private, max-age=30' });
      }

      if (req.method === 'POST' && pathname === '/api/v1/analytics/jobs') {
        const body = await parseBody(req);
        if (!body.type || !['stats', 'idw'].includes(body.type)) return sendError(res, 400, 'INVALID_JOB', 'type must be stats or idw');
        const submitted = await rpc.call(rpc.clients.jobs, 'submitJob', {
          idempotency_key: req.headers['idempotency-key'] || '',
          type: body.type,
          variable: body.variable || '',
          time_offset: Number(body.time) || 0,
          station_id: body.station_id || ''
        });
        const job = jobs.get(submitted.job_id);
        return send(res, 202, job, { Location: `/api/v1/analytics/jobs/${submitted.job_id}` });
      }

      if (req.method === 'GET' && /^\/api\/v1\/analytics\/jobs\/[^/]+$/.test(pathname)) {
        const jobId = decodeURIComponent(pathname.split('/').pop());
        const job = jobs.get(jobId);
        if (!job) return sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
        return send(res, 200, job, { ETag: gateway.etag(job) });
      }
      if (req.method === 'DELETE' && /^\/api\/v1\/analytics\/jobs\/[^/]+$/.test(pathname)) {
        const jobId = decodeURIComponent(pathname.split('/').pop());
        if (!jobs.has(jobId)) return sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
        if (!master.cancel(jobId)) return sendError(res, 409, 'JOB_RUNNING', 'A running job cannot be cancelled');
        return send(res, 204, '');
      }

      const mapEvents = pathname.match(/^\/api\/v1\/maps\/(temp|rain|rh)\/events$/);
      if (req.method === 'GET' && mapEvents) {
        const variable = mapEvents[1];
        const time = Number(url.searchParams.get('time') || 0);
        const key = `map:${variable}:${time}`;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write(`event: lease\ndata: ${JSON.stringify({ key, lease_seconds: 30 })}\n\n`);
        const release = edgeCache.lease(key, event => {
          res.write(`event: invalidate\ndata: ${JSON.stringify(event)}\n\n`);
          release();
          res.end();
        }, 30000);
        req.on('close', release);
        return;
      }

      if (req.method === 'GET' && /^\/api\/v1\/maps\/(temp|rain|rh)$/.test(pathname)) {
        const variable = pathname.split('/').pop();
        const time = Number(url.searchParams.get('time') || 0);
        const key = `map:${variable}:${time}`;
        let body = await edgeCache.get(key);
        if (!body) {
          const persistedMap = maps.get(key);
          if (persistedMap && Date.now() - new Date(persistedMap.generated_at).getTime() < 30000) body = persistedMap;
        }
        if (!body) {
          const mapStations = [...stations.values()].map(station => {
            const history = readings.get(station.id) || [];
            const latest = history[history.length - 1];
            return {
              ...station,
              values: latest || {
                temp: station.tempBase, rain: station.rainBase,
                rh: station.rhBase, wind: station.windBase
              }
            };
          });
          const hasReadings = mapStations.some(station => readings.has(station.id) && readings.get(station.id).length > 0);
          body = {
            variable, time, width: 95, height: 56, lease_seconds: 30,
            values: idw(mapStations, variable, time),
            data_source: hasReadings ? 'readings+seed' : 'seed',
            generated_at: new Date().toISOString()
          };
          maps.set(key, body);
          persistState();
        }
        await edgeCache.set(key, body, 30000);
        const tag = gateway.etag(body);
        if (req.headers['if-none-match'] === tag) return send(res, 304, '', { ETag: tag });
        return send(res, 200, body, { ETag: tag, 'Cache-Control': 'private, max-age=30' });
      }

      if (req.method === 'GET' && pathname === '/api/v1/alerts') {
        const wilayah = url.searchParams.get('wilayah');
        const cacheKey = `alerts:${wilayah || '*'}`;
        const cachedAlerts = await edgeCache.get(cacheKey);
        if (cachedAlerts) {
          const cachedTag = gateway.etag(cachedAlerts);
          if (req.headers['if-none-match'] === cachedTag) return send(res, 304, '', { ETag: cachedTag });
          return send(res, 200, cachedAlerts, { ETag: cachedTag, 'Cache-Control': 'private, max-age=5' });
        }
        let list = [...stations.values()].filter(s => s.status === 'online');
        if (wilayah) list = list.filter(s => `${s.area} ${s.kab}`.toLowerCase().includes(wilayah.toLowerCase()));
        const generatedAt = new Date();
        const minute = generatedAt.toISOString().slice(0, 16);
        const alerts = [];
        for (const station of list) {
          const history = readings.get(station.id) || [];
          const current = history[history.length - 1] || {
            temp: station.tempBase, rh: station.rhBase,
            rain: station.rainBase, wind: station.windBase
          };
          const checks = [
            ['heat', current.temp >= 34.5, current.temp >= 35, current.temp],
            ['rain', current.rain >= 20, current.rain >= 40, current.rain],
            ['dry', current.rh <= 42, current.rh <= 35, current.rh],
            ['wind', current.wind >= 30, current.wind >= 40, current.wind]
          ];
          for (const [type, active, high, value] of checks) {
            if (!active) continue;
            const alertId = `${station.id}:${type}:${minute}`;
            const alert = {
              id: alertId,
              station_id: station.id,
              area: station.area,
              type,
              severity: high ? 'high' : 'medium',
              value,
              detected_at: generatedAt.toISOString(),
              source: history.length ? 'readings' : 'seed'
            };
            const payload = JSON.stringify(alert);
            await rpc.call(rpc.clients.alerts, 'publish', {
              alert_id: alertId,
              payload_json: payload,
              payload_sha256: sha256(stableJson(alert))
            });
            alerts.push(alert);
          }
        }
        const body = { count: alerts.length, alerts };
        alertsStore.set(cacheKey, { detected_at: generatedAt.toISOString(), ...body });
        persistState();
        await edgeCache.set(cacheKey, body, 5000);
        return send(res, 200, body, { ETag: gateway.etag(body), 'Cache-Control': 'private, max-age=5' });
      }

      if (pathname.startsWith('/api/v1/debug/dht')) {
        if (process.env.CLIMAGRID_ENABLE_DEBUG !== 'true') {
          return sendError(res, 404, 'NOT_FOUND', 'Debug endpoint is disabled');
        }
        if (req.method === 'POST' && pathname === '/api/v1/debug/dht/kv') {
          const body = await parseBody(req);
          if (typeof body.key !== 'string' || !body.key || body.value === undefined) {
            return sendError(res, 400, 'INVALID_DHT_VALUE', 'key and value are required');
          }
          const result = dht.write(body.key, body.value);
          return send(res, 200, { key: body.key, ...result });
        }
        if (req.method === 'GET' && pathname === '/api/v1/debug/dht/kv') {
          const key = url.searchParams.get('key');
          if (!key) return sendError(res, 400, 'INVALID_DHT_KEY', 'key is required');
          const result = dht.read(key);
          return send(res, 200, { key, ...result });
        }
        if (req.method === 'POST' && pathname === '/api/v1/debug/dht/anti-entropy') {
          return send(res, 200, { repaired_keys: dht.antiEntropy() });
        }
        const nodeMatch = pathname.match(/^\/api\/v1\/debug\/dht\/(chord-[abc])$/);
        if (req.method === 'POST' && nodeMatch) {
          const body = await parseBody(req);
          if (typeof body.online !== 'boolean') return sendError(res, 400, 'INVALID_NODE_STATE', 'online must be boolean');
          if (!dht.setNode(nodeMatch[1], body.online)) return sendError(res, 404, 'NODE_NOT_FOUND', 'DHT node not found');
          const node = dht.health().find(item => item.id === nodeMatch[1]);
          return send(res, 200, { node, dht: dht.health() });
        }
      }

      if (pathname.startsWith('/api/v1/debug/worker')) {
        if (process.env.CLIMAGRID_ENABLE_DEBUG !== 'true') {
          return sendError(res, 404, 'NOT_FOUND', 'Debug endpoint is disabled');
        }
        if (req.method === 'POST' && pathname === '/api/v1/debug/worker') {
          const body = await parseBody(req);
          if (typeof body.online !== 'boolean') return sendError(res, 400, 'INVALID_WORKER_STATE', 'online must be boolean');
          return send(res, 200, { master: master.setWorkerOnline(body.online) });
        }
      }

      if (req.method === 'GET' && pathname === '/api/v1/debug/traces') {
        if (process.env.CLIMAGRID_ENABLE_DEBUG !== 'true') {
          return sendError(res, 404, 'NOT_FOUND', 'Debug endpoint is disabled');
        }
        const traceId = url.searchParams.get('trace_id');
        return send(res, 200, traceId ? { trace_id: traceId, spans: traces.get(traceId) } : {
          count: traces.spans.length, spans: traces.spans.slice(-100)
        });
      }

      if (req.method === 'GET' && pathname === '/api/v1/health') {
        return send(res, 200, {
          status: 'ok', timestamp: new Date().toISOString(), stations: stations.size,
          ingested_readings: ingestedCount, duplicate_readings: duplicateCount,
          dht: dht.health(),
          master: master.health(),
          rpc: { transport: 'grpc', host: rpc.host, port: rpc.port, deadline_ms: 2000 },
          cache: edgeCache.health(),
          tracing: { adapter: 'in-memory', spans_buffered: traces.spans.length },
          storage: { adapter: 'json', persistent: true, hourly_aggregates: store.hourlyAggregates.size }
        });
      }
      return sendError(res, 404, 'NOT_FOUND', 'API endpoint not found');
    } catch (err) {
      if (err.message === 'PAYLOAD_TOO_LARGE') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload exceeds 1 MB');
      if (err.message === 'INVALID_JSON') return sendError(res, 400, 'INVALID_JSON', 'Request body must be valid JSON');
      if (err.code === 3) return sendError(res, 400, 'INVALID_ARGUMENT', err.message);
      if (err.code === 5) return sendError(res, 404, 'NOT_FOUND', err.message);
      if (err.code === 6) return sendError(res, 409, 'CONFLICT', err.message);
      if (err.code === 4) return sendError(res, 504, 'DEADLINE_EXCEEDED', err.message);
      if (err.code === 14) return sendError(res, 503, 'RPC_UNAVAILABLE', err.message);
      console.error(err);
      return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } }, { Allow: 'GET, HEAD' });
  }
  let file = safePath(pathname === '/' ? '/index.html' : pathname);
  if (!file) return send(res, 400, { error: { code: 'BAD_REQUEST', message: 'Bad Request' } });
  fs.stat(file, (err, stat) => {
    if (!err && stat.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (readErr, data) => {
      if (readErr) {
        if (!path.extname(file)) return fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
          if (e2) return sendError(res, 404, 'NOT_FOUND', 'Not found');
          send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        });
        return sendError(res, 404, 'NOT_FOUND', 'Not found');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length,
        'Cache-Control': ['.html', '.json', '.webmanifest'].includes(ext) ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
        'Service-Worker-Allowed': '/', 'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') return res.end();
      res.end(data);
    });
  });
}

const server = http.createServer(handleRequest);
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} sedang dipakai. Gunakan PORT=5000 node server.js`);
  else console.error(err);
  process.exit(1);
});
function listenHttp() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      const nets = os.networkInterfaces();
      const lan = [];
      Object.values(nets).flat().forEach(net => {
        if (net && net.family === 'IPv4' && !net.internal) lan.push(net.address);
      });
      console.log(`ClimaGrid API/PWA siap di http://localhost:${PORT}`);
      console.log(`gRPC internal aktif di ${rpc.host}:${rpc.port}`);
      lan.forEach(ip => console.log(`Jaringan: http://${ip}:${PORT}`));
      resolve();
    });
  });
}

function listenHttps() {
  if (!HTTPS_PORT) return Promise.resolve();
  let credentials;
  if (process.env.HTTPS_PFX) {
    credentials = {
      pfx: fs.readFileSync(process.env.HTTPS_PFX),
      passphrase: process.env.HTTPS_PFX_PASSWORD || ''
    };
  } else if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
    credentials = {
      key: fs.readFileSync(process.env.HTTPS_KEY),
      cert: fs.readFileSync(process.env.HTTPS_CERT)
    };
  } else {
    throw new Error('HTTPS_PORT requires HTTPS_PFX or both HTTPS_KEY and HTTPS_CERT');
  }
  const tlsServer = https.createServer(credentials, handleRequest);
  tlsServer.on('error', error => {
    console.error('HTTPS server error:', error);
    process.exit(1);
  });
  return new Promise((resolve, reject) => {
    tlsServer.once('error', reject);
    tlsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`ClimaGrid HTTPS siap di https://localhost:${HTTPS_PORT}`);
      resolve();
    });
  });
}

rpc.start().then(() => Promise.all([listenHttp(), listenHttps()])).catch(error => {
  console.error('Gagal memulai server:', error);
  process.exit(1);
});
