// Экспорт и импорт. Самая важная часть проекта.
//
// Источник правды — не эта база и не это приложение, а папка с обычными
// файлами: /2026/09/2026-09-14.jpg рядом с 2026-09-14.txt. Приложение — лишь
// удобная оболочка поверх такой папки. Если через десять лет от кода ничего не
// останется, архив всё равно откроется чем угодно.

import { entries, settings } from './db.js';
import { createZip, readZip } from './zip.js';
import * as store from './store.js';
import { describeFile } from './drive.js';
import { eyesFromProp } from './store.js';
import { CONFIG_NAME } from './profile.js';
import { inLanes } from './pool.js';

const ts = iso => (iso ? Date.parse(iso) : 0);

/** Имя папки без приписки с почтой владельца — как его показывают на экране. */
const folderLabel = name => String(name || '').split(' — ')[0].trim();

const README = `Ежедневные фото — архив
=======================

Структура:

  2026/09/2026-09-14.jpg   снимок за этот день (оригинал, не трогается)
  2026/09/2026-09-14.txt   комментарий к этому дню, обычный текст UTF-8
  index.csv               таблица: дата, комментарий, координаты глаз
  settings.json           имя, дата рождения, настройки кадра

Фотографии — обычные JPEG. Комментарии — обычный текст. Ничего проприетарного
здесь нет: папку можно открыть на любом компьютере, скопировать, распечатать,
залить куда угодно.

Координаты глаз в index.csv — доли от ширины и высоты снимка (0..1). По ним
кадры выравниваются так, чтобы глаза стояли в одной точке и лицо не прыгало.
Выровненные кадры в архив не кладутся: они всегда пересоздаются из оригиналов.

Держите копию этой папки в двух местах. Одна копия — это не копия.
`;

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Собирает архив из оригиналов.
 *
 * На телефоне их нет: снимки лежат в папке и качаются по ходу упаковки —
 * пачками, чтобы не ждать Диск по одному разу на день. В базу они при этом
 * не ложатся вовсе: год фотографий не должен оседать на устройстве только
 * потому, что архив один раз выгрузили.
 *
 * Без сети (drive = null) дни без снимка просто не попадут в архив — их число
 * возвращается отдельно, чтобы человеку не пришлось догадываться, почему в
 * архиве меньше файлов, чем дней в календаре.
 *
 * @returns {Promise<{zip: Blob, days: number, skipped: number}>}
 */
export async function exportArchive(drive, onProgress) {
  const dates = await entries.allDates();
  const cfg = await settings.all();
  const files = [];
  const csv = [['date', 'comment', 'eye_lx', 'eye_ly', 'eye_rx', 'eye_ry'].join(',')];
  let packed = 0, skipped = 0;

  // Оригиналы едут пачками и приезжают по порядку: год — это сотни запросов
  // к Диску, и ждать ответа по одному значит потерять минуты на пустом месте.
  let seen = 0;
  await store.eachMaster(drive, dates, async (date, photo) => {
    if (onProgress) onProgress(++seen, dates.length, 'Собираю файлы');
    const e = await entries.get(date);
    if (!e) return;
    const [y, m] = date.split('-');
    const stamp = new Date(e.modifiedTime || date);
    if (photo) {
      files.push({ name: `${y}/${m}/${date}.jpg`, data: photo, date: stamp });
      packed++;
    } else {
      skipped++;      // снимка нет ни на телефоне, ни в папке
    }
    if (e.comment && e.comment.trim()) {
      files.push({ name: `${y}/${m}/${date}.txt`, data: e.comment, date: stamp });
    }
    const ey = e.eyes;
    csv.push([date, csvEscape(e.comment || ''),
      ey ? ey.lx.toFixed(5) : '', ey ? ey.ly.toFixed(5) : '',
      ey ? ey.rx.toFixed(5) : '', ey ? ey.ry.toFixed(5) : ''].join(','));
  });

  const meta = {
    babyName: cfg.babyName,
    birthDate: cfg.birthDate,
    dueDate: cfg.dueDate,
    eyeTarget: cfg.eyeTarget,
    videoSize: cfg.videoSize,
    videoFps: cfg.videoFps,
    exportedAt: new Date().toISOString(),
    days: dates.length,
  };

  files.push({ name: 'index.csv', data: '\ufeff' + csv.join('\n') + '\n' });
  files.push({ name: 'settings.json', data: JSON.stringify(meta, null, 2) });
  files.push({ name: 'README.txt', data: README });

  const zip = await createZip(files, (d, t) => onProgress && onProgress(d, t, 'Пакую архив'));
  await settings.set('lastExportAt', Date.now());
  return { zip, days: packed, skipped };
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})\.(jpg|jpeg|png|txt)$/i;

