const CACHE_NAME = 'state-cv-cache-v14';
const CACHE_PREFIX = 'state-cv-cache-';
const PRECACHE_URLS = [
  './index.html',
  './styles.css',
  './storage.js',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdf.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(
    PRECACHE_URLS.map(async (url) => {
      const request = new Request(url, { cache: 'reload' });
      const response = await fetch(request);
      if (!response.ok || response.type !== 'basic' || new URL(response.url).origin !== self.location.origin) {
        throw new Error(`State CV could not precache ${url}.`);
      }
      await cache.put(request, response);
    })
  )));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type === 'GET_VERSION') {
    if (event.ports[0]) event.ports[0].postMessage(CACHE_NAME);
    else if (event.source) event.source.postMessage(CACHE_NAME);
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const precachedAsset = PRECACHE_URLS.find((path) => new URL(path, self.location).pathname === url.pathname);

  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE_NAME).then((cache) =>
      cache.match(new URL('./index.html', self.location).href)
    ).then((cached) => cached || fetch(request)));
    return;
  }

  if (precachedAsset) {
    const cacheUrl = new URL(precachedAsset, self.location).href;
    event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(cacheUrl).then((cached) =>
      cached || fetch(request).then((response) => {
        if (!response.ok || response.type !== 'basic' ||
            new URL(response.url).origin !== self.location.origin) return response;
        return cache.put(cacheUrl, response.clone()).then(() => response);
      })
    )));
  }
});
