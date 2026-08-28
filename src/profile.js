// Пользовательские настройки живут не на телефоне, а в папке на Диске —
// в config.json рядом с фотографиями.
//
// Из-за этого установка на новый телефон сводится к входу в Google: имя, дата
// рождения и настройки кадра приезжают сами. И второму родителю ничего не надо
// вводить заново — он подключается к папке и получает всё готовым.
//
// Файл человекочитаемый: его можно открыть в Диске и прочесть глазами.

import { settings } from './db.js';

export const CONFIG_NAME = 'config.json';

/** Что считается общим для всех, кто снимает одного ребёнка. */
export const PROFILE_KEYS = [
  'babyName',
  'birthDate',
  'dueDate',
  'eyeTarget',
  'videoSize',
  'videoFps',
  'masterMaxDim',
  'masterQuality',
  'reminderHour',
];

export function pickProfile(cfg) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    const v = cfg[key];
    // Пустое значение — это «не заполнено», а не «стереть». Иначе телефон,
    // где имя ещё не ввели, затрёт им уже заполненное имя у второго родителя.
    if (v === undefined || v === null || v === '') continue;
    out[key] = v;
  }
  return out;
}

const ts = iso => (iso ? Date.parse(iso) : 0);

function findConfigFile(files) {
  return files.find(f =>
    (f.appProperties && f.appProperties.kind === 'config') || f.name === CONFIG_NAME);
}

/**
 * Синхронизирует config.json: кто новее, тот и прав.
 * @param {object} drive
 * @param {string} rootId
 * @param {Array} remoteFiles  уже полученный список файлов приложения
 * @returns {Promise<{applied:boolean, pushed:boolean, profile:object}>}
 */
export async function syncProfile(drive, rootId, remoteFiles) {
  const cfg = await settings.all();
  const local = pickProfile(cfg);
  const localAt = cfg.settingsUpdatedAt || 0;

  const file = findConfigFile(remoteFiles);
  const remoteAt = file ? ts(file.modifiedTime) : 0;

  // На Диске свежее — забираем оттуда
  if (file && remoteAt > localAt) {
    let remote = null;
    try {
      remote = JSON.parse(await (await drive.download(file.id)).text());
    } catch {
      remote = null;   // кто-то поправил файл руками и сломал — не падаем
    }
    if (remote && typeof remote === 'object') {
      const patch = pickProfile(remote);
      await settings.merge(patch);
      // время берём от файла, иначе следующая же синхронизация зальёт обратно
      await settings.set('settingsUpdatedAt', remoteAt);
      await settings.set('profileFileId', file.id);
      return { applied: true, pushed: false, profile: patch };
    }
  }

  // Локально свежее (или файла ещё нет) — отдаём на Диск
  if (!file || localAt > remoteAt) {
    if (!Object.keys(local).length) return { applied: false, pushed: false, profile: local };
    const body = JSON.stringify({
      ...local,
      _комментарий: 'Настройки приложения «Каждый день». Фотографии лежат рядом, ' +
        'по папкам года и месяца. Этот файл можно править руками.',
      updatedAt: new Date().toISOString(),
    }, null, 2);

    const res = await drive.putDayFile({
      rootId,
      dateKey: null,
      name: CONFIG_NAME,
      blob: new Blob([body], { type: 'application/json' }),
      mime: 'application/json',
      kind: 'config',
      fileId: file ? file.id : undefined,
    });
    await settings.set('settingsUpdatedAt', ts(res.modifiedTime));
    await settings.set('profileFileId', res.id);
    return { applied: false, pushed: true, profile: local };
  }

  return { applied: false, pushed: false, profile: local };
}

/**
 * Читает профиль до всякой синхронизации — нужен онбордингу сразу после входа.
 * Список файлов можно передать снаружи, чтобы не запрашивать его дважды.
 */
export async function fetchProfile(drive, files = null) {
  const list = files || await drive.listDayFiles();
  const file = findConfigFile(list);
  if (!file) return null;
  try {
    return JSON.parse(await (await drive.download(file.id)).text());
  } catch {
    return null;
  }
}

/** Сколько дней уже лежит в папке — чтобы сказать об этом человеку сразу. */
export function countRemoteDays(files) {
  const days = new Set();
  for (const f of files) {
    const p = f.appProperties;
    if (p && p.day && (p.kind === 'photo' || !p.kind)) days.add(p.day);
  }
  return days.size;
}