/**
 * Разбирает ZIP на альбомы.
 *
 * Архив одного ребёнка — это годы прямо в корне, архив всей корневой папки —
 * годы под именем ребёнка. Отличаем по первому уровню: четыре цифры значит
 * год, всё остальное — имя альбома.
 *
 * Единственная группа считается одним альбомом, как бы она ни называлась:
 * архив, распакованный и запакованный обратно, приезжает завёрнутым в папку
 * с собственным именем, и принять эту обёртку за имя ребёнка нельзя.
 *
 * @returns {Promise<Array<{name:string, photos:Map, texts:Map, eyes:Map, meta:?Object}>>}
 */
export async function parseArchive(blob) {
  const items = await readZip(blob);
  const groups = new Map();       // имя папки в архиве -> содержимое

  const groupOf = name => {
    const parts = name.split('/').filter(Boolean);
    if (parts.length < 2 || /^\d{4}$/.test(parts[0])) return '';
    return parts[0];
  };
  const take = key => {
    if (!groups.has(key)) {
      groups.set(key, { name: key, photos: new Map(), texts: new Map(), eyes: new Map(), meta: null });
    }
    return groups.get(key);
  };

  for (const item of items) {
    const base = item.name.split('/').pop();
    const g = take(groupOf(item.name));

    if (base === 'index.csv') {
      const rows = parseCsv((await item.blob.text()).replace(/^\ufeff/, ''));
      const header = rows.shift() || [];
      const col = name => header.indexOf(name);
      for (const r of rows) {
        const date = r[col('date')];
        if (!date) continue;
        if (r[col('comment')]) g.texts.set(date, r[col('comment')]);
        const lx = parseFloat(r[col('eye_lx')]);
        if (!Number.isNaN(lx)) {
          g.eyes.set(date, {
            lx, ly: parseFloat(r[col('eye_ly')]),
            rx: parseFloat(r[col('eye_rx')]), ry: parseFloat(r[col('eye_ry')]),
          });
        }
      }
      continue;
    }
    if (base === 'settings.json') {
      try { g.meta = JSON.parse(await item.blob.text()); } catch { /* не критично */ }
      continue;
    }
    const m = base.match(DATE_RE);
    if (!m) continue;
    if (m[2].toLowerCase() === 'txt') {
      if (!g.texts.has(m[1])) g.texts.set(m[1], (await item.blob.text()).trim());
    } else {
      g.photos.set(m[1], item.blob);
    }
  }

  // Пустые группы (один README.txt в корне) альбомами не считаем.
  const albums = [...groups.values()].filter(g => g.photos.size || g.texts.size);
  return albums.length > 1 ? albums : albums.map(g => ({ ...g, name: '' }));
}

/**
 * Раскладывает разобранный альбом по дням — в текущую папку.
 * Существующие дни не перезаписываются, если replace = false: так безопасно
 * сливать архивы двух телефонов.
 */
export async function applyAlbum(drive, group, { replace = false } = {}, onProgress) {
  const dates = [...group.photos.keys()].sort();
  let added = 0, skipped = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const existing = await entries.get(date);
    if (existing && !replace) { skipped++; continue; }

    // Импорт — такая же правка, как съёмка: сначала папка, потом кэш.
    await store.putPhoto(drive, date, group.photos.get(date));
    const note = group.texts.get(date) || (existing ? existing.comment : '') || '';
    if (note.trim()) await store.putComment(drive, date, note);
    const mark = group.eyes.get(date) || (existing ? existing.eyes : null);
    if (mark) await store.putEyes(drive, date, mark);
    added++;
    if (onProgress) onProgress(i + 1, dates.length, 'Импортирую дни');
  }

  return { added, skipped, meta: group.meta, total: dates.length };
}

/** Импорт архива одного ребёнка в текущий альбом. */
export async function importArchive(drive, blob, opts = {}, onProgress) {
  const albums = await parseArchive(blob);
  if (!albums.length) return { added: 0, skipped: 0, meta: null, total: 0 };
  return applyAlbum(drive, albums[0], opts, onProgress);
}

// --- вся корневая папка ------------------------------------------------------
//
// Архив одного альбома — это годы прямо в корне ZIP. Архив корневой папки —
// те же годы, но на этаж ниже, под именем ребёнка. Разложение то же самое, что
// в Диске, и по нему же архив опознаётся при загрузке: первый уровень — год
// значит один альбом, иначе имена детей.

