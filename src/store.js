// Единственное место, которое меняет содержимое альбома.
//
// Правда живёт в папке на Диске, а локальная база — выбрасываемый кэш: копия
// для быстрого показа календаря и сборки видео. Из этого следует всё
// остальное. Любая правка сначала уходит в папку и только потом попадает в
// кэш; если Диск не ответил, не меняется ничего и нигде. Не сошлось — кэш
// можно стереть целиком, потерять нечего.
//
// Поэтому здесь нет ни очереди отложенных изменений, ни разрешения конфликтов,
// ни вопроса «чья версия новее». Спорить не с чем: Диск всегда прав.
//
// Кэш наполняется в два приёма, и это второе важное решение файла.
// Обновление тянет только опись папки — id, время правки, разметку глаз, — а
// это один запрос на всю историю и ноль мегабайт. Снимки качаются позже и
// поштучно: когда открыли день, когда собирают таймлапс. Календарю хватает
// миниатюр, которые Google уже сделал сам, — килобайты вместо мегабайт.

import { entries, blobs, settings } from './db.js';
import { toMaster } from './img.js';
import { deriveFrom } from './align.js';
import { TAG } from './drive.js';
import { pullProfile } from './profile.js';

const ts = iso => (iso ? Date.parse(iso) : 0);

/**
 * Ссылки на миниатюры для предпросмотра: живут пару часов, лежат только в
 * памяти. На телефоне не остаётся ни самих миниатюр, ни ссылок на них.
 */
const previewCache = new Map();

// Разметка глаз принадлежит снимку, поэтому едет в его же метаданных
export function eyesToProp(eyes) {
  return eyes ? [eyes.lx, eyes.ly, eyes.rx, eyes.ry].map(n => n.toFixed(5)).join(',') : '';
}

export function eyesFromProp(str) {
  if (!str) return null;
  const n = String(str).split(',').map(Number);
  if (n.length !== 4 || n.some(Number.isNaN)) return null;
  return { lx: n[0], ly: n[1], rx: n[2], ry: n[3] };
}

function sameEyes(a, b) {
  if (!a || !b) return !a === !b;
  return ['lx', 'ly', 'rx', 'ry'].every(k => Math.abs(a[k] - b[k]) < 1e-6);
}

/** Файлы папки → карта «день → снимок и комментарий». */
function indexRemote(files) {
  const byDay = new Map();
  for (const f of files) {
    const p = f.appProperties || {};
    if (!p.day) continue;
    const slot = byDay.get(p.day) || {};
    if (p.kind === 'note') {
      slot.note = f;
    } else if (p.kind === 'photo' || !p.kind) {
      // если снимков за день вдруг несколько, берём последний по времени
      if (!slot.photo || ts(f.modifiedTime) > ts(slot.photo.modifiedTime)) slot.photo = f;
    }
    byDay.set(p.day, slot);
  }
  return byDay;
}

/**
 * Папку нашли и запомнили — всё остальное отсчитывается от неё.
 *
 * Не нашли — это ошибка, а не повод завести новую. Папка исчезает из виду,
 * когда её удалили или отозвали доступ; в обоих случаях молча созданный
 * пустой альбом рядом со старым — худшее, что можно сделать. Заводит папку
 * только мастер и только по явному «я первый родитель».
 */
export async function ensureFolder(drive) {
  const cfg = await settings.all();
  const root = await drive.findRoot(cfg.driveFolderId);
  if (!root) {
    // Помечаем код: приложение по нему спросит, первый родитель пришёл или
    // второй, и заведёт либо подключит папку само.
    const e = new Error('Папка альбома не найдена в Google Диске');
    e.code = 'no-folder';
    throw e;
  }
  const name = await drive.nameRoot(root, cfg.driveEmail);
  const patch = {};
  if (root.id !== cfg.driveFolderId) patch.driveFolderId = root.id;
  if (name !== cfg.driveFolderName) patch.driveFolderName = name;
  if (Object.keys(patch).length) await settings.merge(patch);
  return root.id;
}

