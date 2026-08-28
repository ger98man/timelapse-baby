import { entries, settings, requestPersistence, storageEstimate, DB_NAME } from './db.js';
import * as D from './dates.js';
import { toMaster, formatBytes } from './img.js';
import { buildDerived } from './align.js';
import { buildVideo, playFrames, videoSupported } from './video.js';
import { exportArchive, importArchive } from './archive.js';
import { createZip } from './zip.js';
import { GOOGLE, configured } from '../config.js';
import { runOnboarding } from './onboarding.js';
import * as G from './google.js';
import { createDrive } from './drive.js';
import { sync } from './sync.js';
import { pickFolder } from './picker.js';

const $ = id => document.getElementById(id);
const state = {
  cfg: null,
  calYear: 0,
  calMonth: 0,
  urls: [],          // объектные URL текущего экрана, чтобы не течь памятью
  align: null,       // контекст оверлея разметки глаз
  video: null,       // последнее собранное видео
  previewAbort: null,
};

// --- мелкие помощники -------------------------------------------------------

function freeUrls() {
  state.urls.forEach(URL.revokeObjectURL);
  state.urls = [];
}
function url(blob) {
  const u = URL.createObjectURL(blob);
  state.urls.push(u);
  return u;
}

let toastTimer;
function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/**
 * Свой диалог подтверждения вместо системного confirm().
 *
 * Системный ненадёжен: встроенные панели браузеров гасят его молча, а Chrome
 * после «блокировать диалоги на этой странице» навсегда возвращает «нет» —
 * и кнопка выглядит сломанной, хотя код отработал.
 */
function ask({ title, text = '', yes = 'Удалить', no = 'Отмена', danger = true }) {
  return new Promise(resolve => {
    const box = $('ask');
    $('ask-title').textContent = title;
    $('ask-text').textContent = text;
    $('ask-text').classList.toggle('hidden', !text);
    $('ask-yes').textContent = yes;
    $('ask-yes').classList.toggle('btn-danger', danger);
    $('ask-no').textContent = no;
    box.classList.remove('hidden');

    const close = answer => {
      box.classList.add('hidden');
      $('ask-yes').onclick = $('ask-no').onclick = box.onclick = null;
      resolve(answer);
    };
    $('ask-yes').onclick = () => close(true);
    $('ask-no').onclick = () => close(false);
    box.onclick = e => { if (e.target === box) close(false); };
  });
}

function progressOpen(label) {
  $('progress-label').textContent = label;
  $('progress-fill').style.width = '0%';
  $('progress-count').textContent = '';
  $('progress').classList.remove('hidden');
}
function progressSet(done, total, label) {
  if (label) $('progress-label').textContent = label;
  const pct = total ? Math.round(done / total * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  $('progress-count').textContent = total ? `${done} из ${total}` : '';
}
function progressClose() { $('progress').classList.add('hidden'); }

async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
  return 'downloaded';
}

function targetFromCfg(cfg) { return cfg.eyeTarget; }

/** Пересобирает выровненный кадр и миниатюру записи. */
function refreshAligned(entry) {
  return buildDerived(entry, {
    size: state.cfg.videoSize,
    target: targetFromCfg(state.cfg),
  });
}

/**
 * Что показывать человеку. С отмеченными глазами — выровненный кадр: на экране
 * должно быть ровно то, что попадёт в таймлапс.
 */
function faceOf(entry) {
  return entry.eyes && entry.aligned ? entry.aligned : entry.photo;
}

// --- блокировка -------------------------------------------------------------

