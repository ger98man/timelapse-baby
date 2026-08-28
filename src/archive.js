// Экспорт и импорт. Самая важная часть проекта.
//
// Источник правды — не эта база и не это приложение, а папка с обычными
// файлами: /2026/09/2026-09-14.jpg рядом с 2026-09-14.txt. Приложение — лишь
// удобная оболочка поверх такой папки. Если через десять лет от кода ничего не
// останется, архив всё равно откроется чем угодно.

import { entries, settings } from './db.js';
import { createZip, readZip } from './zip.js';
import { toMaster } from './img.js';
import { buildDerived } from './align.js';

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

/** @returns {Promise<Blob>} */
export async function exportArchive(onProgress) {
  const dates = await entries.allDates();
  const cfg = await settings.all();
  const files = [];
  const csv = [['date', 'comment', 'eye_lx', 'eye_ly', 'eye_rx', 'eye_ry'].join(',')];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const e = await entries.get(date);
    if (!e) continue;
    const [y, m] = date.split('-');
    files.push({ name: `${y}/${m}/${date}.jpg`, data: e.photo, date: new Date(e.createdAt) });
    if (e.comment && e.comment.trim()) {
      files.push({ name: `${y}/${m}/${date}.txt`, data: e.comment, date: new Date(e.updatedAt) });
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

  files.push({ name: 'index.csv', data: '﻿' + csv.join('\n') + '\n' });
  files.push({ name: 'settings.json', data: JSON.stringify(meta, null, 2) });
  files.push({ name: 'README.txt', data: README });

  const zip = await createZip(files, (d, t) => onProgress && onProgress(d, t, 'Пакую архив'));
  await settings.set('lastExportAt', Date.now());
  return zip;
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})\.(jpg|jpeg|png|txt)$/i;

/**
 * Импорт архива. Существующие дни не перезаписываются, если replace = false —
 * так безопасно сливать архивы двух телефонов.
 */
export async function importArchive(blob, { replace = false } = {}, onProgress) {
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

    const src = photos.get(date);
    const { blob: photo, w, h } = await toMaster(src, cfg.masterMaxDim, cfg.masterQuality);
    const entry = {
      date,
      photo, w, h,
      comment: texts.get(date) || (existing ? existing.comment : '') || '',
      eyes: eyes.get(date) || (existing ? existing.eyes : null) || null,
      createdAt: existing ? existing.createdAt : Date.now(),
      photoAt: Date.now(),
    };
    await buildDerived(entry, { size: cfg.videoSize, target: cfg.eyeTarget });
    await entries.put(entry);
    added++;
    if (onProgress) onProgress(i + 1, dates.length, 'Импортирую дни');
  }

  return { added, skipped, meta, total: dates.length };
}
