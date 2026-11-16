// Offline shell: the app opens instantly and works without a connection.
// Strategy: serve from cache, refresh the cache in the background. Never touches /api/.
// To force an update for everyone, bump CACHE.
const CACHE = 'ammon-family-values-v2';
const SHELL = [
  '/', '/index.html', '/style.css', '/app.js', '/model.js', '/sync.js', '/vault.js', '/store.js',
  '/lock.js', '/rotate.js', '/qr.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      e.waitUntil(network);
      return cached || network;
    }),
  );
});
