const CACHE_NAME = 'state-cv-cache-v1';
const PRECACHE_URLS = [
  './index.html',
  './styles.css',
  './app.js',
  './vendor/pdf.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const isPrecachedAsset = PRECACHE_URLS.some((path) => new URL(path, self.location).pathname === url.pathname);

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  if (isPrecachedAsset || url.pathname.includes('/vendor/')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
