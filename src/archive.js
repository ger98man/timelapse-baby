// Экспорт и импорт. Самая важная часть проекта.
//
// Источник правды — не эта база и не это приложение, а папка с обычными
// файлами: /2026/09/2026-09-14.jpg рядом с 2026-09-14.txt. Приложение — лишь
// удобная оболочка поверх такой папки. Если через десять лет от кода ничего не
// останется, архив всё равно откроется чем угодно.

import { entries, settings } from './db.js';
import { createZip, readZip } from './zip.js';
import * as store from './store.js';

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
 * На телефоне их нет: снимки лежат в папке и качаются по ходу упаковки, на
 * верстак, который вытирается сразу после выгрузки. Год фотографий не должен
 * оседать на устройстве только потому, что архив один раз выгрузили.
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

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const e = await entries.get(date);
    if (!e) continue;
    const [y, m] = date.split('-');
    const stamp = new Date(e.modifiedTime || date);
    let photo = null;
    try {
      photo = await store.masterFor(drive, date);
    } catch {
      photo = null;   // один недоступный день не должен ронять весь архив
    }
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
    if (onProgress) onProgress(i + 1, dates.length, 'Собираю файлы');
  }

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
 * Импорт архива. Существующие дни не перезаписываются, если replace = false —
 * так безопасно сливать архивы двух телефонов.
 */
export async function importArchive(drive, blob, { replace = false } = {}, onProgress) {
  const items = await readZip(blob);
  const cfg = await settings.all();

  const photos = new Map();   // date -> blob
  const texts = new Map();    // date -> string
  const eyes = new Map();     // date -> {lx,ly,rx,ry}
  let meta = null;

  for (const item of items) {
    const base = item.name.split('/').pop();
    if (base === 'index.csv') {
      const rows = parseCsv((await item.blob.text()).replace(/^﻿/, ''));
      const header = rows.shift() || [];
      const col = name => header.indexOf(name);
      for (const r of rows) {
        const date = r[col('date')];
        if (!date) continue;
        if (r[col('comment')]) texts.set(date, r[col('comment')]);
        const lx = parseFloat(r[col('eye_lx')]);
        if (!Number.isNaN(lx)) {
          eyes.set(date, {
            lx, ly: parseFloat(r[col('eye_ly')]),
            rx: parseFloat(r[col('eye_rx')]), ry: parseFloat(r[col('eye_ry')]),
          });
        }
      }
      continue;
    }
    if (base === 'settings.json') {
      try { meta = JSON.parse(await item.blob.text()); } catch { /* не критично */ }
      continue;
    }
    const m = base.match(DATE_RE);
    if (!m) continue;
    if (m[2].toLowerCase() === 'txt') {
      if (!texts.has(m[1])) texts.set(m[1], (await item.blob.text()).trim());
    } else {
      photos.set(m[1], item.blob);
    }
  }

  const dates = [...photos.keys()].sort();
  let added = 0, skipped = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const existing = await entries.get(date);
    if (existing && !replace) { skipped++; continue; }

    // Импорт — такая же правка, как съёмка: сначала папка, потом кэш.
    await store.putPhoto(drive, date, photos.get(date));
    const note = texts.get(date) || (existing ? existing.comment : '') || '';
    if (note.trim()) await store.putComment(drive, date, note);
    const mark = eyes.get(date) || (existing ? existing.eyes : null);
    if (mark) await store.putEyes(drive, date, mark);
    added++;
    if (onProgress) onProgress(i + 1, dates.length, 'Импортирую дни');
  }

  return { added, skipped, meta, total: dates.length };
}
