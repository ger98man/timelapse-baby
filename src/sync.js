// Синхронизация с папкой в Google Диске.
//
// Телефон остаётся главным: снимок сохраняется мгновенно в локальную базу, а
// Диск догоняет когда получится. Поэтому съёмка работает в самолёте, в роддоме
// и при мёртвом вайфае — Google нужен только в момент синхронизации.
//
// Правило разрешения конфликтов: НИКОГДА не терять фотографию. Если за один
// день снимали оба родителя, побеждает то фото, что легло в Диск позже, а
// проигравшее уезжает туда же отдельным файлом «дата-2.jpg». В папке остаётся
// всё; приложение показывает победителя.

import { entries, settings } from './db.js';
import { toMaster } from './img.js';
import { buildDerived } from './align.js';
import { syncProfile } from './profile.js';
import { TAG } from './drive.js';

const ts = iso => (iso ? Date.parse(iso) : 0);

// Разметка глаз едет в appProperties самого снимка — она к нему и относится.
// Так она переживает переустановку, приезжает на второй телефон вместе с фото
// и не теряется, даже если локальную базу стереть.
function eyesToProp(eyes) {
  if (!eyes) return '';
  return [eyes.lx, eyes.ly, eyes.rx, eyes.ry].map(n => n.toFixed(5)).join(',');
}

function eyesFromProp(str) {
  if (!str) return null;
  const n = str.split(',').map(Number);
  if (n.length !== 4 || n.some(Number.isNaN)) return null;
  return { lx: n[0], ly: n[1], rx: n[2], ry: n[3] };
}

function groupRemote(files) {
  const byDay = new Map();
  for (const f of files) {
    const day = f.appProperties && f.appProperties.day;
    if (!day) continue;
    const kind = f.appProperties.kind || 'photo';
    const slot = byDay.get(day) || { extras: [] };
    if (kind === 'photo') {
      // если файлов-победителей вдруг два, берём последний по времени
      if (!slot.photo || ts(f.modifiedTime) > ts(slot.photo.modifiedTime)) {
        if (slot.photo) slot.extras.push(slot.photo);
        slot.photo = f;
      } else slot.extras.push(f);
    } else if (kind === 'note') {
      slot.note = f;
    } else {
      slot.extras.push(f);
    }
    byDay.set(day, slot);
  }
  return byDay;
}

/**
 * @param {object} drive     результат createDrive()
 * @param {object} opts      { onProgress(done,total,label), signal }
 * @returns {Promise<{pulled:number, pushed:number, conflicts:number, rootId:string}>}
 */
