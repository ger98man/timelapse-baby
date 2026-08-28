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

import { entries, settings } from './db.js';
import { toMaster } from './img.js';
import { buildDerived } from './align.js';
import { TAG } from './drive.js';
import { pullProfile } from './profile.js';

const ts = iso => (iso ? Date.parse(iso) : 0);

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

/** Совпадает ли кэш с тем, что сейчас в папке. */
function isFresh(cached, slot) {
  if (!cached || !slot.photo) return false;
  if (cached.fileId !== slot.photo.id) return false;
  if (cached.modifiedTime !== slot.photo.modifiedTime) return false;
  const noteId = slot.note ? slot.note.id : null;
  const noteMod = slot.note ? slot.note.modifiedTime : null;
  return (cached.noteId || null) === noteId && (cached.noteModified || null) === noteMod;
}

async function cacheDay(drive, day, slot, cfg) {
  const raw = await drive.download(slot.photo.id);
  const { blob, w, h } = await toMaster(raw, cfg.masterMaxDim, cfg.masterQuality);

  const entry = {
    date: day,
    fileId: slot.photo.id,
    modifiedTime: slot.photo.modifiedTime,
    photo: blob, w, h,
    eyes: eyesFromProp(slot.photo.appProperties && slot.photo.appProperties.eyes),
    comment: '',
    noteId: slot.note ? slot.note.id : null,
    noteModified: slot.note ? slot.note.modifiedTime : null,
  };
  if (slot.note) {
    entry.comment = (await (await drive.download(slot.note.id)).text()).trim();
  }
  await buildDerived(entry, { size: cfg.videoSize, target: cfg.eyeTarget });
  await entries.put(entry);
  return entry;
}

/** Папку нашли и запомнили — всё остальное отсчитывается от неё. */
export async function ensureFolder(drive) {
  const cfg = await settings.all();
  const rootId = await drive.ensureRoot(cfg.driveFolderName || 'Каждый день', cfg.driveFolderId);
  if (rootId !== cfg.driveFolderId) await settings.set('driveFolderId', rootId);
  return rootId;
}

/**
 * Подтягивает папку в кэш. Единственное направление: Диск → телефон.
 * Обратного нет, потому что правки уходят в папку сразу, а не копятся.
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
    if (!remote.has(day)) { await entries.delete(day); dropped++; }
  }

  const days = [...remote.keys()].sort();
  let loaded = 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const slot = remote.get(day);
    onProgress(i + 1, days.length, 'Загружаю дни');
    if (!slot.photo) continue;
    if (isFresh(await entries.get(day), slot)) continue;
    await cacheDay(drive, day, slot, cfg);
    loaded++;
  }

  await settings.set('lastSyncAt', Date.now());
  return { loaded, dropped, days: days.length, rootId };
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

  const entry = {
    date,
    fileId: res.id,
    modifiedTime: res.modifiedTime,
    photo: blob, w, h,
    eyes: null,
    comment: was ? was.comment || '' : '',
    noteId: was ? was.noteId || null : null,
    noteModified: was ? was.noteModified || null : null,
  };
  await buildDerived(entry, { size: cfg.videoSize, target: cfg.eyeTarget });
  await entries.put(entry);
  return entry;
}

/** Отмечает глаза: правятся метаданные, сам снимок не перезаливается. */
export async function putEyes(drive, date, eyes) {
  const cfg = await settings.all();
  const entry = await entries.get(date);
  if (!entry || !entry.fileId) throw new Error('Сначала нужен снимок за этот день');

  const res = await drive.updateProps(entry.fileId, {
    [TAG]: '1', kind: 'photo', day: date, eyes: eyesToProp(eyes),
  });
  entry.eyes = eyes;
  entry.modifiedTime = res.modifiedTime;
  await buildDerived(entry, { size: cfg.videoSize, target: cfg.eyeTarget });
  await entries.put(entry);
  return entry;
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
}
