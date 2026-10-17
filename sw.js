// Service worker: makes the app installable and keeps working with a flaky
// connection (e.g. in the métro). Network first, so updates show up right away;
// cached copy when offline. Map tiles are left to the browser cache.
const CACHE = 'jlc-v4';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'config/game-config.js',
  'js/geometry.js',
  'js/app.js',
  'data/montreal-island.geojson',
  'data/montreal-transit.geojson',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/@turf/turf@7.1.0/turf.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isApp = url.origin === self.location.origin || url.hostname === 'unpkg.com';
  if (!isApp) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