/**
 * Подтягивает опись папки в кэш. Единственное направление: Диск → телефон.
 * Обратного нет, потому что правки уходят в папку сразу, а не копятся.
 *
 * Снимки здесь не качаются. Обновление стоит одного запроса независимо от
 * того, сколько лет уже снято, и потому его не страшно делать при каждом
 * запуске и на мобильном интернете.
 */
export async function refresh(drive, { onProgress = () => {} } = {}) {
  onProgress(0, 1, 'Ищу папку');
  const rootId = await ensureFolder(drive);

  onProgress(0, 1, 'Смотрю, что в папке');
  const files = await drive.listDayFiles();
  await pullProfile(drive, files);

  const cfg = await settings.all();      // настройки могли приехать из папки
  const remote = indexRemote(files);

  // Чего в папке нет — того нет и у нас. Кэш не хранит ничего своего.
  let dropped = 0;
  for (const day of await entries.allDates()) {
    if (!remote.has(day)) { await entries.delete(day); await blobs.delete(day); dropped++; }
  }
  for (const day of await blobs.allDates()) {
    if (!remote.has(day)) await blobs.delete(day);   // тело без карточки — мусор
  }

  const days = [...remote.keys()].sort();
  let added = 0, changed = 0;

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const slot = remote.get(day);
    onProgress(i + 1, days.length, 'Читаю опись папки');
    if (!slot.photo) continue;

    const cached = await entries.get(day);
    const noteId = slot.note ? slot.note.id : null;
    const noteModified = slot.note ? slot.note.modifiedTime : null;
    const md5 = slot.photo.md5Checksum || null;
    const sameFile = Boolean(cached) && cached.fileId === slot.photo.id;
    const untouched = sameFile && cached.modifiedTime === slot.photo.modifiedTime;
    // Время правки меняется и от разметки глаз — она лежит в метаданных того же
    // файла. Качать из-за этого мегабайты незачем, поэтому «тот же ли это
    // снимок» решает контрольная сумма, а время правки остаётся признаком
    // «что-то в файле изменилось».
    const contentSame = sameFile &&
      (md5 && cached.md5 ? cached.md5 === md5 : untouched);
    const noteSame = Boolean(cached) &&
      (cached.noteId || null) === noteId && (cached.noteModified || null) === noteModified;
    const eyes = eyesFromProp(slot.photo.appProperties && slot.photo.appProperties.eyes);
    const eyesSame = Boolean(cached) && sameEyes(cached.eyes, eyes);

    if (untouched && noteSame && eyesSame) continue;

    const entry = {
      date: day,
      fileId: slot.photo.id,
      modifiedTime: slot.photo.modifiedTime,
      md5,
      noteId,
      noteModified,
      eyes,
      // Комментарий лежит отдельным файлом, и качать его ради одной строки при
      // каждой описи — та же жадность, что и качать снимки. Показываем старую
      // копию и помечаем, что она отстала: подтянется вместе со снимком.
      comment: cached ? (cached.comment || '') : '',
      noteStale: Boolean(noteId) && !noteSame,
      w: contentSame ? cached.w : 0,
      h: contentSame ? cached.h : 0,
    };

    if (!contentSame) {
      await blobs.delete(day);           // снимок другой — тело устарело целиком
      if (cached) changed++; else added++;
    } else if (!eyesSame) {
      // Разметку поправили с другого телефона. Если снимок сейчас в памяти —
      // пересобираем выровненный кадр на месте, иначе он соберётся при
      // следующем показе, когда снимок и так будет загружен.
      const body = await blobs.get(day);
      if (body && body.photo) {
        const d = await deriveFrom(body.photo, eyes,
          { size: cfg.videoSize, target: cfg.eyeTarget });
        await blobs.put({ date: day, photo: body.photo, aligned: d.aligned });
      }
      changed++;
    } else {
      changed++;
    }

    await entries.put(entry);
  }

  await settings.set('lastSyncAt', Date.now());
  return { added, changed, dropped, days: days.length, rootId };
}

