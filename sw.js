const CACHE_NAME = 'state-cv-cache-v3';
const CACHE_PREFIX = 'state-cv-cache-';
const PRECACHE_URLS = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/jspdf.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

// Only a successful, same-origin response may be stored. Error pages and redirects must never replace the cached app.
function isCacheable(response) {
  return response.ok && response.type === 'basic' && !response.redirected;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isPrecachedAsset = PRECACHE_URLS.some((path) => new URL(path, self.location).pathname === url.pathname);

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (isCacheable(response)) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
      }
      return response;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  if (isPrecachedAsset) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
