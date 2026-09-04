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
//
// Единственное исключение — bench, верстак сборки. Собрать год значит держать
// год кадров одновременно, а это сотни мегабайт: в памяти вкладки телефон их
// не выносит. Поэтому на время сборки кадры ложатся на диск — и стираются,
// как только человек ушёл с экрана видео, и ещё раз при запуске, если прошлый
// заход убили посреди сборки. Верстак не кэш: в нём никогда ничего не ищут,
// чтобы «не качать повторно завтра».

export const DB_NAME = 'timelapse-baby';
// 3 — версия, в которой хранилище снимков на диске удалено насовсем.
// 4 — добавлен верстак сборки: временный и самостирающийся.
// 5 — на верстаке появился отпечаток кадра и индекс по нему: считать, сколько
//     кадров уже готово, надо уметь не поднимая сами кадры в память.
const DB_VERSION = 5;

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
      // Верстак — самое выбрасываемое, что есть в базе: он и так вытирается
      // при каждом запуске. Поэтому пересоздаём, а не переносим.
      if (event.oldVersion < 5 && db.objectStoreNames.contains('bench')) {
        db.deleteObjectStore('bench');
      }
      if (!db.objectStoreNames.contains('bench')) {
        db.createObjectStore('bench', { keyPath: 'date' })
          .createIndex('stamp', 'stamp');
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
 * @property {string} stamp    чем собран выровненный кадр — размер и композиция
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

/**
 * Верстак сборки: выровненные кадры и ничего кроме них.
 *
 * Единственное место, где снимок ложится на диск устройства, и единственное,
 * где это оправдано: год выровненных кадров — это семьдесят мегабайт, которые
 * вкладка не удержит в памяти, а собрать видео иначе нельзя. Мастер-кадр сюда
 * не попадает никогда: он вшестеро тяжелее, а в кадр не идёт.
 *
 * Живёт запись ровно столько, сколько человек стоит на экране видео. Ушёл —
 * clearBench(), и от собранного года на телефоне не остаётся ничего.
 *
 * @typedef {Object} Bench
 * @property {string} date
 * @property {Blob} aligned
 * @property {string} stamp  чем собрано — размер кадра и композиция: поменяли
 *                           любое из двух, и запись негодна, а видно это без
 *                           пересчёта
 */

export const bench = {
  get(date) {
    return run('bench', 'readonly', s => s.get(date));
  },

  put(row) {
    return run('bench', 'readwrite', s => s.put(row));
  },

  delete(date) {
    return run('bench', 'readwrite', s => s.delete(date));
  },

  clear() {
    return run('bench', 'readwrite', s => s.clear());
  },

  allDates() {
    return run('bench', 'readonly', s => s.getAllKeys());
  },

  /**
   * Дни, чей кадр собран этим же отпечатком, — одними датами, без самих
   * кадров. Разница не косметическая: `get` на каждый день года поднял бы в
   * память все триста шестьдесят пять кадров только ради того, чтобы их
   * пересчитать.
   */
  datesWithStamp(stamp) {
    return run('bench', 'readonly', s => s.index('stamp').getAllKeys(stamp));
  },

  count() {
    return run('bench', 'readonly', s => s.count());
  },
};

/** Выбросить весь кэш: и карточки, и тела, и верстак. */
export async function clearCache() {
  await bench.clear();
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
  videoCaption: false,  // выжигать ли «День 47» в кадр при сборке
  lastExportAt: null,
  // Два кусочка кадра вокруг глаз последнего размеченного дня: по ним
  // разметка следующего уточняется сама. Кэш и ничего кроме: пропал — завтра
  // точки просто встанут как вчера, без уточнения. В папку не уходит: это
  // пиксели конкретного снимка, а не настройка.
  eyePatch: null,

  // Google Диск
  onboardingDone: false,
  // Дом — одна папка на человека, внутри неё все альбомы и общий config.json.
  homeFolderId: null,
  homeFolderName: 'Timelapse',
  baseFileId: null,        // id общего config.json в доме
  // Альбом — папка одного ребёнка: тот, кого снимают прямо сейчас. Всё
  // остальное приложение отсчитывает от неё и про дом не знает.
  driveFolderId: null,     // id папки активного альбома
  cacheFolderId: null,     // из какой папки собран кэш — см. store.refresh
  profileFileId: null,     // id config.json в этом альбоме
  driveFolderName: '',
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

