// Хранилище. Единственное место, которое знает про IndexedDB.
// Всё остальное приложение работает через эти функции, поэтому подменить
// хранилище (на сервер, на CloudKit) можно не трогая остальной код.

const DB_NAME = 'sargsyan-baby';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        db.createObjectStore('entries', { keyPath: 'date' });
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
 * Запись одного дня.
 * @typedef {Object} Entry
 * @property {string} date    'YYYY-MM-DD' — ключ
 * @property {Blob}   photo   мастер-кадр (jpeg)
 * @property {Blob}   thumb   квадратная миниатюра для календаря
 * @property {number} w       ширина мастер-кадра
 * @property {number} h       высота мастер-кадра
 * @property {string} comment комментарий дня
 * @property {?{lx:number,ly:number,rx:number,ry:number}} eyes
 *           координаты глаз в долях от размера кадра (0..1), null если не размечено
 * @property {number} createdAt
 * @property {number} updatedAt
 */

export const entries = {
  get(date) {
    return run('entries', 'readonly', s => s.get(date));
  },

  put(entry) {
    entry.updatedAt = Date.now();
    if (!entry.createdAt) entry.createdAt = entry.updatedAt;
    return run('entries', 'readwrite', s => s.put(entry));
  },

  delete(date) {
    return run('entries', 'readwrite', s => s.delete(date));
  },

  /** Все даты, по возрастанию (ключи — ISO-строки, лексикографический порядок = хронологический). */
  allDates() {
    return run('entries', 'readonly', s => s.getAllKeys());
  },

  /** Записи за период включительно. */
  range(fromDate, toDate) {
    return run('entries', 'readonly', s =>
      s.getAll(IDBKeyRange.bound(fromDate, toDate)));
  },

  count() {
    return run('entries', 'readonly', s => s.count());
  },
};

const DEFAULT_SETTINGS = {
  babyName: '',
  birthDate: null,      // 'YYYY-MM-DD' — день рождения (может быть в будущем: пролог)
  dueDate: null,        // 'YYYY-MM-DD' — ПДР, чтобы считать недели беременности
  masterMaxDim: 2560,   // до какого размера ужимается фото при импорте
  masterQuality: 0.92,
  eyeTarget: { lx: 0.375, ly: 0.42, rx: 0.625, ry: 0.42 },
  videoSize: 1080,
  videoFps: 8,
  lockHash: null,       // PBKDF2 от кода блокировки, null = без блокировки
  lockSalt: null,
  lastExportAt: null,
  reminderHour: 20,

  // Google Диск
  onboardingDone: false,
  driveFolderId: null,     // id папки приложения
  profileFileId: null,     // id config.json в этой папке
  settingsUpdatedAt: 0,    // когда здесь последний раз меняли общие настройки
  driveFolderName: 'Каждый день',
  driveEmail: null,        // чей аккаунт подключён
  lastSyncAt: null,
  autoSync: true,          // синхронизировать сразу после съёмки
};

// Настройки, которые едут в config.json на Диске и общие для всех, кто снимает
// одного ребёнка. Их правка помечается временем — по нему синхронизация решает,
// чья версия свежее. Всё остальное (токены, id папки) остаётся на устройстве.
const PROFILE_KEYS = new Set([
  'babyName', 'birthDate', 'dueDate', 'eyeTarget',
  'videoSize', 'videoFps', 'masterMaxDim', 'masterQuality', 'reminderHour',
]);

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

  async set(key, value) {
    await run('settings', 'readwrite', s => s.put({ key, value }));
    if (PROFILE_KEYS.has(key)) await this.touchProfile();
  },

  async merge(patch) {
    for (const [key, value] of Object.entries(patch)) {
      await this.set(key, value);
    }
  },

  /** Отметить, что общие настройки поменялись здесь и сейчас. */
  touchProfile(at = Date.now()) {
    return run('settings', 'readwrite', s =>
      s.put({ key: 'settingsUpdatedAt', value: at }));
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
