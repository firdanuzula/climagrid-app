#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.CLIMAGRID_TOKEN || '';
const STATE_FILE = path.join(ROOT, 'data', 'backend-state.json');
const STATION_FILE = path.join(ROOT, 'data', 'stations.json');

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
const persisted = loadJson(STATE_FILE, {});
const readings = new Map(Object.entries(persisted.readings || {}));
const batches = new Map(Object.entries(persisted.batches || {}));
const jobs = new Map(Object.entries(persisted.jobs || {}));
let duplicateCount = Number(persisted.duplicateCount || 0);
let ingestedCount = Number(persisted.ingestedCount || 0);

function persistState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    readings: Object.fromEntries(readings), batches: Object.fromEntries(batches),
    jobs: Object.fromEntries(jobs), duplicateCount, ingestedCount
  }, null, 2));
}

const DHT_NODES = ['chord-a', 'chord-b', 'chord-c'].map(id => ({
  id, key: Number.parseInt(sha256(id).slice(0, 8), 16), replicas: new Map()
}));

function dhtWrite(key, value) {
  const hash = Number.parseInt(sha256(key).slice(0, 8), 16);
  const ordered = [...DHT_NODES].sort((a, b) => a.key - b.key);
  let start = ordered.findIndex(n => n.key >= hash);
  if (start < 0) start = 0;
  for (let i = 0; i < 3; i++) {
    const node = ordered[(start + i) % ordered.length];
    node.replicas.set(key, { value, checksum: sha256(value) });
  }
  return ordered.map(n => n.id);
}

class LruCache {
  constructor(limit = 128) { this.limit = limit; this.items = new Map(); }
  get(key) {
    if (!this.items.has(key)) return undefined;
    const value = this.items.get(key);
    this.items.delete(key); this.items.set(key, value);
    return value;
  }
  put(key, value) {
    this.items.delete(key); this.items.set(key, value);
    if (this.items.size > this.limit) this.items.delete(this.items.keys().next().value);
  }
  clear() { this.items.clear(); }
  size() { return this.items.size; }
}
const mapCache = new LruCache(64);
const historyCache = new LruCache(128);
const rateBuckets = new Map();

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
function etag(payload) { return `"${sha256(stableJson(payload)).slice(0, 24)}"`; }

