// Общие настройки — имя, дата рождения, композиция кадра — лежат там же, где
// фотографии: в config.json внутри папки. На телефоне они только кэшируются.
//
// Из-за этого установка на новый телефон сводится ко входу в Google, а второй
// родитель, подключившись к общей папке, сразу получает всё готовым.
//
// Файлов теперь два, потому что и папок две. В доме лежит базовый config.json:
// оформление и настройки видео — они одни на всех детей, и новый альбом
// наследует их сам собой. В папке ребёнка лежит свой: имя, дата рождения,
// срок. Приложение читает базовый, а поверх кладёт детский, — поэтому любой
// базовый ключ можно переопределить руками в детском файле, и он победит.
//
// Слияния по времени здесь нет и не нужно: правки уходят в папку сразу и
// только при сети, так что расходиться версиям негде.

import { settings } from './db.js';
import { describeFile } from './drive.js';

export const CONFIG_NAME = 'config.json';

/** Что принадлежит одному ребёнку и живёт в его папке. */
export const CHILD_KEYS = [
  'babyName',
  'birthDate',
  'dueDate',
];

/** Что одно на всех детей и живёт в доме. */
export const BASE_KEYS = [
  'theme',
  'eyeTarget',
  'videoSize',
  'videoFps',
  'videoCaption',
  'masterMaxDim',
  'masterQuality',
];

/** Всё общее целиком — тем, кому неважно, из какого файла оно приехало. */
export const PROFILE_KEYS = [...CHILD_KEYS, ...BASE_KEYS];

function pickKeys(cfg, keys) {
  const out = {};
  for (const key of keys) {
    const v = cfg[key];
    // Пустое — это «не заполнено», а не «стереть»: телефон, где имя ещё не
    // вводили, не должен затирать им заполненное имя у второго родителя.
    if (v === undefined || v === null || v === '') continue;
    out[key] = v;
  }
  return out;
}

export const pickProfile = cfg => pickKeys(cfg, PROFILE_KEYS);

function findConfig(files) {
  return files.find(f =>
    (f.appProperties && f.appProperties.kind === 'config') || f.name === CONFIG_NAME);
}

/**
 * Тот же config.json, но с запасным путём: если в описи по метке его нет,
 * смотрим прямо в подключённой папке. Опись строится по метке приложения, а
 * в общей папке файл мог оказаться без неё — и тогда второго родителя зря
 * просили бы ввести имя и дату, которые лежат в двух шагах от него.
 */
async function locateConfig(drive, files) {
  const tagged = findConfig(files);
  if (tagged) return tagged;
  if (typeof drive.listChildren !== 'function') return null;
  try {
    const rootId = await settings.get('driveFolderId');
    return findConfig(await drive.listChildren(rootId)) || null;
  } catch {
    return null;                      // нет доступа или сети — не беда
  }
}

async function readJson(drive, file) {
  try {
    const text = await (await drive.download(file.id)).text();
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;      // кто-то поправил файл руками и сломал — не падаем
  }
}

/**
 * Базовый config.json из дома. Дома может и не быть — так живёт второй
 * родитель, которому дали доступ на одну папку ребёнка: тогда базовых
 * настроек в Диске нет, и приложение обходится теми, что в детском файле.
 */
export async function fetchBase(drive) {
  const homeId = await settings.get('homeFolderId');
  if (!homeId || typeof drive.listChildren !== 'function') return null;
  let file = null;
  try {
    file = findConfig(await drive.listChildren(homeId)) || null;
  } catch {
    return null;                      // нет доступа или сети — не беда
  }
  await settings.set('baseFileId', file ? file.id : null);
  return file ? readJson(drive, file) : null;
}

