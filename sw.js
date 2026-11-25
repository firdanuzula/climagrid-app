/* ClimaGrid service worker — app shell offline-first */
'use strict';

const VERSION = 'climagrid-v1.0.8';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './data.js',
  './map-data.js',
  './app.js',
  './manifest.webmanifest',
  './assets/fonts/Inter-400.ttf',
  './assets/fonts/Inter-600.ttf',
  './assets/fonts/Inter-700.ttf',
  './assets/fonts/Inter-800.ttf',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Cache each asset individually so one failure cannot break installation.
    await Promise.all(SHELL_ASSETS.map(async url => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res);
      } catch (_) { /* ignore missing asset */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SHELL && k !== RUNTIME)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(RUNTIME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        const cached = await caches.match('./index.html');
        return cached || new Response(
          '<!doctype html><meta charset="utf-8"><title>ClimaGrid offline</title>' +
          '<body style="font-family:system-ui;padding:40px;background:#F3F6F5;color:#0B2530">' +
          '<h1>ClimaGrid</h1><p>Halaman belum tersimpan di perangkat. Sambungkan internet lalu muat ulang.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(RUNTIME);
        cache.put(req, res.clone());
      }
      return res;
    } catch (_) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