function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = path.normalize(clean).replace(/^([/\\])+/, '');
  const abs = path.join(ROOT, rel);
  return abs.startsWith(ROOT) ? abs : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = rateBuckets.get(ip) || { start: now, count: 0 };
    if (now - bucket.start >= 60000) { bucket.start = now; bucket.count = 0; }
    bucket.count++; rateBuckets.set(ip, bucket);
    res.setHeader('X-RateLimit-Limit', '120');
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, 120 - bucket.count)));
    if (bucket.count > 120) return sendError(res, 429, 'RATE_LIMITED', 'Too many requests');

    if (AUTH_TOKEN) {
      if ((req.headers.authorization || '') !== `Bearer ${AUTH_TOKEN}`) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Bearer token required');
      }
    }

    try {
      if (req.method === 'POST' && /^\/api\/v1\/stations\/[^/]+\/readings$/.test(pathname)) {
        const stationId = decodeURIComponent(pathname.split('/')[4]);
        if (!stations.has(stationId)) return sendError(res, 404, 'STATION_NOT_FOUND', 'Station not found');
        const body = await parseBody(req);
        if (!['timestamp', 'temp', 'rh', 'rain', 'wind'].every(k => body[k] !== undefined && body[k] !== null)) {
          return sendError(res, 400, 'INVALID_READING', 'timestamp, temp, rh, rain, and wind are required');
        }
        const timestamp = new Date(body.timestamp);
        if (Number.isNaN(timestamp.getTime())) return sendError(res, 400, 'INVALID_TIMESTAMP', 'timestamp must be ISO 8601');
        const payloadHash = sha256(stableJson({
          stationId, timestamp: timestamp.toISOString(), temp: body.temp, rh: body.rh, rain: body.rain, wind: body.wind
        }));
        const duplicateKey = req.headers['idempotency-key'] || payloadHash;
        if (batches.has(duplicateKey)) {
          duplicateCount++; persistState();
          return send(res, 200, { accepted: true, duplicate: true, station_id: stationId, idempotency_key: duplicateKey });
        }
        const reading = {
          station_id: stationId, timestamp: timestamp.toISOString(), temp: body.temp, rh: body.rh,
          rain: body.rain, wind: body.wind, payload_sha256: payloadHash
        };
        const list = readings.get(stationId) || [];
        list.push(reading); readings.set(stationId, list); batches.set(duplicateKey, reading);
        ingestedCount++; dhtWrite(`reading:${stationId}:${timestamp.toISOString()}`, reading); persistState();
        return send(res, 201, {
          accepted: true, duplicate: false, station_id: stationId,
          idempotency_key: duplicateKey, payload_sha256: payloadHash
        });
      }

      if (req.method === 'GET' && /^\/api\/v1\/stations\/[^/]+\/readings$/.test(pathname)) {
        const stationId = decodeURIComponent(pathname.split('/')[4]);
        if (!stations.has(stationId)) return sendError(res, 404, 'STATION_NOT_FOUND', 'Station not found');
        const key = `history:${stationId}:${url.search}`;
        let body = historyCache.get(key);
        if (!body) {
          body = { station_id: stationId, readings: readings.get(stationId) || [] };
          historyCache.put(key, body);
        }
        const tag = etag(body);
        if (req.headers['if-none-match'] === tag) return send(res, 304, '', { ETag: tag });
        return send(res, 200, body, { ETag: tag, 'Cache-Control': 'private, max-age=30' });
      }

      if (req.method === 'GET' && pathname === '/api/v1/stations') {
        const provinsi = url.searchParams.get('provinsi');
        const sensor = url.searchParams.get('sensor');
        let list = [...stations.values()];
        if (provinsi) list = list.filter(s => `${s.kab} ${s.area}`.toLowerCase().includes(provinsi.toLowerCase()));
        if (sensor) list = list.filter(s => s.sensors.toLowerCase().includes(sensor.toLowerCase()));
        const body = { count: list.length, stations: list };
        const tag = etag(body);
        if (req.headers['if-none-match'] === tag) return send(res, 304, '', { ETag: tag });
        return send(res, 200, body, { ETag: tag, 'Cache-Control': 'private, max-age=30' });
      }

      if (req.method === 'POST' && pathname === '/api/v1/analytics/jobs') {
        const body = await parseBody(req);
        if (!body.type || !['stats', 'idw'].includes(body.type)) return sendError(res, 400, 'INVALID_JOB', 'type must be stats or idw');
        const key = req.headers['idempotency-key'];
        if (key && jobs.has(key)) return send(res, 202, jobs.get(key));
        const jobId = crypto.randomUUID();
        const job = { id: jobId, type: body.type, status: 'queued', created_at: new Date().toISOString(), progress: 0, result: null };
        jobs.set(jobId, job); if (key) jobs.set(key, job); persistState();
        setTimeout(() => {
          const current = jobs.get(jobId);
          if (!current) return;
          current.status = 'completed'; current.progress = 100;
          current.result = body.type === 'idw'
            ? { width: 95, height: 56, values_sha256: sha256(idw([...stations.values()], body.variable || 'temp', body.time || 0)) }
            : { average: 30.1, minimum: 24.8, maximum: 33.4, moving_average: 30.0 };
          persistState();
        }, 250);
        return send(res, 202, job, { Location: `/api/v1/analytics/jobs/${jobId}` });
      }

      if (req.method === 'GET' && /^\/api\/v1\/analytics\/jobs\/[^/]+$/.test(pathname)) {
        const jobId = decodeURIComponent(pathname.split('/').pop());
        const job = jobs.get(jobId);
        if (!job) return sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
        return send(res, 200, job, { ETag: etag(job) });
      }
      if (req.method === 'DELETE' && /^\/api\/v1\/analytics\/jobs\/[^/]+$/.test(pathname)) {
        const jobId = decodeURIComponent(pathname.split('/').pop());
        if (!jobs.has(jobId)) return sendError(res, 404, 'JOB_NOT_FOUND', 'Job not found');
        jobs.delete(jobId); persistState();
        return send(res, 204, '');
      }

      if (req.method === 'GET' && /^\/api\/v1\/maps\/(temp|rain|rh)$/.test(pathname)) {
        const variable = pathname.split('/').pop();
        const time = Number(url.searchParams.get('time') || 0);
        const key = `map:${variable}:${time}`;
        let body = mapCache.get(key);
        if (!body) {
          body = { variable, time, width: 95, height: 56, lease_seconds: 30, values: idw([...stations.values()], variable, time), generated_at: new Date().toISOString() };
          mapCache.put(key, body);
        }
        const tag = etag(body);
        if (req.headers['if-none-match'] === tag) return send(res, 304, '', { ETag: tag });
        return send(res, 200, body, { ETag: tag, 'Cache-Control': 'private, max-age=30' });
      }

      if (req.method === 'GET' && pathname === '/api/v1/alerts') {
        const wilayah = url.searchParams.get('wilayah');
        let list = [...stations.values()].filter(s => s.status === 'online');
        if (wilayah) list = list.filter(s => `${s.area} ${s.kab}`.toLowerCase().includes(wilayah.toLowerCase()));
        const alerts = list.map(s => ({
          station_id: s.id, area: s.area,
          severity: s.rainBase >= 40 || s.windBase >= 40 || s.tempBase >= 35 ? 'high' : 'medium',
          type: s.rainBase >= 40 ? 'rain' : s.windBase >= 40 ? 'wind' : s.tempBase >= 35 ? 'heat' : 'info',
          value: s.rainBase >= 40 ? s.rainBase : s.windBase >= 40 ? s.windBase : s.tempBase
        })).filter(a => a.type !== 'info');
        const body = { count: alerts.length, alerts };
        return send(res, 200, body, { ETag: etag(body), 'Cache-Control': 'private, max-age=5' });
      }

      if (req.method === 'GET' && pathname === '/api/v1/health') {
        return send(res, 200, {
          status: 'ok', timestamp: new Date().toISOString(), stations: stations.size,
          ingested_readings: ingestedCount, duplicate_readings: duplicateCount,
          dht: DHT_NODES.map(n => ({ id: n.id, replicas: n.replicas.size })),
          cache: { map_entries: mapCache.size(), history_entries: historyCache.size() }
        });
      }
      return sendError(res, 404, 'NOT_FOUND', 'API endpoint not found');
    } catch (err) {
      if (err.message === 'PAYLOAD_TOO_LARGE') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload exceeds 1 MB');
      if (err.message === 'INVALID_JSON') return sendError(res, 400, 'INVALID_JSON', 'Request body must be valid JSON');
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
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} sedang dipakai. Gunakan PORT=5000 node server.js`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  Object.values(nets).flat().forEach(net => {
    if (net && net.family === 'IPv4' && !net.internal) lan.push(net.address);
  });
  console.log(`ClimaGrid API/PWA siap di http://localhost:${PORT}`);
  lan.forEach(ip => console.log(`Jaringan: http://${ip}:${PORT}`));
});