const b64 = {
  from: bytes => btoa(String.fromCharCode(...bytes)),
  to: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

async function hashCode(code, saltB64) {
  const salt = saltB64 ? b64.to(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
  return { hash: b64.from(new Uint8Array(bits)), salt: b64.from(salt) };
}

function askCode() {
  return new Promise(resolve => {
    const lock = $('lock'), input = $('lock-input'), err = $('lock-error');
    lock.classList.remove('hidden');
    input.value = '';
    err.textContent = '';
    setTimeout(() => input.focus(), 250);

    const submit = async () => {
      const { hash } = await hashCode(input.value, state.cfg.lockSalt);
      if (hash === state.cfg.lockHash) {
        lock.classList.add('hidden');
        resolve();
      } else {
        err.textContent = 'Не тот код';
        input.value = '';
        input.focus();
      }
    };
    $('lock-submit').onclick = submit;
    input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  });
}

// --- Google -----------------------------------------------------------------

/** Диск создаётся лениво: без интернета и без токена он и не нужен. */
function drive() {
  return createDrive({ getToken: () => G.getAccessToken({ interactive: false }) });
}

/** Синхронизация вручную — с прогрессом и внятным итогом. */
async function runSync() {
  if (!configured()) { toast('Google не настроен'); return; }
  progressOpen('Синхронизирую');
  try {
    await G.getAccessToken({ interactive: true });
    const res = await sync(drive(), {
      onProgress: (d, t, label) => progressSet(d, t, label),
    });
    progressClose();
    const parts = [];
    if (res.pulled) parts.push(`получено: ${res.pulled}`);
    if (res.pushed) parts.push(`отправлено: ${res.pushed}`);
    if (res.conflicts) parts.push(`спорных дней: ${res.conflicts}`);
    toast(parts.length ? parts.join(', ') : 'Всё и так совпадает');
    state.cfg = await settings.all();
    freeUrls();
    await renderToday();
    await renderMore();
  } catch (e) {
    progressClose();
    toast(e.message || 'Синхронизация не прошла');
  }
}

/** Тихая попытка после съёмки: получилось — хорошо, нет — не мешаем. */
function syncQuietly() {
  if (!configured() || !state.cfg.autoSync || !state.cfg.driveEmail) return;
  if (!navigator.onLine) return;
  sync(drive()).then(() => settings.all().then(c => { state.cfg = c; }))
    .catch(() => { /* синхронизируется при следующей возможности */ });
}

async function renderGoogleCard() {
  const card = $('google-card');
  const status = $('google-status');
  const show = (id, on) => $(id).classList.toggle('hidden', !on);

  if (!configured()) {
    card.classList.remove('hidden');
    status.textContent = 'В этой сборке не заполнен clientId в config.js, ' +
      'поэтому Диск недоступен: приложение работает локально, а архив ' +
      'выгружается вручную. Это чинится на стороне того, кто выкладывал сборку.';
    ['btn-sync', 'drive-link', 'btn-pick-folder', 'btn-google-off', 'google-hint',
      'btn-wizard', 'btn-google-connect'].forEach(id => show(id, false));
    return;
  }
  show('google-hint', true);
  show('btn-wizard', true);
  $('btn-wizard').textContent = 'Пройти настройку заново';

  const cfg = state.cfg;
  const connected = Boolean(cfg.driveEmail);
  const token = G.currentToken();

  show('btn-google-connect', !connected);
  show('btn-sync', connected);
  show('btn-pick-folder', connected);
  show('btn-google-off', connected);

  const link = $('drive-link');
  if (connected && cfg.driveFolderId) {
    link.href = `https://drive.google.com/drive/folders/${cfg.driveFolderId}`;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }

  if (!connected) {
    status.textContent = 'Аккаунт не подключён.';
    return;
  }
  const when = cfg.lastSyncAt
    ? (Date.now() - cfg.lastSyncAt < 3600000
        ? 'синхронизировано только что'
        : `последняя синхронизация ${D.formatLong(D.toKey(new Date(cfg.lastSyncAt)))}`)
    : 'ещё ни разу не синхронизировано';
  status.textContent = `${cfg.driveEmail} · ${when}` +
    (token ? '' : ' · нужен один тап, чтобы обновить доступ');
}

// --- экран «Сегодня» --------------------------------------------------------

let todayCommentTimer, dayCommentTimer;

async function renderToday() {
  const key = D.todayKey();
  const cfg = state.cfg;
  const info = D.dayLabel(key, cfg);
  const name = cfg.babyName ? `${cfg.babyName} · ` : '';

  $('today-title').textContent = info.label;
  $('today-sub').textContent = name + D.formatLong(key) + (info.sub ? ` · ${info.sub}` : '');

  const entry = await entries.get(key);
  const slot = $('today-photo');
  slot.innerHTML = '';

  if (entry && entry.photo) {
    const img = document.createElement('img');
    img.src = url(faceOf(entry));
    img.alt = '';
    slot.appendChild(img);
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = entry.eyes ? 'кадр выровнен' : 'глаза не отмечены';
    slot.appendChild(badge);
    $('today-actions').classList.remove('hidden');
    $('btn-camera-label').textContent = 'Переснять';
  } else {
    slot.innerHTML = `<div class="photo-empty">
      <svg viewBox="0 0 24 24" width="42" height="42"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="13.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
      <p>Фото за этот день ещё нет</p></div>`;
    $('today-actions').classList.add('hidden');
    $('btn-camera-label').textContent = 'Снять';
  }

  $('today-comment').value = entry ? (entry.comment || '') : '';
  renderStreak();
}

async function renderStreak() {
  const dates = await entries.allDates();
  if (!dates.length) {
    $('streak').textContent = 'Первый кадр — самый важный.';
    return;
  }
  const set = new Set(dates);
  let cursor = D.todayKey();
  if (!set.has(cursor)) cursor = D.addDays(cursor, -1);
  let run = 0;
  while (set.has(cursor)) { run++; cursor = D.addDays(cursor, -1); }
  const total = dates.length;
  const parts = [`${total} ${D.plural(total, 'день', 'дня', 'дней')} снято`];
  if (run > 1) parts.push(`${run} подряд`);
  $('streak').textContent = parts.join(' · ');
}

async function handlePhotoFile(file, dateKey) {
  if (!file) return;
  progressOpen('Обрабатываю снимок');
  try {
    const { blob, w, h } = await toMaster(file, state.cfg.masterMaxDim, state.cfg.masterQuality);
    progressSet(1, 2);
    const existing = await entries.get(dateKey);
    const entry = {
      date: dateKey,
      photo: blob, w, h,
      comment: existing ? (existing.comment || '') : '',
      eyes: null,                      // фото другое — старая разметка не годится
      createdAt: existing ? existing.createdAt : Date.now(),
      photoAt: Date.now(),             // когда сменился сам снимок, а не запись
    };
    await refreshAligned(entry);
    progressSet(2, 2);
    await entries.put(entry);
  } catch (e) {
    toast(e.message || 'Не получилось прочитать фото');
  } finally {
    progressClose();
  }
  freeUrls();
  await renderToday();
  if (!$('overlay-day').classList.contains('hidden')) await openDay(dateKey);
  syncQuietly();
}

// --- календарь --------------------------------------------------------------

async function renderCalendar() {
  const { calYear: y, calMonth: m } = state;
  $('cal-title').textContent = D.formatMonth(y, m);

  const wd = $('cal-weekdays');
  if (!wd.childElementCount) {
    wd.innerHTML = D.WEEKDAYS_SHORT.map(d => `<div>${d}</div>`).join('');
  }

  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const fromKey = D.toKey(first);
  const toKeyStr = D.toKey(new Date(y, m, daysInMonth));
  const rows = await entries.range(fromKey, toKeyStr);
  const byDate = new Map(rows.map(r => [r.date, r]));

  const grid = $('cal-grid');
  grid.innerHTML = '';
  const lead = D.weekdayMon0(first);
  for (let i = 0; i < lead; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell empty';
    grid.appendChild(cell);
  }

  const today = D.todayKey();
  for (let d = 1; d <= daysInMonth; d++) {
    const key = D.toKey(new Date(y, m, d));
    const entry = byDate.get(key);
    const cell = document.createElement('button');
    cell.className = 'cal-cell';
    cell.dataset.date = key;
    if (key === today) cell.classList.add('is-today');
    if (key > today) cell.classList.add('future');
    if (entry && entry.thumb) {
      cell.classList.add('has-photo');
      const img = document.createElement('img');
      img.src = url(entry.thumb);
      img.alt = '';
      cell.appendChild(img);
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d;
    cell.appendChild(num);
    cell.onclick = () => openDay(key);
    grid.appendChild(cell);
  }

  const total = (await entries.allDates()).length;
  const inMonth = rows.filter(r => r.photo).length;
  $('cal-stats').textContent =
    `${inMonth} ${D.plural(inMonth, 'день', 'дня', 'дней')} в этом месяце · ${total} всего`;
}

// --- карточка дня -----------------------------------------------------------

let dayKey = null;

async function openDay(key) {
  dayKey = key;
  const info = D.dayLabel(key, state.cfg);
  $('day-title').textContent = info.label;
  $('day-sub').textContent = D.formatLong(key) + (info.sub ? ` · ${info.sub}` : '');

  const entry = await entries.get(key);
  const slot = $('day-photo');
  slot.innerHTML = '';

  if (entry && entry.photo) {
    const img = document.createElement('img');
    img.src = url(faceOf(entry));
    img.alt = '';
    slot.appendChild(img);
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = entry.eyes ? 'кадр выровнен' : 'глаза не отмечены';
    slot.appendChild(badge);
    $('day-align').classList.remove('hidden');
    $('day-replace').classList.remove('hidden');
    $('day-add').classList.add('hidden');
    $('day-delete').classList.remove('hidden');
  } else {
    slot.innerHTML = '<div class="photo-empty"><p>За этот день фото нет</p></div>';
    $('day-align').classList.add('hidden');
    $('day-replace').classList.add('hidden');
    $('day-add').classList.remove('hidden');
    $('day-delete').classList.toggle('hidden', !entry);
  }

  $('day-comment').value = entry ? (entry.comment || '') : '';
  $('overlay-day').classList.remove('hidden');
}

function closeDay() {
  clearTimeout(dayCommentTimer);
  if (dayKey) saveComment(dayKey, $('day-comment').value);
  $('overlay-day').classList.add('hidden');
  dayKey = null;
}

async function saveComment(key, text) {
  if (!key) return;
  const existing = await entries.get(key);
  if (!existing && !text.trim()) return;
  const entry = existing || { date: key, comment: '', eyes: null, createdAt: Date.now() };
  entry.comment = text;
  await entries.put(entry);
}

// --- разметка глаз ----------------------------------------------------------

async function openAlign(key) {
  const entry = await entries.get(key);
  if (!entry || !entry.photo) return;

  const img = $('align-img');
  img.src = url(entry.photo);
  $('align-title').textContent = D.dayLabel(key, state.cfg).label;

  state.align = { key, entry, l: entry.eyes ? { x: entry.eyes.lx, y: entry.eyes.ly } : null,
                  r: entry.eyes ? { x: entry.eyes.rx, y: entry.eyes.ry } : null, drag: null };
  drawDots();
  $('overlay-align').classList.remove('hidden');
}

function drawDots() {
  const a = state.align;
  for (const [side, el] of [['l', $('align-dot-l')], ['r', $('align-dot-r')]]) {
    const p = a[side];
    if (!p) { el.classList.add('hidden'); continue; }
    el.classList.remove('hidden');
    el.style.left = p.x * 100 + '%';
    el.style.top = p.y * 100 + '%';
  }
  $('align-hint').textContent = !a.l
    ? 'Ткните в правый глаз ребёнка (тот, что слева на фото).'
    : !a.r ? 'Теперь во второй глаз.'
    : 'Точки можно двигать пальцем. Готово — и кадр встанет как надо.';
}

function bindAlignStage() {
  const stage = $('align-stage');

  const pos = e => {
    const rect = stage.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  stage.addEventListener('pointerdown', e => {
    const a = state.align;
    if (!a) return;
    e.preventDefault();
    const p = pos(e);
    const near = side => a[side] &&
      Math.hypot((a[side].x - p.x) * stage.offsetWidth, (a[side].y - p.y) * stage.offsetHeight) < 28;

    if (near('l')) a.drag = 'l';
    else if (near('r')) a.drag = 'r';
    else if (!a.l) { a.l = p; }
    else if (!a.r) { a.r = p; }
    else return;

    if (a.drag) stage.setPointerCapture(e.pointerId);
    drawDots();
  });

  stage.addEventListener('pointermove', e => {
    const a = state.align;
    if (!a || !a.drag) return;
    e.preventDefault();
    a[a.drag] = pos(e);
    drawDots();
  });

  const end = () => { if (state.align) state.align.drag = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

async function saveAlign() {
  const a = state.align;
  if (!a) return;
  if (!a.l || !a.r) { toast('Нужны обе точки'); return; }

  progressOpen('Пересобираю кадр');
  const entry = await entries.get(a.key);
  entry.eyes = { lx: a.l.x, ly: a.l.y, rx: a.r.x, ry: a.r.y };
  await refreshAligned(entry);
  await entries.put(entry);
  progressClose();

  $('overlay-align').classList.add('hidden');
  state.align = null;
  freeUrls();
  await renderToday();
  if (dayKey) await openDay(dayKey);
  toast('Кадр выровнен');
}

// --- видео ------------------------------------------------------------------

async function videoFrames() {
  const from = $('video-from').value || '0000-01-01';
  const to = $('video-to').value || '9999-12-31';
  const rows = await entries.range(from, to);
  return rows.filter(r => r.aligned).map(r => ({ date: r.date, blob: r.aligned }));
}

async function refreshVideoInfo() {
  const frames = await videoFrames();
  const fps = Number($('video-fps').value);
  const secs = frames.length / fps;
  $('video-info').textContent = frames.length
    ? `${frames.length} ${D.plural(frames.length, 'кадр', 'кадра', 'кадров')} · примерно ${secs.toFixed(1)} с`
    : 'В этом промежутке ещё нет кадров.';
  $('btn-render').disabled = !frames.length;
  $('btn-preview').disabled = !frames.length;
  $('btn-frames-zip').disabled = !frames.length;
}

async function previewVideo() {
  const frames = await videoFrames();
  if (!frames.length) return;
  $('video-result').classList.add('hidden');
  $('video-canvas').classList.remove('hidden');

  if (state.previewAbort) state.previewAbort.abort();
  const ctrl = new AbortController();
  state.previewAbort = ctrl;

  $('btn-preview').textContent = 'Стоп';
  await playFrames(frames, $('video-canvas'), Number($('video-fps').value), { signal: ctrl.signal });
  $('btn-preview').textContent = 'Посмотреть';
  if (state.previewAbort === ctrl) state.previewAbort = null;
}

async function renderVideo() {
  const frames = await videoFrames();
  if (!frames.length) return;
  if (!videoSupported()) {
    toast('Этот браузер не умеет записывать видео — выгрузите кадры в ZIP');
    return;
  }
  progressOpen('Собираю видео');
  try {
    const fps = Number($('video-fps').value);
    const { blob, ext } = await buildVideo(frames, { fps, size: state.cfg.videoSize },
      (d, t) => progressSet(d, t, 'Собираю видео'));
    state.video = { blob, ext };
    const v = $('video-result');
    v.src = url(blob);
    v.classList.remove('hidden');
    $('video-canvas').classList.add('hidden');
    $('btn-save-video').classList.remove('hidden');
    toast('Готово');
  } catch (e) {
    toast(e.message || 'Не удалось собрать видео');
  } finally {
    progressClose();
  }
}

async function framesToZip() {
  const frames = await videoFrames();
  if (!frames.length) return;
  progressOpen('Пакую кадры');
  const files = frames.map((f, i) => ({
    name: `frames/${String(i + 1).padStart(4, '0')}_${f.date}.jpg`,
    data: f.blob,
  }));
  files.push({
    name: 'frames/КАК-СОБРАТЬ.txt',
    data: 'Кадры уже выровнены по глазам и пронумерованы по порядку.\n\n' +
          'Собрать видео из них можно одной командой:\n\n' +
          '  ffmpeg -framerate 8 -pattern_type glob -i "*.jpg" -c:v libx264 -pix_fmt yuv420p timelapse.mp4\n',
  });
  const zip = await createZip(files, (d, t) => progressSet(d, t));
  progressClose();
  await saveBlob(zip, `kadry-${D.todayKey()}.zip`);
}

// --- настройки --------------------------------------------------------------

function eyeTargetFrom(yPct, dPct) {
  const y = yPct / 100, d = dPct / 100;
  return { lx: 0.5 - d / 2, ly: y, rx: 0.5 + d / 2, ry: y };
}

async function renderMore() {
  const cfg = state.cfg;
  await renderGoogleCard();
  $('set-name').value = cfg.babyName || '';
  $('set-birth').value = cfg.birthDate || '';
  $('set-due').value = cfg.dueDate || '';
  $('set-size').value = cfg.videoSize;
  $('size-label').textContent = cfg.videoSize;

  const yPct = Math.round(cfg.eyeTarget.ly * 100);
  const dPct = Math.round((cfg.eyeTarget.rx - cfg.eyeTarget.lx) * 100);
  $('set-eyey').value = yPct; $('eyey-label').textContent = yPct;
  $('set-eyed').value = dPct; $('eyed-label').textContent = dPct;

  const last = cfg.lastExportAt;
  const total = await entries.count();
  if (!last) {
    $('export-status').textContent = total
      ? 'Архив ещё ни разу не выгружали. Самое время.'
      : 'Пока нечего выгружать.';
  } else {
    const days = Math.floor((Date.now() - last) / D.MS_DAY);
    $('export-status').textContent = days === 0
      ? 'Последняя выгрузка — сегодня.'
      : `Последняя выгрузка ${days} ${D.plural(days, 'день', 'дня', 'дней')} назад.`;
  }

  const est = await storageEstimate();
  const persisted = navigator.storage && navigator.storage.persisted
    ? await navigator.storage.persisted() : false;
  $('storage-status').textContent = est
    ? `Занято ${formatBytes(est.usage)} из ${formatBytes(est.quota)}. ` +
      (persisted ? 'Данные защищены от автоочистки.' : 'Защита от автоочистки не включена.')
    : 'Браузер не сообщает объём хранилища.';
  $('btn-persist').disabled = persisted;
}

async function rebuildAll() {
  const dates = await entries.allDates();
  progressOpen('Пересобираю кадры');
  for (let i = 0; i < dates.length; i++) {
    const e = await entries.get(dates[i]);
    if (e && e.photo) {
      await refreshAligned(e);
      await entries.put(e);
    }
    progressSet(i + 1, dates.length);
  }
  progressClose();
  toast('Кадры пересобраны');
}

// --- навигация --------------------------------------------------------------

async function showScreen(name) {
  freeUrls();
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $('screen-' + name).classList.remove('hidden');
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('tab-active', t.dataset.screen === name);
  }
  window.scrollTo(0, 0);
  if (name === 'today') await renderToday();
  if (name === 'calendar') await renderCalendar();
  if (name === 'video') await initVideoScreen();
  if (name === 'more') await renderMore();
}

async function initVideoScreen() {
  const dates = await entries.allDates();
  if (dates.length) {
    if (!$('video-from').value) $('video-from').value = dates[0];
    if (!$('video-to').value) $('video-to').value = dates[dates.length - 1];
  }
  await refreshVideoInfo();
}

// --- привязка событий -------------------------------------------------------

function bind() {
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => showScreen(t.dataset.screen);
  }
  $('today-prev-day').onclick = () => showScreen('calendar');

  // фото
  let pendingDate = null;
  $('btn-camera').onclick = () => { pendingDate = D.todayKey(); $('file-camera').click(); };
  $('btn-library').onclick = () => { pendingDate = D.todayKey(); $('file-input').click(); };
  $('day-replace').onclick = () => { pendingDate = dayKey; $('file-input').click(); };
  $('day-add').onclick = () => { pendingDate = dayKey; $('file-input').click(); };

  const onPick = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file && pendingDate) await handlePhotoFile(file, pendingDate);
    if (!$('screen-calendar').classList.contains('hidden')) await renderCalendar();
  };
  $('file-input').onchange = onPick;
  $('file-camera').onchange = onPick;

  // комментарии
  $('today-comment').oninput = e => {
    clearTimeout(todayCommentTimer);
    const v = e.target.value;
    todayCommentTimer = setTimeout(() => saveComment(D.todayKey(), v), 500);
  };
  $('day-comment').oninput = e => {
    clearTimeout(dayCommentTimer);
    const v = e.target.value, key = dayKey;
    dayCommentTimer = setTimeout(() => saveComment(key, v), 500);
  };

  $('btn-align').onclick = () => openAlign(D.todayKey());
  $('day-align').onclick = () => openAlign(dayKey);
  $('align-close').onclick = () => { $('overlay-align').classList.add('hidden'); state.align = null; };
  $('align-reset').onclick = () => { state.align.l = null; state.align.r = null; drawDots(); };
  $('align-save').onclick = saveAlign;
  bindAlignStage();

  const removeDay = async key => {
    const ok = await ask({
      title: 'Удалить этот день?',
      text: 'Фотография и комментарий пропадут с телефона. ' +
            'В папке на Диске файл останется.',
    });
    if (!ok) return;

    // Гасим всё, что может дописать комментарий обратно: отложенные сохранения
    // и то, что делает закрытие карточки. Иначе только что удалённый день
    // воскресает записью без фотографии.
    clearTimeout(dayCommentTimer);
    clearTimeout(todayCommentTimer);
    dayKey = null;
    $('day-comment').value = '';
    $('today-comment').value = '';

    await entries.delete(key);
    freeUrls();
    closeDay();
    await renderToday();
    if (!$('screen-calendar').classList.contains('hidden')) await renderCalendar();
    toast('Удалено');
  };
  $('btn-delete').onclick = () => removeDay(D.todayKey());
  $('day-delete').onclick = () => removeDay(dayKey);
  $('day-close').onclick = closeDay;
  $('overlay-day').onclick = e => { if (e.target === $('overlay-day')) closeDay(); };

  // календарь
  $('cal-prev').onclick = () => {
    if (--state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
    freeUrls(); renderCalendar();
  };
  $('cal-next').onclick = () => {
    if (++state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
    freeUrls(); renderCalendar();
  };

  // видео
  $('video-fps').oninput = e => { $('fps-label').textContent = e.target.value; refreshVideoInfo(); };
  $('video-from').onchange = refreshVideoInfo;
  $('video-to').onchange = refreshVideoInfo;
  $('btn-preview').onclick = () => {
    if (state.previewAbort) { state.previewAbort.abort(); state.previewAbort = null;
      $('btn-preview').textContent = 'Посмотреть'; return; }
    previewVideo();
  };
  $('btn-render').onclick = renderVideo;
  $('btn-frames-zip').onclick = framesToZip;
  $('btn-save-video').onclick = async () => {
    if (!state.video) return;
    const name = `${state.cfg.babyName || 'timelapse'}-${D.todayKey()}.${state.video.ext}`;
    const how = await saveBlob(state.video.blob, name);
    if (how === 'downloaded') toast('Файл сохранён в «Загрузки»');
  };

  // настройки
  const saveField = (id, key, transform = v => v || null) =>
    $(id).onchange = async e => {
      await settings.set(key, transform(e.target.value));
      state.cfg = await settings.all();
      toast('Сохранено');
    };
  saveField('set-name', 'babyName', v => v.trim());
  saveField('set-birth', 'birthDate');
  saveField('set-due', 'dueDate');

  $('set-size').oninput = e => { $('size-label').textContent = e.target.value; };
  $('set-size').onchange = async e => {
    await settings.set('videoSize', Number(e.target.value));
    state.cfg = await settings.all();
    $('video-canvas').width = $('video-canvas').height = 540;
  };
  const onEye = async () => {
    $('eyey-label').textContent = $('set-eyey').value;
    $('eyed-label').textContent = $('set-eyed').value;
    await settings.set('eyeTarget',
      eyeTargetFrom(Number($('set-eyey').value), Number($('set-eyed').value)));
    state.cfg = await settings.all();
  };
  $('set-eyey').oninput = () => { $('eyey-label').textContent = $('set-eyey').value; };
  $('set-eyed').oninput = () => { $('eyed-label').textContent = $('set-eyed').value; };
  $('set-eyey').onchange = onEye;
  $('set-eyed').onchange = onEye;
  $('btn-rebuild').onclick = rebuildAll;

  $('btn-save-code').onclick = async () => {
    const code = $('set-code').value.trim();
    if (!code) {
      await settings.merge({ lockHash: null, lockSalt: null });
      toast('Блокировка выключена');
    } else if (code.length < 4) {
      toast('Минимум 4 цифры'); return;
    } else {
      const { hash, salt } = await hashCode(code);
      await settings.merge({ lockHash: hash, lockSalt: salt });
      toast('Код сохранён');
    }
    $('set-code').value = '';
    state.cfg = await settings.all();
  };

  // Google
  $('btn-wizard').onclick = async () => {
    await runOnboarding({ onToast: toast });
    state.cfg = await settings.all();
    freeUrls();
    await renderMore();
    await renderToday();
  };

  $('btn-google-connect').onclick = async () => {
    try {
      const { accessToken } = await G.requestToken({ interactive: true });
      const me = await G.fetchUserInfo(accessToken);
      if (!G.emailAllowed(me.email)) { G.forget(); toast('Этот аккаунт в список не входит'); return; }
      await settings.set('driveEmail', me.email);
      state.cfg = await settings.all();
      await renderGoogleCard();
      await runSync();
    } catch (e) {
      toast(e.message || 'Не получилось подключить Google');
    }
  };

  $('btn-sync').onclick = runSync;

  $('btn-pick-folder').onclick = async () => {
    try {
      const token = await G.getAccessToken({ interactive: true });
      const folder = await pickFolder(token);
      if (!folder) return;
      await drive().adoptRoot(folder.id);
      await settings.merge({ driveFolderId: folder.id, driveFolderName: folder.name });
      state.cfg = await settings.all();
      toast(`Папка «${folder.name}» подключена`);
      await runSync();
    } catch (e) {
      toast(e.message || 'Не удалось выбрать папку');
    }
  };

  $('btn-google-off').onclick = async () => {
    const ok = await ask({
      title: 'Отключить Google?',
      text: 'Фотографии и комментарии останутся и на телефоне, и в папке Диска. ' +
            'Синхронизация просто остановится.',
      yes: 'Отключить',
    });
    if (!ok) return;
    await G.revoke();
    await settings.merge({ driveEmail: null });
    state.cfg = await settings.all();
    await renderGoogleCard();
    toast('Google отключён');
  };

  $('btn-persist').onclick = async () => {
    const ok = await requestPersistence();
    toast(ok ? 'Данные защищены' : 'Браузер отказал — выгружайте архив почаще');
    await renderMore();
  };

  $('btn-export').onclick = async () => {
    const total = await entries.count();
    if (!total) { toast('Пока нечего выгружать'); return; }
    progressOpen('Собираю архив');
    try {
      const zip = await exportArchive((d, t, label) => progressSet(d, t, label));
      progressClose();
      const name = `${state.cfg.babyName || 'archive'}-${D.todayKey()}.zip`;
      const how = await saveBlob(zip, name);
      if (how === 'downloaded') toast('Архив сохранён в «Загрузки»');
      state.cfg = await settings.all();
      await renderMore();
    } catch (e) {
      progressClose();
      toast(e.message || 'Не удалось собрать архив');
    }
  };

  $('btn-import').onclick = () => $('zip-input').click();
  $('zip-input').onchange = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    progressOpen('Читаю архив');
    try {
      const res = await importArchive(file, { replace: false },
        (d, t, label) => progressSet(d, t, label));
      progressClose();
      toast(`Добавлено дней: ${res.added}` + (res.skipped ? `, пропущено: ${res.skipped}` : ''));
      await renderMore();
    } catch (err) {
      progressClose();
      toast(err.message || 'Не удалось прочитать архив');
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('screen-today').classList.contains('hidden')) renderToday();
  });
}

// --- запуск -----------------------------------------------------------------

/**
 * Полный сброс по адресу ?reset — нужен, когда приложение уже установлено на
 * телефон и до хранилища браузера просто так не добраться. Спрашиваем
 * подтверждение: за этой кнопкой все фотографии.
 */
async function maybeReset() {
  if (!new URLSearchParams(location.search).has('reset')) return false;
  const total = await entries.count();
  const ok = await ask({
    title: 'Стереть всё на этом устройстве?',
    text: `Дней в приложении: ${total}. На Google Диске всё останется — ` +
          'после нового входа они вернутся оттуда.',
    yes: 'Стереть',
  });
  if (!ok) {
    history.replaceState(null, '', location.pathname);
    return false;
  }
  G.forget();
  try { localStorage.clear(); } catch { /* приватный режим */ }
  await new Promise(resolve => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  location.replace(location.pathname);
  return true;
}

async function boot() {
  if (await maybeReset()) return;

  // Регистрируем раньше всего остального: онбординг может занять минуты, и всё
  // это время приложение оставалось бы без офлайновой оболочки. Путь
  // относительный — приложение может лежать и в подпапке (GitHub Pages).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  state.cfg = await settings.all();

  if (state.cfg.lockHash) await askCode();

  // Настройка проходится один раз. Дальше приложение открывается офлайн:
  // иначе оно не работало бы там, где чаще всего и снимают, — в самолёте,
  // в роддоме, на даче без связи.
  let justSetUp = false;
  if (!state.cfg.onboardingDone || !state.cfg.birthDate) {
    await runOnboarding({ onToast: toast });
    state.cfg = await settings.all();
    justSetUp = true;
  }

  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();

  bind();
  $('app').classList.remove('hidden');
  await showScreen('today');

  requestPersistence().catch(() => {});

  // Сразу после настройки история тянется на виду, с прогрессом: человек должен
  // попасть в заполненное приложение, а не в пустое, которое молча догружается.
  if (justSetUp && configured() && state.cfg.driveEmail) await runSync();
  else syncQuietly();

  window.addEventListener('online', syncQuietly);
}

boot();