/**
 * Кадры для предпросмотра — миниатюры, которые Google делает сам.
 *
 * Возвращаем ссылки, а не файлы: скачать миниатюру запросом нельзя — сервер
 * картинок не отдаёт заголовок CORS, и fetch с токеном там всегда падает.
 * Зато обычная <img> её показывает, поэтому загрузку берёт на себя тот, кто
 * рисует, а холст просто не читают обратно в файл.
 *
 * День стоит десятков килобайт вместо мегабайтов, поэтому посмотреть год
 * можно, не выкачивая год. В файл такое не годится: за настоящим видео идут
 * оригиналы через ensureBodies.
 *
 * @param {string[]} dates дни по порядку
 * @param {number} size сторона миниатюры в пикселях
 * @returns {Promise<Array<{date:string, url:string, eyes:?Object}>>}
 */
export async function previewFrames(drive, dates, { size = 540 } = {}) {
  const need = dates.some(d => !previewCache.has(d));
  if (need) {
    for (const f of await drive.listDayFiles()) {
      const p = f.appProperties || {};
      if (!p.day || p.kind === 'note' || !f.thumbnailLink) continue;
      // В ссылке уже стоит запрошенный размер — подменяем на свой.
      previewCache.set(p.day, /=s\d+/.test(f.thumbnailLink)
        ? f.thumbnailLink.replace(/=s\d+.*$/, `=s${size}`)
        : `${f.thumbnailLink}=s${size}`);
    }
  }
  const out = [];
  for (const date of dates) {
    const url = previewCache.get(date);
    if (!url) continue;
    const entry = await entries.get(date);
    out.push({ date, url, eyes: entry ? entry.eyes : null });
  }
  return out;
}

/** Выбросить предпросмотр из памяти — как и всё остальное, он временный. */
export function clearPreview() {
  previewCache.clear();
}

/**
 * Комментарий — единственное, что дешевле дотянуть отдельно от снимка: это
 * несколько сотен байт, и ради них незачем ждать мегабайты.
 */
export async function ensureNote(drive, date) {
  const entry = await entries.get(date);
  if (!entry || !entry.noteStale) return entry;
  entry.comment = entry.noteId
    ? (await (await drive.download(entry.noteId)).text()).trim()
    : '';
  entry.noteStale = false;
  await entries.put(entry);
  return entry;
}

/**
 * Тело дня: мастер-кадр, выровненный кадр, свежий комментарий. Это и есть
 * дорогая часть, поэтому качается ровно тогда, когда её собрались показать
 * или отправить в видео.
 */
export async function ensureBody(drive, date, { cfg = null } = {}) {
  const conf = cfg || await settings.all();
  const entry = await entries.get(date);
  if (!entry || !entry.fileId) return null;

  let body = await blobs.get(date);
  let dirty = false;

  if (!body || !body.photo) {
    const raw = await drive.download(entry.fileId);
    const { blob, w, h } = await toMaster(raw, conf.masterMaxDim, conf.masterQuality);
    body = { date, photo: blob, aligned: null };
    entry.w = w; entry.h = h;
    dirty = true;
  }

  if (!body.aligned) {
    const d = await deriveFrom(body.photo, entry.eyes,
      { size: conf.videoSize, target: conf.eyeTarget });
    body.aligned = d.aligned;
    dirty = true;
  }

  if (entry.noteStale) {
    entry.comment = entry.noteId
      ? (await (await drive.download(entry.noteId)).text()).trim()
      : '';
    entry.noteStale = false;
    dirty = true;
  }

  if (dirty) {
    await blobs.put(body);
    await entries.put(entry);
  }
  return { entry, body };
}

/** Каких дней ещё нет целиком — чтобы сказать, сколько придётся качать. */
export async function missingBodies(dates) {
  const have = new Set(await blobs.allDates());
  const out = [];
  for (const date of dates) {
    if (have.has(date)) continue;
    const entry = await entries.get(date);
    if (entry && entry.fileId) out.push(date);
  }
  return out;
}

