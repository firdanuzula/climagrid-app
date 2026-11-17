#!/usr/bin/env node
/* ClimaGrid static server — zero dependencies.
 * Serve the PWA over HTTP so the service worker and install prompt work.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function safePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = path.normalize(clean).replace(/^([/\\])+/, '');
  const abs = path.join(ROOT, rel);
  return abs.startsWith(ROOT) ? abs : null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  let file = safePath(req.url === '/' ? '/index.html' : req.url);
  if (!file) return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });

  fs.stat(file, (err, stat) => {
    if (!err && stat.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (readErr, data) => {
      if (readErr) {
        // SPA fallback for unknown extension-less routes
        if (!path.extname(file)) {
          return fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
            if (e2) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
            send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          });
        }
        return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      }

      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const isServiceWorker = path.basename(file) === 'sw.js';
      const isHtml = ext === '.html';
      const isManifest = ext === '.webmanifest';
      const cacheControl = isServiceWorker || isHtml || isManifest
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=3600';

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Cache-Control': cacheControl,
        'Service-Worker-Allowed': '/',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.method === 'HEAD') return res.end();
      res.end(data);
    });
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} sedang dipakai. Jalankan dengan port lain:\n    set PORT=5000 && node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  Object.values(nets).flat().forEach(net => {
    if (net && net.family === 'IPv4' && !net.internal) lan.push(net.address);
  });
  console.log('\n  ClimaGrid siap dijalankan\n');
  console.log(`  Lokal   : http://localhost:${PORT}`);
  lan.forEach(ip => console.log(`  Jaringan: http://${ip}:${PORT}`));
  console.log('\n  Buka di Chrome/Edge. Untuk memasang app, gunakan menu browser');
  console.log('  atau tombol "Pasang app" di bagian kanan atas.\n');
  console.log('  Tekan Ctrl+C untuk berhenti.\n');
});
