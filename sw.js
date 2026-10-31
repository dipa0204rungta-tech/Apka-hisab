// Offline support. Network first, so the shop always gets the latest version
// when online; the cached copy is used when there is no connection.
const CACHE = 'apka-hisab-v3';
const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/billing.css',
  'assets/js/billing/app.js',
  'assets/js/billing/bill.js',
  'assets/js/billing/escpos.js',
  'assets/js/billing/numbers.js',
  'assets/js/billing/printers.js',
  'assets/js/billing/receipt.js',
  'assets/js/billing/receipt-image.js',
  'assets/js/billing/speech.js',
  'assets/js/billing/storage.js',
  'assets/js/billing/voice-parser.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
