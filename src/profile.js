// Общие настройки — имя, дата рождения, композиция кадра — лежат там же, где
// фотографии: в config.json внутри папки. На телефоне они только кэшируются.
//
// Из-за этого установка на новый телефон сводится ко входу в Google, а второй
// родитель, подключившись к общей папке, сразу получает всё готовым.
//
// Слияния по времени здесь нет и не нужно: правки уходят в папку сразу и
// только при сети, так что расходиться версиям негде.

import { settings } from './db.js';
import { describeFile } from './drive.js';

export const CONFIG_NAME = 'config.json';

/** Что считается общим для всех, кто снимает одного ребёнка. */
export const PROFILE_KEYS = [
  'babyName',
  'birthDate',
  'dueDate',
  'theme',
  'eyeTarget',
  'videoSize',
  'videoFps',
  'videoCaption',
  'masterMaxDim',
  'masterQuality',
];

export function pickProfile(cfg) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    const v = cfg[key];
    // Пустое — это «не заполнено», а не «стереть»: телефон, где имя ещё не
    // вводили, не должен затирать им заполненное имя у второго родителя.
    if (v === undefined || v === null || v === '') continue;
    out[key] = v;
  }
  return out;
}

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

/** Читает config.json из папки в локальные настройки. */
export async function pullProfile(drive, files) {
  const file = await locateConfig(drive, files);
  if (!file) return null;
  let remote = null;
  try {
    remote = JSON.parse(await (await drive.download(file.id)).text());
  } catch {
    return null;      // кто-то поправил файл руками и сломал — не падаем
  }
  if (!remote || typeof remote !== 'object') return null;

  const patch = pickProfile(remote);
  await settings.merge(patch);
  await settings.set('profileFileId', file.id);
  return patch;
}

/** Пишет текущие общие настройки в папку. */
export async function pushProfile(drive) {
  const cfg = await settings.all();
  const profile = pickProfile(cfg);
  if (!Object.keys(profile).length) return null;

  const body = JSON.stringify({
    ...profile,
    _комментарий: 'Настройки приложения «TimelapseBaby». Фотографии лежат рядом, ' +
      'по папкам года и месяца. Этот файл можно править руками.',
    updatedAt: new Date().toISOString(),
  }, null, 2);

  const res = await drive.putDayFile({
    rootId: cfg.driveFolderId,
    dateKey: null,
    name: CONFIG_NAME,
    blob: new Blob([body], { type: 'application/json' }),
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

/** Профиль до всякой загрузки — нужен онбордингу сразу после входа. */
export async function fetchProfile(drive, files = null) {
  const list = files || await drive.listDayFiles(await settings.get('driveFolderId'));
  const file = await locateConfig(drive, list);
  // Указатель на файл настроек привязан к папке, а мастер папку как раз и
  // меняет. Без сброса запись ушла бы в config.json прошлой папки — и в новой
  // настройки не появились бы вовсе.
  await settings.set('profileFileId', file ? file.id : null);
  if (!file) return null;
  try {
    return JSON.parse(await (await drive.download(file.id)).text());
  } catch {
    return null;
  }
}
