// Офлайновая оболочка.
//
// Стратегия «сеть вперёд»: свежие файлы приезжают сами, кэш нужен только когда
// сети нет. Из этого следует важное — обычная загрузка страницы онлайн уже
// перекачивает всю оболочку целиком, потому что браузер запрашивает и разметку,
// и стили, и каждый модуль. Отдельная «проверка обновлений» ничего бы не
// добавила, кроме лишних запросов, поэтому её здесь нет.
//
// Поэтому же нет и номера версии, который надо помнить и поднимать руками:
// предзагрузка ниже нужна ровно один раз, чтобы приложение заработало офлайн
// сразу после первого визита, — дальше кэш освежается сам.

const CACHE = 'shell';

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
  './src/store.js',
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

// Адреса оболочки в разрешённом виде. Кэшируем только их: иначе каждый заход с
// новым параметром в адресе («?reset», ссылки с метками) плодил бы отдельную
// запись, и хранилище росло бы без предела.
const ALLOWED = new Set(SHELL.map(p => new URL(p, self.location).href));

/** Адрес без параметров и якоря — по нему и решаем, наш ли это файл. */
function shellKey(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

const isShell = url => ALLOWED.has(shellKey(url));

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))     // всё или ничего: смеси версий не будет
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Чужие хранилища и файлы, выбывшие из оболочки, не должны занимать место
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) {
      if (!isShell(req.url)) await cache.delete(req);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // чужое не трогаем вовсе

  e.respondWith((async () => {
    try {
      const res = await fetch(req);

      // В кэш кладём только своё, целое и успешное. Ошибки, редиректы и
      // непрозрачные ответы туда попадать не должны: иначе один сбой сети
      // закрепится и будет отдаваться офлайн вместо рабочего файла.
      if (isShell(req.url) && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(shellKey(req.url), copy));
      }
      return res;
    } catch (offline) {
      const hit = await caches.match(shellKey(req.url));
      if (hit) return hit;

      // Запасной вариант только для перехода по адресу. Отдавать разметку в
      // ответ на запрос модуля нельзя: скрипт сломается непонятной ошибкой
      // вместо честного «сети нет».
      if (req.mode === 'navigate') {
        const shell = await caches.match(new URL('./index.html', self.location).href);
        if (shell) return shell;
      }
      throw offline;
    }
  })());
});
