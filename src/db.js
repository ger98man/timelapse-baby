// Хранилище. Единственное место, которое знает про IndexedDB.
// Всё остальное приложение работает через эти функции, поэтому подменить
// хранилище (на сервер, на CloudKit) можно не трогая остальной код.
//
// Кэш разложен на два уровня, и это главное решение файла:
//
//   entries — лёгкая карточка дня: чьи файлы в папке, разметка глаз,
//             комментарий и квадратная миниатюра. Десятки килобайт.
//   blobs   — тяжёлое тело дня: мастер-кадр и выровненный кадр. Сотни.
//
// Календарю нужен только первый уровень, поэтому листать месяцы можно, не
// разбудив ни одного мегабайта: показывать нечего дороже миниатюры.

export const DB_NAME = 'timelapse-baby';
const DB_VERSION = 2;

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
      if (event.oldVersion < 2 && db.objectStoreNames.contains('entries')) {
        db.deleteObjectStore('entries');
      }
      if (!db.objectStoreNames.contains('entries')) {
        db.createObjectStore('entries', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'date' });
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
 * @property {?string} thumbLink    короткоживущая ссылка на миниатюру Диска
 * @property {?Blob}  thumb         квадратная миниатюра для календаря (~15 КБ)
 * @property {?string} thumbFrom    'drive' — из миниатюры Диска, 'master' — своя
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
 * Тело дня — тяжёлый уровень кэша: мастер-кадр и выровненный кадр.
 * Нужно только тому, кто смотрит сам снимок или собирает видео, поэтому
 * качается по требованию и в любой момент может быть выброшено.
 *
 * @typedef {Object} Body
 * @property {string} date
 * @property {Blob} photo      мастер-кадр (jpeg)
 * @property {Blob} aligned    выровненный кадр для видео
 */

export const blobs = {
  get(date) {
    return run('blobs', 'readonly', s => s.get(date));
  },

  put(body) {
    return run('blobs', 'readwrite', s => s.put(body));
  },

  delete(date) {
    return run('blobs', 'readwrite', s => s.delete(date));
  },

  clear() {
    return run('blobs', 'readwrite', s => s.clear());
  },

  /** Какие дни уже лежат тут целиком — по ключам, не поднимая сами блобы. */
  allDates() {
    return run('blobs', 'readonly', s => s.getAllKeys());
  },

  count() {
    return run('blobs', 'readonly', s => s.count());
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
  theme: 'default',     // оформление: 'default' | 'girl' | 'boy'
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
