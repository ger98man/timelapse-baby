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

import { entries, blobs, bench, settings } from './db.js';
import { toMaster } from './img.js';
import { renderSquareBlob } from './align.js';
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
    if (!remote.has(day)) {
      await entries.delete(day);
      await blobs.delete(day);
      await bench.delete(day);
      previewCache.delete(day);
      dropped++;
    }
  }
  for (const day of await blobs.allDates()) {
    if (!remote.has(day)) await blobs.delete(day);   // тело без карточки — мусор
  }
  for (const day of await bench.allDates()) {
    if (!remote.has(day)) await bench.delete(day);
  }

  const days = [...remote.keys()].sort();
  let added = 0, changed = 0;

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const slot = remote.get(day);
    onProgress(i + 1, days.length, 'Читаю опись папки');
    if (!slot.photo) continue;

    // Ссылка на миниатюру приехала этим же запросом и стоила ноль. Запоминаем
    // её здесь, чтобы показу дня и предпросмотру не пришлось ходить за описью
    // второй раз.
    rememberThumb(day, slot.photo.thumbnailLink);

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
      await bench.delete(day);
      if (cached) changed++; else added++;
    } else if (!eyesSame) {
      await bench.delete(day);           // на верстаке кадр по старым глазам
      // Разметку поправили с другого телефона. Если снимок сейчас в памяти —
      // пересобираем выровненный кадр на месте, иначе он соберётся при
      // следующем показе, когда снимок и так будет загружен.
      const body = await blobs.get(day);
      if (body && body.photo) {
        const aligned = await renderSquareBlob(body.photo,
          { size: cfg.videoSize, eyes, target: cfg.eyeTarget });
        await blobs.put({ date: day, photo: body.photo, aligned });
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

// --- миниатюры Диска --------------------------------------------------------
//
// Их делает сам Google, они приезжают ссылками вместе с описью папки и весят
// килобайты. Отсюда всё, что в приложении показывается быстро: и предпросмотр
// таймлапса, и лицо в карточке дня, пока едет оригинал.
//
// Скачать миниатюру запросом нельзя — сервер картинок не отдаёт заголовок
// CORS, и fetch с токеном там всегда падает. Зато обычная <img> её показывает,
// поэтому наружу отдаются ссылки, а загрузку берёт на себя тот, кто рисует.
// Читать холст обратно после этого нельзя, но показу это и не нужно: за
// настоящим видео идут оригиналы через buildFrames.

/** Сторона миниатюры задана прямо в ссылке — подставляем свою. */
function sizedThumb(link, size) {
  return /=s\d+/.test(link)
    ? link.replace(/=s\d+.*$/, `=s${size}`)
    : `${link}=s${size}`;
}

/**
 * Запоминает ссылку на миниатюру дня. Зовётся из обновления описи, поэтому
 * показу обычно не приходится ходить в Диск отдельно: ссылки приехали тем же
 * запросом, которым читалась опись.
 */
function rememberThumb(day, link) {
  if (link) previewCache.set(day, link);
  else previewCache.delete(day);
}

/** Добрать ссылки описью папки — один запрос на всю историю. */
async function fillThumbs(drive) {
  for (const f of await drive.listDayFiles()) {
    const p = f.appProperties || {};
    if (!p.day || p.kind === 'note') continue;
    rememberThumb(p.day, f.thumbnailLink);
  }
}

/**
 * Кадры для предпросмотра таймлапса. День стоит десятков килобайт вместо
 * мегабайтов, поэтому посмотреть год можно, не выкачивая год.
 *
 * @param {string[]} dates дни по порядку
 * @param {number} size сторона миниатюры в пикселях
 * @returns {Promise<Array<{date:string, url:string, eyes:?Object}>>}
 */
export async function previewFrames(drive, dates, { size = 540 } = {}) {
  if (dates.some(d => !previewCache.has(d))) await fillThumbs(drive);
  const out = [];
  for (const date of dates) {
    const link = previewCache.get(date);
    if (!link) continue;
    const entry = await entries.get(date);
    out.push({ date, url: sizedThumb(link, size), eyes: entry ? entry.eyes : null });
  }
  return out;
}

/**
 * Миниатюра одного дня — чтобы карточка дня показала лицо сразу, а не пустой
 * квадрат на те секунды, пока едет оригинал.
 */
export async function thumbUrl(drive, date, { size = 540 } = {}) {
  if (!previewCache.has(date)) {
    if (!drive) return null;
    await fillThumbs(drive);
  }
  const link = previewCache.get(date);
  return link ? sizedThumb(link, size) : null;
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
    body.aligned = await renderSquareBlob(body.photo,
      { size: conf.videoSize, eyes: entry.eyes, target: conf.eyeTarget });
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

// --- верстак сборки ---------------------------------------------------------
//
// Собрать год — единственная операция, которой правда нужна вся история сразу,
// и раньше она шла через ensureBody: 365 мастер-кадров и 365 выровненных, всё
// это одновременно в памяти вкладки. Полгигабайта — на телефоне вкладку с
// таким весом система закрывает, не дождавшись конца сборки.
//
// Теперь по этому пути идёт только то, что попадёт в кадр, и ложится оно на
// диск, а не в память. Верстак вытирается при уходе с экрана видео и при
// запуске: снимкам на устройстве оставаться по-прежнему негде.

/**
 * Выровненный кадр за день. Три источника, по убыванию дешевизны: снимок уже
 * в памяти (день только что открывали), верстак (уже собирали в этот заход),
 * папка.
 *
 * Мастер-кадр по дороге не создаётся и никуда не кладётся. Разметка глаз
 * задана в долях от размера снимка, поэтому одинаково ложится и на оригинал
 * из папки; скачанный файл живёт до конца следующей строки.
 */
async function alignedFor(drive, date, cfg) {
  const body = await blobs.get(date);
  if (body && body.aligned) return body.aligned;

  const kept = await bench.get(date);
  if (kept && kept.size === cfg.videoSize) return kept.aligned;

  const entry = await entries.get(date);
  if (!entry || !entry.fileId || !drive) return null;

  const raw = await drive.download(entry.fileId);
  const aligned = await renderSquareBlob(raw, {
    size: cfg.videoSize, eyes: entry.eyes, target: cfg.eyeTarget, quality: 0.88,
  });
  await bench.put({ date, aligned, size: cfg.videoSize });
  return aligned;
}

/**
 * Кадры для сборки — всё, что удалось собрать, и счёт того, что не удалось:
 * один недокачанный день не должен ронять годовое видео.
 *
 * @returns {Promise<{frames: Array<{date:string, blob:Blob}>, missing:number}>}
 */
export async function buildFrames(drive, dates, { onProgress = () => {} } = {}) {
  const cfg = await settings.all();
  const frames = [];
  let missing = 0;
  for (let i = 0; i < dates.length; i++) {
    onProgress(i, dates.length, 'Готовлю кадры');
    let blob = null;
    try {
      blob = await alignedFor(drive, dates[i], cfg);
    } catch {
      blob = null;
    }
    if (blob) frames.push({ date: dates[i], blob });
    else missing++;
  }
  onProgress(dates.length, dates.length, 'Готовлю кадры');
  return { frames, missing };
}

/**
 * Мастер-кадр за день — для архива, который состоит из оригиналов.
 *
 * Путь тот же: память, верстак, папка. Пережимать скачанное незачем — в папке
 * лежит ровно то, что приложение туда положило, это и есть мастер.
 */
export async function masterFor(drive, date) {
  const body = await blobs.get(date);
  if (body && body.photo) return body.photo;

  const kept = await bench.get(date);
  if (kept && kept.photo) return kept.photo;

  const entry = await entries.get(date);
  if (!entry || !entry.fileId || !drive) return null;

  const photo = await drive.download(entry.fileId);
  await bench.put({ ...(kept || {}), date, photo });
  return photo;
}

/**
 * Разметка ближайшего размеченного дня до указанного.
 *
 * Снимки изо дня в день похожи: ребёнок в том же кресле, родитель на том же
 * месте. Поэтому вчерашние точки почти всегда стоят там, где нужно, и разметка
 * из «поставь две точки» превращается в «проверь и сохрани».
 */
export async function eyesBefore(date) {
  const rows = await entries.range('0000-01-01', date);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date !== date && rows[i].eyes) return rows[i].eyes;
  }
  return null;
}

/** Сколько дней промежутка придётся качать — чтобы сказать это до сборки. */
export async function pendingFrames(dates) {
  const ready = new Set(await blobs.allDates());
  for (const date of await bench.allDates()) ready.add(date);
  return dates.filter(date => !ready.has(date)).length;
}

/** Верстак больше не нужен: ушли с экрана видео, закончили выгрузку, запустились. */
export function clearBench() {
  return bench.clear();
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

  const aligned = await renderSquareBlob(blob,
    { size: cfg.videoSize, eyes: null, target: cfg.eyeTarget });
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
  await bench.delete(date);
  previewCache.delete(date);         // ссылка вела на прежний снимок
  await blobs.put({ date, photo: blob, aligned });
  await entries.put(entry);
  return entry;
}

/** Отмечает глаза: правятся метаданные, сам снимок не перезаливается. */
export async function putEyes(drive, date, eyes) {
  const cfg = await settings.all();
  const entry = await entries.get(date);
  if (!entry || !entry.fileId) throw new Error('Сначала нужен снимок за этот день');

  // Размечают всегда по мастер-кадру, так что он уже здесь; но если день
  // размечают сразу после чужой съёмки — доберём. Без снимка размечать нечего:
  // раньше здесь стояла проверка, которая всё равно тут же читала loaded.body.
  const loaded = await ensureBody(drive, date, { cfg });
  if (!loaded || !loaded.body.photo) {
    throw new Error('Снимок не загрузился — разметка не сохранена');
  }

  const res = await drive.updateProps(entry.fileId, {
    [TAG]: '1', kind: 'photo', day: date, eyes: eyesToProp(eyes),
  });

  const fresh = loaded.entry;
  fresh.eyes = eyes;
  fresh.modifiedTime = res.modifiedTime;
  const aligned = await renderSquareBlob(loaded.body.photo,
    { size: cfg.videoSize, eyes, target: cfg.eyeTarget });
  await bench.delete(date);          // на верстаке кадр по старым глазам
  await blobs.put({ date, photo: loaded.body.photo, aligned });
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

/**
 * Удаляет день целиком: один день — один файл, значит и в папке тоже.
 *
 * Возвращает список того, что ушло в корзину, — по нему день можно достать
 * обратно. Корзина Диска держит файлы 30 дней, так что «отменить» — это не
 * хранение копии у нас, а всего лишь снятый флажок.
 *
 * @returns {Promise<{date:string, ids:string[]}>}
 */
export async function removeDay(drive, date) {
  const entry = await entries.get(date);
  const ids = [];
  if (entry) {
    // Комментарий первым, снимок вторым. Приложение видит день по снимку,
    // поэтому обратный порядок при отказе на середине оставлял бы в папке
    // осиротевший .txt, до которого больше никак не добраться.
    for (const id of [entry.noteId, entry.fileId].filter(Boolean)) {
      await drive.trash(id);      // если Диск откажет, бросим до правки кэша
      ids.push(id);
    }
  }
  await entries.delete(date);
  await blobs.delete(date);
  await bench.delete(date);
  previewCache.delete(date);
  return { date, ids };
}

/**
 * Достаёт день обратно из корзины и возвращает его в опись.
 *
 * Кэша своего у нас нет, поэтому «вернуть» — это снять флажок в папке и
 * перечитать опись: день приедет оттуда сам, вместе с комментарием и
 * разметкой, ровно таким, каким был.
 */
export async function restoreDay(drive, removed) {
  if (!removed || !removed.ids.length) return null;
  for (const id of removed.ids) await drive.untrash(id);
  await refresh(drive);
  return entries.get(removed.date);
}
