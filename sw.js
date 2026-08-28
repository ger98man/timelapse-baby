// Оболочка кэшируется целиком, поэтому приложение открывается без сети.
// Версию менять при каждом обновлении файлов.
const VERSION = 'v7';
const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './styles.css',
  './manifest.webmanifest',
  './config.js',
  './src/app.js',
  './src/google.js',
  './src/drive.js',
  './src/sync.js',
  './src/picker.js',
  './src/onboarding.js',
  './src/profile.js',
  './src/db.js',
  './src/dates.js',
  './src/img.js',
  './src/align.js',
  './src/video.js',
  './src/zip.js',
  './src/archive.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сеть вперёд, кэш как запасной аэродром: свежий код приезжает сам,
// но офлайн приложение всё равно открывается.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
