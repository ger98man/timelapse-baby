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

import { entries, blobs, bench, settings, clearCache } from './db.js';
import { toMaster, loadImage } from './img.js';
import { renderSquareBlob, eyePatchesFromBlob, refineEyes } from './align.js';
import { TAG, describeFile } from './drive.js';
import { inLanes } from './pool.js';
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

/**
 * Чем помечен выровненный кадр. Кадр зависит от двух настроек — размера и
 * композиции, — и обе ездят между телефонами через config.json. Значит,
 * лежащий кадр может оказаться собран не по тем настройкам, что стоят
 * сейчас, и отличить это надо до того, как он попадёт в видео.
 */
function frameStamp(cfg) {
  const t = cfg.eyeTarget || {};
  const at = ['lx', 'ly', 'rx', 'ry'].map(k => Number(t[k] || 0).toFixed(4)).join(',');
  return `${cfg.videoSize}@${at}`;
}

function sameEyes(a, b) {
  if (!a || !b) return !a === !b;
  return ['lx', 'ly', 'rx', 'ry'].every(k => Math.abs(a[k] - b[k]) < 1e-6);
}

/** Файлы папки → карта «день → снимок и комментарий». */
function indexRemote(files) {
  const byDay = new Map();
  for (const f of files) {
    const what = describeFile(f);
    if (!what) continue;
    const slot = byDay.get(what.day) || {};
    if (what.kind === 'note') {
      slot.note = f;
    } else if (what.kind === 'photo') {
      // если снимков за день вдруг несколько, берём последний по времени
      if (!slot.photo || ts(f.modifiedTime) > ts(slot.photo.modifiedTime)) slot.photo = f;
    }
    byDay.set(what.day, slot);
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
  const patch = {};
  if (root.id !== cfg.driveFolderId) patch.driveFolderId = root.id;
  if (root.name !== cfg.driveFolderName) patch.driveFolderName = root.name;
  if (Object.keys(patch).length) await settings.merge(patch);
  return root.id;
}

/**
 * Переключение на другой альбом.
 *
 * Кэш при этом стирается целиком, и это не расточительность, а единственный
 * честный ход: опись, миниатюры и указатель на config.json собраны из прежней
 * папки и к новой отношения не имеют. Терять нечего — правда лежит в папке,
 * опись вернётся оттуда одним запросом.
 *
 * @param {{id:string, name:string}} root папка альбома
 */
export async function switchProject(drive, root) {
  await forgetAlbum();
  await settings.merge({
    driveFolderId: root.id,
    driveFolderName: root.name,
    // Имя и дата рождения у каждого ребёнка свои, и старые здесь — прямая
    // ложь: до первой синхронизации на экране стояло бы имя прошлого альбома.
    babyName: '', birthDate: null, dueDate: null,
  });
  const files = await drive.listDayFiles(root.id);
  await pullProfile(drive, files);
  return root.id;
}

/**
 * Имя папки альбома — это имя ребёнка. Поменяли имя в настройках — папка в
 * Диске едет следом, иначе человек ищет «Алису» и не находит.
 *
 * Чужую папку не трогаем: она на виду у владельца, и переименовывать её не
 * наше дело. Пустое имя тоже не повод: безымянная папка в Диске хуже, чем
 * папка со старым именем.
 */
export async function renameProject(drive, name) {
  const cfg = await settings.all();
  const clean = (name || '').trim();
  if (!clean || !cfg.driveFolderId || clean === cfg.driveFolderName) return null;
  if (typeof drive.rename !== 'function') return null;
  const root = await drive.findRoot(cfg.driveFolderId);
  if (!root || !root.ownedByMe) return null;
  const got = await drive.rename(root.id, clean);
  await settings.set('driveFolderName', got);
  return got;
}

/**
 * Кэш собран не из этой папки? Спрашиваем у Диска про один кэшированный день:
 * лежит он в этой папке или нет. Нужно там, где приложение ещё не помнит,
 * из какой папки кэш, — у всех, кто обновился с прежней версии.
 *
 * Не ответил или файла нет — «не знаю»: в этом случае решает осторожность,
 * и кэш остаётся на месте.
 */
async function fromElsewhere(drive, rootId, dates) {
  const first = await entries.get(dates[0]);
  if (!first || !first.fileId || typeof drive.belongsToAlbum !== 'function') return false;
  try {
    return !(await drive.belongsToAlbum(rootId, first.fileId));
  } catch {
    return false;
  }
}

/**
 * Подтягивает опись папки в кэш. Единственное направление: Диск → телефон.
 * Обратного нет, потому что правки уходят в папку сразу, а не копятся.
 *
 * Снимки здесь не качаются, и мегабайтов не будет, сколько бы лет ни было
 * снято: спрашиваются папки альбома и опись файлов в них. Поэтому обновление
 * не страшно делать при каждом запуске и на мобильном интернете.
 */
export async function refresh(drive, { onProgress = () => {} } = {}) {
  onProgress(0, 1, 'Ищу папку');
  const rootId = await ensureFolder(drive);

  onProgress(0, 1, 'Смотрю, что в папке');
  const files = await drive.listDayFiles(rootId);
  await pullProfile(drive, files);

  const cfg = await settings.all();      // настройки могли приехать из папки
  const remote = indexRemote(files);

  // Кэш помнит, из какой папки он собран. Сменили папку — дни прежнего
  // альбома к новой не относятся вовсе, и держать их рядом с её днями нельзя:
  // получится альбом, которого нет ни у кого.
  const switched = Boolean(cfg.cacheFolderId) && cfg.cacheFolderId !== rootId;
  const local = await entries.allDates();
  const foreign = switched ||
    (Boolean(local.length) && !remote.size && await fromElsewhere(drive, rootId, local));

  // А вот пустая папка при непустом кэше — если папка та же самая — почти
  // всегда не «всё удалили», а «перестали видеть»: отозвали доступ, оборвалась
  // сеть. Стереть в этот момент всё накопленное — потеря, которую нечем
  // откатить, поэтому не стираем, а говорим.
  if (!foreign && !remote.size && local.length) {
    const e = new Error(
      `В папке не видно ни одного дня, а на телефоне их ${local.length}. ` +
      'Ничего не удаляю: похоже, приложение потеряло доступ к файлам. ' +
      'Проверьте папку в «Настройках».');
    e.code = 'empty-folder';
    throw e;
  }

  // Кэш от прежней папки выбрасываем целиком, а не по дням: совпади дата —
  // от старого дня остался бы комментарий поверх чужого снимка.
  let dropped = 0;
  if (foreign) {
    await clearCache();
    previewCache.clear();
    dropped = local.length;
  }

  // Чего в папке нет — того нет и у нас. Кэш не хранит ничего своего.
  for (const day of (foreign ? [] : local)) {
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

  await settings.merge({ lastSyncAt: Date.now(), cacheFolderId: rootId });
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
  // null здесь значимее пустоты: «спрашивали, миниатюры у Диска нет». Если бы
  // такой день просто не попадал в карту, календарь заказывал бы опись всей
  // папки при каждой отрисовке месяца — ради дня, которого там всё равно нет.
  // На следующем обновлении описи ссылка приедет и запись сама починится.
  previewCache.set(day, link || null);
}

/** Добрать ссылки описью папки — один запрос на всю историю. */
async function fillThumbs(drive) {
  const rootId = await settings.get('driveFolderId');
  for (const f of await drive.listDayFiles(rootId)) {
    const what = describeFile(f);
    if (!what || what.kind === 'note') continue;
    rememberThumb(what.day, f.thumbnailLink);
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

/**
 * Забыть альбом прежней папки — целиком, вместе с телами снимков и запомненным
 * config.json. Зовётся там, где человек сам выбрал папку: это единственный
 * момент, когда точно известно, что прежние дни к новому альбому отношения не
 * имеют. Терять нечего — правда лежит в папке, опись приедет заново.
 */
export async function forgetAlbum() {
  await clearCache();
  previewCache.clear();
  await settings.merge({ cacheFolderId: null, profileFileId: null });
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

  if (!body.aligned || body.stamp !== frameStamp(conf)) {
    body.aligned = await renderSquareBlob(body.photo,
      { size: conf.videoSize, eyes: entry.eyes, target: conf.eyeTarget });
    body.stamp = frameStamp(conf);
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
 * Готовый кадр за день, без единого сетевого запроса: снимок уже в памяти
 * (день только что открывали) или кадр лежит на верстаке (уже собирали в
 * этот заход).
 *
 * Годится он, только если собран тем же размером и той же композицией, —
 * иначе в видео уедет кадр, которого человек на экране не видел.
 */
async function readyFrame(date, cfg) {
  const stamp = frameStamp(cfg);
  const body = await blobs.get(date);
  if (body && body.aligned && body.stamp === stamp) return body.aligned;

  const kept = await bench.get(date);
  if (kept && kept.aligned && kept.stamp === stamp) return kept.aligned;

  return null;
}

/**
 * Кадр из оригинала: скачанный файл превращается в квадрат и ложится на
 * верстак. Мастер-кадр по дороге не создаётся и никуда не кладётся —
 * разметка глаз задана в долях от размера снимка, поэтому одинаково ложится
 * и на оригинал из папки.
 */
async function frameFromRaw(date, raw, cfg) {
  const entry = await entries.get(date);
  const aligned = await renderSquareBlob(raw, {
    size: cfg.videoSize, eyes: entry ? entry.eyes : null,
    target: cfg.eyeTarget, quality: 0.88,
  });
  await bench.put({ date, aligned, stamp: frameStamp(cfg) });
  return aligned;
}

/**
 * Кадры для сборки — всё, что удалось собрать, и счёт того, что не удалось:
 * один недокачанный день не должен ронять годовое видео.
 *
 * Порядок работы здесь важнее, чем кажется. Сначала разбираем то, что уже
 * готово, — это бесплатно и сразу двигает полоску. Остальное качается
 * пачками (см. `pool.js`), а вот превращается в кадры по одному: декодировать
 * четыре двухтысячепиксельных снимка разом телефон не обязан, и весь смысл
 * пачек — занять сеть, а не память.
 *
 * @returns {Promise<{frames: Array<{date:string, blob:Blob}>, missing:number}>}
 */
export async function buildFrames(drive, dates, { onProgress = () => {} } = {}) {
  const cfg = await settings.all();
  const ready = new Array(dates.length).fill(null);
  const wanted = [];
  let done = 0;

  onProgress(0, dates.length, 'Готовлю кадры');
  for (let i = 0; i < dates.length; i++) {
    ready[i] = await readyFrame(dates[i], cfg);
    if (ready[i]) onProgress(++done, dates.length, 'Готовлю кадры');
    else wanted.push(i);
  }

  const pull = async i => {
    const entry = await entries.get(dates[i]);
    if (!entry || !entry.fileId || !drive) return null;
    return drive.download(entry.fileId);
  };

  for await (const got of inLanes(wanted, pull)) {
    const i = got.item;
    if (got.value) {
      try {
        ready[i] = await frameFromRaw(dates[i], got.value, cfg);
      } catch {
        ready[i] = null;      // кадр не собрался — день просто не попадёт в видео
      }
    }
    onProgress(++done, dates.length, 'Готовлю кадры');
  }

  const frames = [];
  let missing = 0;
  for (let i = 0; i < dates.length; i++) {
    if (ready[i]) frames.push({ date: dates[i], blob: ready[i] });
    else missing++;
  }
  return { frames, missing };
}

/**
 * Мастер-кадр за день — для архива, который состоит из оригиналов.
 *
 * Путь короткий: память, папка. Пережимать скачанное незачем — в папке лежит
 * ровно то, что приложение туда положило, это и есть мастер.
 *
 * На верстак оригинал не ложится, и это не экономия, а прямое требование:
 * архив всё равно упаковывается за один заход, а верстак вытирается сразу
 * после него. Год оригиналов, записанный в базу и тут же оттуда стёртый, —
 * это лишние сотни мегабайт записи на телефоне и повод упереться в квоту
 * ровно посередине выгрузки. Скачанный файл живёт ссылкой в собираемом
 * архиве, и этого достаточно.
 */
export async function masterFor(drive, date) {
  const body = await blobs.get(date);
  if (body && body.photo) return body.photo;

  const entry = await entries.get(date);
  if (!entry || !entry.fileId || !drive) return null;

  return drive.download(entry.fileId);
}

/**
 * Оригиналы за несколько дней, по порядку и пачками, — для выгрузки архива.
 * День, который не удалось забрать, приезжает как null: один недоступный
 * снимок не должен ронять весь архив.
 *
 * @param {string[]} dates
 * @param {(date:string, photo:?Blob) => (void|Promise<void>)} onDay
 */
export async function eachMaster(drive, dates, onDay) {
  for await (const got of inLanes(dates, date => masterFor(drive, date))) {
    await onDay(got.item, got.value || null);
  }
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
  const stamp = frameStamp(await settings.all());
  const ready = new Set(await bench.datesWithStamp(stamp));
  for (const date of await blobs.allDates()) {
    const body = await blobs.get(date);      // это память вкладки, а не диск
    if (body && body.aligned && body.stamp === stamp) ready.add(date);
  }
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
  await blobs.put({ date, photo: blob, aligned, stamp: frameStamp(cfg) });
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
  await blobs.put({ date, photo: loaded.body.photo, aligned, stamp: frameStamp(cfg) });
  await entries.put(fresh);
  await rememberEyes(cfg, date, loaded.body.photo, eyes);
  return fresh;
}

/**
 * Запоминает, как выглядят глаза на этом снимке, — чтобы завтра найти их на
 * следующем. Хранится один день, самый свежий: уточняют всегда по нему.
 *
 * Ничего важного здесь не происходит, поэтому и ошибки глотаются молча:
 * разметка уже сохранена в папке, а без кусочков завтрашний день просто
 * откроется со вчерашними точками, как открывался всегда.
 */
async function rememberEyes(cfg, date, photo, eyes) {
  try {
    const known = cfg.eyePatch;
    // Правят старый день — свежую пачку не трогаем: уточняют по последнему
    // размеченному дню, и старый кадр на его месте только помешал бы.
    if (known && known.folderId === cfg.driveFolderId && known.date > date) return;
    const pack = await eyePatchesFromBlob(photo, eyes, { target: cfg.eyeTarget });
    await settings.set('eyePatch',
      pack ? { ...pack, date, folderId: cfg.driveFolderId } : null);
  } catch { /* уточнение — удобство, а не обязанность */ }
}

/**
 * Насколько далеко уточнение вправе увести точку от той, что поставили рукой, —
 * в долях расстояния между глазами. Не мера точности, а предохранитель: за этой
 * чертой это уже не уточнение, а переезд на другое место снимка.
 */
const MAX_NUDGE = 0.35;

/**
 * Проходит альбом по порядку и доводит разметку каждого дня до глаз.
 *
 * Зачем это нужно. Точки на прошлых днях ставили пальцем, каждый день заново, и
 * промахивались каждый день по-своему. В отдельном кадре промах не виден, а в
 * готовом видео он и есть та самая мелкая дрожь: сами снимки не дрожат, дрожит
 * разметка. Уточнение сцепляет дни друг с другом — каждый следующий находится
 * по кусочкам предыдущего, а не заново под пальцем, — и независимой ошибке
 * взяться становится неоткуда.
 *
 * Границы у прохода жёсткие, и это главное в нём:
 *
 *   — размеченные дни, и только они. Неразмеченный день так и останется
 *     неразмеченным: поставить за человека первую точку — не то же самое, что
 *     поправить поставленную им;
 *   — дальше MAX_NUDGE от руки точка не уходит. Найденное не там (блик, ухо,
 *     второй ребёнок в кадре) отбрасывается, и день остаётся при своей
 *     разметке, а цепочка продолжается от неё же — ошибка не расползается;
 *   — правка уходит в папку по одной, тем же putEyes, что и обычная разметка.
 *     Ничего особенного с точки зрения папки здесь не происходит.
 *
 * @returns {Promise<{moved:number, kept:number, missed:number, total:number}>}
 */
export async function retouchEyes(drive, { onProgress = () => {} } = {}) {
  const cfg = await settings.all();
  const rows = (await entries.range('0000-01-01', '9999-12-31'))
    .filter(r => r.fileId && r.eyes);
  const dates = rows.map(r => r.date);
  const known = new Map(rows.map(r => [r.date, r.eyes]));

  let pack = null, prev = null, last = null;
  let moved = 0, kept = 0, missed = 0, done = 0;

  await eachMaster(drive, dates, async (date, photo) => {
    onProgress(++done, dates.length, 'Уточняю разметку');
    if (!photo) { missed++; return; }

    const own = known.get(date);
    let eyes = own;

    if (pack && prev) {
      try {
        const got = await refineFromBlob(pack, photo, prev);
        if (got && withinNudge(got, own)) { eyes = got; }
      } catch { /* не вышло — остаёмся при своей разметке */ }
    }

    const changed = eyes !== own;
    try {
      if (changed) {
        // Тело кладём заранее: putEyes ищет снимок сначала в памяти, и без
        // этого он скачал бы тот же файл второй раз.
        await blobs.put({ date, photo, aligned: null });
        await putEyes(drive, date, eyes);
        moved++;
      } else {
        kept++;
      }
      pack = await eyePatchesFromBlob(photo, eyes, { target: cfg.eyeTarget });
      prev = pack ? eyes : null;
      if (pack) last = date;
    } catch {
      missed++;
      pack = null; prev = null;
    } finally {
      // Год оригиналов в памяти вкладки не держат: день обработан — и свободен.
      await blobs.delete(date);
    }
  });

  // Цепочка не должна обрываться на последнем дне прохода: завтрашний день
  // продолжит её с того же места, а не начнёт заново.
  if (pack && last) {
    await settings.set('eyePatch', { ...pack, date: last, folderId: cfg.driveFolderId });
  }
  return { moved, kept, missed, total: dates.length };
}

/** Уточнение по снимку в файле: align.js работает с картинкой, не с блобом. */
async function refineFromBlob(pack, photo, guess) {
  const { img, width, height, release } = await loadImage(photo);
  try {
    return refineEyes(pack, { src: img, w: width, h: height, eyes: guess });
  } finally {
    release();
  }
}

/** Ушло ли уточнение дальше, чем позволено отходить от руки. */
function withinNudge(got, own) {
  const span = Math.hypot(own.rx - own.lx, own.ry - own.ly);
  if (!(span > 0)) return false;
  return Math.hypot(got.lx - own.lx, got.ly - own.ly) < span * MAX_NUDGE
      && Math.hypot(got.rx - own.rx, got.ry - own.ry) < span * MAX_NUDGE;
}

/**
 * С чего начать разметку нового дня: точки ближайшего размеченного дня и,
 * если он же последний, кусочки его кадра для уточнения.
 *
 * Пачка годится, только когда она снята с того самого дня, чьи точки мы
 * подставляем, и в том же альбоме: иначе искать будем один кадр, а плясать
 * от разметки другого.
 */
export async function eyeGuess(date) {
  const cfg = await settings.all();
  const rows = await entries.range('0000-01-01', date);
  let ref = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date !== date && rows[i].eyes) { ref = rows[i]; break; }
  }
  if (!ref) return { eyes: null, pack: null };

  const pack = cfg.eyePatch;
  const fits = pack && pack.date === ref.date && pack.folderId === cfg.driveFolderId
    && pack.l && pack.l.length === (pack.radius * 2 + 1) ** 2;
  return { eyes: ref.eyes, from: ref.date, pack: fits ? pack : null };
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
