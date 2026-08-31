// Хранилище. Единственное место, которое знает про IndexedDB.
// Всё остальное приложение работает через эти функции, поэтому подменить
// хранилище (на сервер, на CloudKit) можно не трогая остальной код.
//
// Фотографий на телефоне не остаётся ни одной — это осознанное решение:
//
//   entries — лёгкая опись дня: чьи файлы в папке, разметка глаз и
//             комментарий. Байты, не мегабайты. Живёт в IndexedDB.
//   blobs   — сами снимки. Живут в памяти вкладки и умирают вместе с ней:
//             ни мастер-кадр, ни выровненный кадр, ни миниатюра на диск
//             устройства не попадают.
//
// Поэтому календарь показывает галочки, а не миниатюры, а любой показ снимка
// начинается с загрузки из папки. Платой за это стал трафик, взамен — на
// телефоне нет ни одной фотографии, которую можно было бы забыть стереть.

export const DB_NAME = 'timelapse-baby';
// 3 — версия, в которой хранилище снимков на диске удалено насовсем.
const DB_VERSION = 3;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const db = req.result;
      // Кэш выбрасываемый, поэтому при смене раскладки его проще стереть, чем
      // переносить: индекс вернётся из папки одним запросом. Настройки живут
      // отдельно и переживают любую такую чистку.
      // Опись выбрасываем при каждой смене раскладки: она возвращается из
      // папки одним запросом. В версии 3 это ещё и способ стереть миниатюры,
      // которые прошлые версии успели положить в карточки дней.
      if (event.oldVersion < 3 && db.objectStoreNames.contains('entries')) {
        db.deleteObjectStore('entries');
      }
      if (!db.objectStoreNames.contains('entries')) {
        db.createObjectStore('entries', { keyPath: 'date' });
      }
      // Снимки больше не хранятся на устройстве. Старое хранилище сносим —
      // вместе со всем, что успело в него лечь на прошлых версиях.
      if (db.objectStoreNames.contains('blobs')) {
        db.deleteObjectStore('blobs');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const maybe = fn(store);
    if (maybe && typeof maybe.then === 'function') {
      // не используем — транзакции IndexedDB не переживают await
      reject(new Error('fn must be synchronous'));
      return;
    }
    if (maybe) {
      maybe.onsuccess = () => { result = maybe.result; };
      maybe.onerror = () => reject(maybe.error);
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/**
 * Карточка дня — лёгкий уровень кэша. Своей правды не хранит: всё здесь копия
 * того, что лежит в папке на Диске, и может быть стёрто и перекачано без
 * потерь.
 *
 * @typedef {Object} Entry
 * @property {string} date          'YYYY-MM-DD' — ключ
 * @property {string} fileId        id снимка в папке
 * @property {string} modifiedTime  время правки снимка в папке — по нему видно,
 *                                  что в файле что-то менялось
 * @property {?string} md5           контрольная сумма снимка: по ней видно,
 *                                  сменилось ли само изображение, а не только
 *                                  разметка в его метаданных
 * @property {?string} noteId       id файла с комментарием, если он есть
 * @property {?string} noteModified время правки комментария
 * @property {boolean} noteStale    комментарий в папке новее нашей копии
 * @property {number} w
 * @property {number} h
 * @property {string} comment
 * @property {?{lx:number,ly:number,rx:number,ry:number}} eyes
 *           координаты глаз в долях от размера снимка (0..1)
 */

export const entries = {
  get(date) {
    return run('entries', 'readonly', s => s.get(date));
  },

  put(entry) {
    return run('entries', 'readwrite', s => s.put(entry));
  },

  /** Выбросить кэш целиком: он всегда пересобирается из папки. */
  clear() {
    return run('entries', 'readwrite', s => s.clear());
  },

  delete(date) {
    return run('entries', 'readwrite', s => s.delete(date));
  },

  /** Все даты, по возрастанию (ключи — ISO-строки, лексикографический порядок = хронологический). */
  allDates() {
    return run('entries', 'readonly', s => s.getAllKeys());
  },

  /** Карточки за период включительно. Тел здесь нет — только миниатюры. */
  range(fromDate, toDate) {
    return run('entries', 'readonly', s =>
      s.getAll(IDBKeyRange.bound(fromDate, toDate)));
  },

  count() {
    return run('entries', 'readonly', s => s.count());
  },
};

/**
 * Снимки — только в памяти. Ни IndexedDB, ни Cache Storage: закрыли вкладку
 * (или позвали blobs.clear()) — и на телефоне не осталось ничего.
 *
 * Интерфейс намеренно асинхронный, как у остальных хранилищ: так вызывающий
 * код не знает, где именно лежат данные, и переезд обратно ничего не сломает.
 *
 * @typedef {Object} Body
 * @property {string} date
 * @property {Blob} photo      мастер-кадр (jpeg)
 * @property {Blob} aligned    выровненный кадр для видео
 */
const memory = new Map();

export const blobs = {
  get(date) {
    return Promise.resolve(memory.get(date));
  },

  put(body) {
    memory.set(body.date, body);
    return Promise.resolve();
  },

  delete(date) {
    memory.delete(date);
    return Promise.resolve();
  },

  clear() {
    memory.clear();
    return Promise.resolve();
  },

  /** Какие дни уже загружены в память. */
  allDates() {
    return Promise.resolve([...memory.keys()]);
  },

  count() {
    return Promise.resolve(memory.size);
  },
};

/** Выбросить весь кэш: и карточки, и тела. */
export async function clearCache() {
  await entries.clear();
  await blobs.clear();
}

const DEFAULT_SETTINGS = {
  babyName: '',
  birthDate: null,      // 'YYYY-MM-DD' — день рождения (может быть в будущем: пролог)
  dueDate: null,        // 'YYYY-MM-DD' — ПДР, чтобы считать недели беременности
  theme: 'girl',        // 'girl' | 'boy' — тёмного оформления больше нет
  masterMaxDim: 2560,   // до какого размера ужимается фото при импорте
  masterQuality: 0.92,
  eyeTarget: { lx: 0.375, ly: 0.42, rx: 0.625, ry: 0.42 },
  videoSize: 1080,
  videoFps: 8,
  lastExportAt: null,
  reminderHour: 20,

  // Google Диск
  onboardingDone: false,
  driveFolderId: null,     // id папки приложения
  profileFileId: null,     // id config.json в этой папке
  driveFolderName: 'TimelapseBaby',
  driveEmail: null,        // чей аккаунт подключён
  lastSyncAt: null,
  autoSync: true,          // синхронизировать сразу после съёмки
};

export const settings = {
  async all() {
    const rows = await run('settings', 'readonly', s => s.getAll());
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) out[row.key] = row.value;
    return out;
  },

  async get(key) {
    const row = await run('settings', 'readonly', s => s.get(key));
    return row ? row.value : DEFAULT_SETTINGS[key];
  },

  set(key, value) {
    return run('settings', 'readwrite', s => s.put({ key, value }));
  },

  async merge(patch) {
    for (const [key, value] of Object.entries(patch)) {
      await this.set(key, value);
    }
  },
};

/** Просим браузер не вытирать данные при нехватке места. */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage: usage || 0, quota: quota || 0 };
}