export async function sync(drive, { onProgress = () => {}, signal } = {}) {
  const cfg = await settings.all();
  const stop = () => { if (signal && signal.aborted) throw new Error('Синхронизация отменена'); };

  onProgress(0, 1, 'Ищу папку');
  const rootId = await drive.ensureRoot(cfg.driveFolderName || 'Каждый день', cfg.driveFolderId);
  if (rootId !== cfg.driveFolderId) await settings.set('driveFolderId', rootId);

  onProgress(0, 1, 'Смотрю, что на Диске');
  const remoteFiles = await drive.listDayFiles();

  // Общие настройки — до кадров: от них зависит, как эти кадры выравнивать.
  const profile = await syncProfile(drive, rootId, remoteFiles);
  const cfgNow = profile.applied ? await settings.all() : cfg;

  const remoteByDay = groupRemote(remoteFiles);
  const localDates = await entries.allDates();
  const allDays = [...new Set([...remoteByDay.keys(), ...localDates])].sort();

  let pulled = 0, pushed = 0, conflicts = 0;

  for (let i = 0; i < allDays.length; i++) {
    stop();
    const day = allDays[i];
    onProgress(i, allDays.length, 'Синхронизирую');

    const remote = remoteByDay.get(day) || {};
    let local = await entries.get(day);
    const sy = (local && local.sync) || {};
    const localDirty = local ? (local.updatedAt || 0) > (sy.pushedAt || 0) : false;

    // --- забрать с Диска -----------------------------------------------
    const remotePhotoNewer = remote.photo &&
      ts(remote.photo.modifiedTime) > (sy.remotePhotoModified || 0);
    const needPhoto = remote.photo && (!local || !local.photo || remotePhotoNewer);

    if (needPhoto) {
      const hadOwnPhoto = Boolean(local && local.photo && localDirty);
      if (hadOwnPhoto) conflicts++;

      const raw = await drive.download(remote.photo.id);
      const { blob, w, h } = await toMaster(raw, cfgNow.masterMaxDim, cfgNow.masterQuality);
      const remoteEyes = eyesFromProp(remote.photo.appProperties &&
        remote.photo.appProperties.eyes);
      const next = {
        date: day,
        photo: blob, w, h,
        comment: local ? local.comment || '' : '',
        // разметка принадлежит снимку: приехал снимок — приехала и она
        eyes: remoteEyes,
        createdAt: local ? local.createdAt : Date.now(),
        photoAt: Date.now(),
        sync: { ...sy },
      };
      await buildDerived(next, { size: cfgNow.videoSize, target: cfgNow.eyeTarget });

      // проигравший снимок не выкидываем, а увозим в ту же папку отдельно
      if (hadOwnPhoto) {
        const extra = await drive.putDayFile({
          rootId, dateKey: day, name: `${day}-2.jpg`,
          blob: local.photo, mime: 'image/jpeg', kind: 'extra',
        });
        next.sync.extraIds = [...(sy.extraIds || []), extra.id];
      }

      next.sync.photoId = remote.photo.id;
      next.sync.remotePhotoModified = ts(remote.photo.modifiedTime);
      next.sync.photoPushedAt = next.photoAt;
      next.sync.eyesProp = eyesToProp(next.eyes);
      next.sync.pushedAt = Date.now();
      next.updatedAt = Date.now();
      await entries.put(next);
      local = next;
      pulled++;
    }

    const remoteNoteNewer = remote.note &&
      ts(remote.note.modifiedTime) > ((local && local.sync && local.sync.remoteNoteModified) || 0);
    if (remote.note && remoteNoteNewer && local) {
      const text = (await (await drive.download(remote.note.id)).text()).trim();
      if (text !== (local.comment || '')) {
        local.comment = text;
        pulled++;
      }
      local.sync = {
        ...local.sync,
        noteId: remote.note.id,
        remoteNoteModified: ts(remote.note.modifiedTime),
      };
      await entries.put(local);
    }

    // --- отдать на Диск --------------------------------------------------
    if (!local) continue;
    const dirty = (local.updatedAt || 0) > ((local.sync && local.sync.pushedAt) || 0);
    const eyesDiffer = eyesToProp(local.eyes) !== ((local.sync && local.sync.eyesProp) || '');
    if (!dirty && !eyesDiffer && remote.photo && (!local.comment || remote.note)) continue;

    const s = { ...(local.sync || {}) };
    const eyesProp = eyesToProp(local.eyes);
    const photoIsNew = !s.photoId || (local.photoAt || 0) > (s.photoPushedAt || 0);

    if (local.photo && photoIsNew) {
      const res = await drive.putDayFile({
        rootId, dateKey: day, name: `${day}.jpg`,
        blob: local.photo, mime: 'image/jpeg', kind: 'photo',
        fileId: s.photoId,
        props: eyesProp ? { eyes: eyesProp } : undefined,
      });
      s.photoId = res.id;
      s.remotePhotoModified = ts(res.modifiedTime);
      s.photoPushedAt = local.photoAt || Date.now();
      s.eyesProp = eyesProp;
      pushed++;
    } else if (local.photo && s.photoId && eyesProp !== (s.eyesProp || '')) {
      // Снимок прежний, изменилась только разметка — правим метаданные,
      // а не перезаливаем мегабайты ради тридцати байт.
      const res = await drive.updateProps(s.photoId, {
        [TAG]: '1', kind: 'photo', day, ...(eyesProp ? { eyes: eyesProp } : { eyes: '' }),
      });
      s.remotePhotoModified = ts(res.modifiedTime);
      s.eyesProp = eyesProp;
      pushed++;
    }

    if (local.comment && local.comment.trim() && (!s.noteId || dirty)) {
      const res = await drive.putDayFile({
        rootId, dateKey: day, name: `${day}.txt`,
        blob: new Blob([local.comment], { type: 'text/plain' }),
        mime: 'text/plain', kind: 'note',
        fileId: s.noteId,
      });
      s.noteId = res.id;
      s.remoteNoteModified = ts(res.modifiedTime);
    }

    s.pushedAt = Date.now();
    local.sync = s;
    await entries.put(local);
  }

  onProgress(allDays.length, allDays.length, 'Готово');
  await settings.set('lastSyncAt', Date.now());
  return {
    pulled, pushed, conflicts, rootId,
    days: allDays.length,
    profileApplied: profile.applied,
  };
}