/** Опись одного альбома, прочитанная прямо из его папки. */
async function readAlbum(drive, albumId) {
  const byDay = new Map();
  for (const f of await drive.listDayFiles(albumId)) {
    const what = describeFile(f);
    if (!what) continue;
    const slot = byDay.get(what.day) || {};
    if (what.kind === 'note') slot.note = f;
    else if (!slot.photo || ts(f.modifiedTime) > ts(slot.photo.modifiedTime)) slot.photo = f;
    byDay.set(what.day, slot);
  }
  return byDay;
}

/**
 * Архив всей корневой папки: все дети разом, каждый своей папкой внутри.
 *
 * Читается прямо из Диска, а не из кэша: кэш есть только у того альбома, что
 * открыт сейчас, а выгрузить надо все. Поэтому и без сети эта выгрузка не
 * работает — в отличие от выгрузки текущего альбома, которой хватает кэша.
 *
 * @param {Array<{id:string,name:string}>} albums что лежит в корневой папке
 * @returns {Promise<{zip: Blob, days: number, skipped: number, albums: number}>}
 */
export async function exportRoot(drive, albums, onProgress) {
  const files = [];
  let packed = 0, skipped = 0, done = 0;

  // Сколько всего файлов качать, знаем только после описи каждой папки —
  // поэтому сначала описи, потом одна общая полоса прогресса на всё.
  const plan = [];
  for (const album of albums) {
    if (onProgress) onProgress(0, 1, `Смотрю, что в «${folderLabel(album.name)}»`);
    plan.push({ album, days: await readAlbum(drive, album.id) });
  }
  const total = plan.reduce((n, p) => n + p.days.size, 0);

  for (const { album, days } of plan) {
    const dir = safeName(folderLabel(album.name));
    const csv = [['date', 'comment', 'eye_lx', 'eye_ly', 'eye_rx', 'eye_ry'].join(',')];
    const dates = [...days.keys()].sort();

    for await (const { item: date, value } of inLanes(dates, async date => {
      const slot = days.get(date);
      const [photo, note] = await Promise.all([
        slot.photo ? drive.download(slot.photo.id) : null,
        slot.note ? drive.download(slot.note.id).then(b => b.text()) : null,
      ]);
      return { photo, note };
    })) {
      if (onProgress) onProgress(++done, total, `Собираю «${folderLabel(album.name)}»`);
      const slot = days.get(date);
      const [y, m] = date.split('-');
      const stamp = new Date((slot.photo && slot.photo.modifiedTime) || date);
      const got = value || {};
      if (got.photo) {
        files.push({ name: `${dir}/${y}/${m}/${date}.jpg`, data: got.photo, date: stamp });
        packed++;
      } else {
        skipped++;                 // снимок не отдался — день уедет без него
      }
      const note = (got.note || '').trim();
      if (note) files.push({ name: `${dir}/${y}/${m}/${date}.txt`, data: note, date: stamp });
      const eyes = slot.photo
        ? eyesFromProp(slot.photo.appProperties && slot.photo.appProperties.eyes)
        : null;
      csv.push([date, csvEscape(note),
        eyes ? eyes.lx.toFixed(5) : '', eyes ? eyes.ly.toFixed(5) : '',
        eyes ? eyes.rx.toFixed(5) : '', eyes ? eyes.ry.toFixed(5) : ''].join(','));
    }

    files.push({ name: `${dir}/index.csv`, data: '\ufeff' + csv.join('\n') + '\n' });
    // Настройки ребёнка лежат в его же папке — кладём как есть, вместе с
    // именем и датой рождения: без них архив не восстановить.
    const profile = await readProfile(drive, album.id);
    if (profile) {
      files.push({ name: `${dir}/settings.json`, data: JSON.stringify(profile, null, 2) });
    }
  }

  files.push({ name: 'README.txt', data: README });
  const zip = await createZip(files, (d, t) => onProgress && onProgress(d, t, 'Пакую архив'));
  await settings.set('lastExportAt', Date.now());
  return { zip, days: packed, skipped, albums: albums.length };
}

/** config.json альбома — то же, что приложение кладёт в его папку. */
async function readProfile(drive, albumId) {
  try {
    const file = (await drive.listChildren(albumId))
      .find(f => f.name === CONFIG_NAME ||
        (f.appProperties && f.appProperties.kind === 'config'));
    return file ? JSON.parse(await (await drive.download(file.id)).text()) : null;
  } catch {
    return null;                  // нет доступа или сломан руками — не беда
  }
}

/** Имя ребёнка — имя папки в архиве. Всё, что ломает путь, убираем. */
function safeName(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  return clean || 'Альбом';
}