/** Читает оба config.json в локальные настройки: базовый, поверх — детский. */
export async function pullProfile(drive, files) {
  const base = await fetchBase(drive);
  const file = await locateConfig(drive, files);
  const child = file ? await readJson(drive, file) : null;
  if (!base && !child) return null;

  const patch = {
    ...pickKeys(base || {}, BASE_KEYS),
    ...pickKeys(child || {}, PROFILE_KEYS),
  };
  await settings.merge(patch);
  await settings.set('profileFileId', file ? file.id : null);
  return patch;
}

const NOTE_BASE = 'Общие настройки приложения «TimelapseBaby»: оформление и ' +
  'видео. Рядом лежат папки детей, у каждого внутри свой config.json. ' +
  'Этот файл можно править руками.';

const NOTE_CHILD = 'Настройки этого ребёнка: имя, дата рождения. Фотографии ' +
  'лежат рядом, по папкам года и месяца. Общее оформление — в config.json ' +
  'этажом выше. Этот файл можно править руками.';

function configBlob(data, note) {
  const body = JSON.stringify({
    ...data,
    _комментарий: note,
    updatedAt: new Date().toISOString(),
  }, null, 2);
  return new Blob([body], { type: 'application/json' });
}

/**
 * Пишет текущие общие настройки в папку — в оба файла сразу.
 *
 * Дома нет — базовые ключи уезжают в детский config.json: иначе у второго
 * родителя, подключённого к одной папке, размер кадра и композиция не
 * доехали бы до его второго телефона вовсе.
 */
export async function pushProfile(drive) {
  const cfg = await settings.all();
  const child = pickKeys(cfg, CHILD_KEYS);
  const base = pickKeys(cfg, BASE_KEYS);
  const home = cfg.homeFolderId;

  // Дом мог пропасть: его удалили, переименовали, вошли другим аккаунтом.
  // Тогда базовые ключи едут в детский config.json — они нужны второму
  // телефону, а из какого файла приедут, ему всё равно.
  let inHome = false;
  if (home && Object.keys(base).length) {
    try {
      const res = await drive.putDayFile({
        rootId: home,
        dateKey: null,
        name: CONFIG_NAME,
        blob: configBlob(base, NOTE_BASE),
        mime: 'application/json',
        kind: 'config',
        fileId: cfg.baseFileId || undefined,
      });
      await settings.set('baseFileId', res.id);
      inHome = true;
    } catch { /* запишем их ребёнку */ }
  }

  const own = inHome ? child : { ...base, ...child };
  if (!cfg.driveFolderId || !Object.keys(own).length) return null;

  const res = await drive.putDayFile({
    rootId: cfg.driveFolderId,
    dateKey: null,
    name: CONFIG_NAME,
    blob: configBlob(own, NOTE_CHILD),
    mime: 'application/json',
    kind: 'config',
    fileId: cfg.profileFileId || undefined,
  });
  await settings.set('profileFileId', res.id);
  return res;
}

/** Сколько дней уже лежит в папке — чтобы сказать об этом человеку сразу. */
export function countRemoteDays(files) {
  const days = new Set();
  for (const f of files) {
    const what = describeFile(f);
    if (what && what.kind === 'photo') days.add(what.day);
  }
  return days.size;
}

/**
 * Профиль до всякой загрузки — нужен онбордингу сразу после входа. Базовый и
 * детский уже слитые: спрашивающему важно, известны настройки или нет, а не
 * в каком файле они лежали.
 */
export async function fetchProfile(drive, files = null) {
  const list = files || await drive.listDayFiles(await settings.get('driveFolderId'));
  const base = await fetchBase(drive);
  const file = await locateConfig(drive, list);
  // Указатель на файл настроек привязан к папке, а альбом как раз и меняют.
  // Без сброса запись ушла бы в config.json прошлой папки — и в новой
  // настройки не появились бы вовсе.
  await settings.set('profileFileId', file ? file.id : null);
  const child = file ? await readJson(drive, file) : null;
  if (!base && !child) return null;
  return { ...(base || {}), ...(child || {}) };
}