/** Тела пачкой — для таймлапса и для выгрузки архива. */
export async function ensureBodies(drive, dates, { onProgress = () => {} } = {}) {
  const cfg = await settings.all();
  const todo = await missingBodies(dates);
  let loaded = 0, failed = 0;
  for (let i = 0; i < todo.length; i++) {
    onProgress(i, todo.length, 'Загружаю кадры');
    try {
      await ensureBody(drive, todo[i], { cfg });
      loaded++;
    } catch {
      failed++;      // один недокачанный день не должен ронять всю сборку
    }
  }
  onProgress(todo.length, todo.length, 'Загружаю кадры');
  return { loaded, failed, total: todo.length };
}

/** Кладёт снимок за день. Сначала папка, потом кэш. */
export async function putPhoto(drive, date, file) {
  const cfg = await settings.all();
  const rootId = cfg.driveFolderId || await ensureFolder(drive);
  const { blob, w, h } = await toMaster(file, cfg.masterMaxDim, cfg.masterQuality);
  const was = await entries.get(date);

  const res = await drive.putDayFile({
    rootId, dateKey: date, name: `${date}.jpg`,
    blob, mime: 'image/jpeg', kind: 'photo',
    fileId: was ? was.fileId : undefined,
    props: { eyes: '' },        // снимок другой — старая разметка к нему не относится
  });

  const derived = await deriveFrom(blob, null, { size: cfg.videoSize, target: cfg.eyeTarget });
  const entry = {
    date,
    fileId: res.id,
    modifiedTime: res.modifiedTime,
    md5: res.md5Checksum || null,
    eyes: null,
    comment: was ? was.comment || '' : '',
    noteId: was ? was.noteId || null : null,
    noteModified: was ? was.noteModified || null : null,
    noteStale: false,
    w, h,
  };
  await blobs.put({ date, photo: blob, aligned: derived.aligned });
  await entries.put(entry);
  return entry;
}

/** Отмечает глаза: правятся метаданные, сам снимок не перезаливается. */
export async function putEyes(drive, date, eyes) {
  const cfg = await settings.all();
  const entry = await entries.get(date);
  if (!entry || !entry.fileId) throw new Error('Сначала нужен снимок за этот день');

  // Размечают всегда по мастер-кадру, так что он уже здесь; но если день
  // размечают сразу после чужой съёмки — доберём.
  const loaded = await ensureBody(drive, date, { cfg });

  const res = await drive.updateProps(entry.fileId, {
    [TAG]: '1', kind: 'photo', day: date, eyes: eyesToProp(eyes),
  });

  const fresh = loaded ? loaded.entry : entry;
  fresh.eyes = eyes;
  fresh.modifiedTime = res.modifiedTime;
  const derived = await deriveFrom(loaded.body.photo, eyes,
    { size: cfg.videoSize, target: cfg.eyeTarget });
  await blobs.put({ date, photo: loaded.body.photo, aligned: derived.aligned });
  await entries.put(fresh);
  return fresh;
}

/** Комментарий — отдельный текстовый файл рядом со снимком. */
export async function putComment(drive, date, text) {
  const cfg = await settings.all();
  const entry = await entries.get(date);
  if (!entry) return null;          // комментарий без снимка хранить негде
  const value = String(text || '');

  if (!value.trim()) {
    if (entry.noteId) await drive.trash(entry.noteId);
    entry.noteId = null;
    entry.noteModified = null;
  } else {
    const res = await drive.putDayFile({
      rootId: cfg.driveFolderId, dateKey: date, name: `${date}.txt`,
      blob: new Blob([value], { type: 'text/plain' }),
      mime: 'text/plain', kind: 'note',
      fileId: entry.noteId || undefined,
    });
    entry.noteId = res.id;
    entry.noteModified = res.modifiedTime;
  }
  entry.comment = value;
  entry.noteStale = false;
  await entries.put(entry);
  return entry;
}

/** Удаляет день целиком: один день — один файл, значит и в папке тоже. */
export async function removeDay(drive, date) {
  const entry = await entries.get(date);
  if (entry) {
    for (const id of [entry.fileId, entry.noteId].filter(Boolean)) {
      await drive.trash(id);      // если Диск откажет, бросим до правки кэша
    }
  }
  await entries.delete(date);
  await blobs.delete(date);
}
