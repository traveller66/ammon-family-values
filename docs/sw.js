// Offline shell: after the first visit the whole app is on the phone and opens with no connection.
// Strategy: serve from the phone's copy, and refresh that copy in the background when a connection happens to be there.
// The only thing ever fetched is the app's own files. Budget data is never sent or fetched.
// To force an update, bump CACHE.
const CACHE = 'ammon-family-values-v6';
const SHELL = [
  './', './index.html', './style.css', './app.js', './model.js', './local.js', './vault.js', './store.js',
  './lock.js', './share.js', './games.js', './puzzles.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
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
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
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
