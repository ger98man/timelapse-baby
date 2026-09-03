import { entries, blobs, settings, DB_NAME } from './db.js';
import * as D from './dates.js';
import { formatBytes, loadImage, makeCanvas, canvasToBlob } from './img.js';
import { drawAligned, renderSquareBlob } from './align.js';
import { createGhostCamera, cameraError } from './ghost.js';
import { buildVideo, videoSupported, pickMime, drawCaption } from './video.js';
import { exportArchive, importArchive } from './archive.js';
import { pushProfile } from './profile.js';
import { createZip } from './zip.js';
import { GOOGLE, configured, pickerReady } from '../config.js';
import { runOnboarding } from './onboarding.js';
import * as G from './google.js';
import { createDrive, rootName } from './drive.js';
import * as store from './store.js';
import { pickFolder } from './picker.js';

const $ = id => document.getElementById(id);

// Сторона миниатюры, которую просим у Диска для показа. Столько же, сколько у
// холста предпросмотра: одна ссылка обслуживает и карточку дня, и таймлапс.
const THUMB_VIEW = 540;

// Сторона миниатюры для клетки календаря. Клетка на телефоне около 48 точек,
// но экран у него тройной плотности — отсюда 160, а не 48.
const CAL_THUMB = 160;
const state = {
  cfg: null,
  calYear: 0,
  calMonth: 0,
  urls: [],          // объектные URL текущего экрана, чтобы не течь памятью
  align: null,       // контекст оверлея разметки глаз
  ghost: null,       // живая камера, пока открыт её оверлей
  conn: { status: 'unknown', email: '', note: '' },   // связь с Google
  connAt: 0,         // когда её проверяли в последний раз
  screen: null,      // какой экран открыт — чтобы знать, с какого уходим
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

/**
 * @param {string} text
 * @param {number} ms сколько висеть
 * @param {?{label:string, run:Function}} action кнопка справа — для «Вернуть»
 */
function toast(text, ms = 2600, action = null) {
  const el = $('toast');
  const btn = $('toast-action');
  $('toast-text').textContent = text;
  btn.classList.toggle('hidden', !action);
  btn.textContent = action ? action.label : '';
  btn.onclick = action
    ? () => { el.classList.add('hidden'); clearTimeout(toastTimer); action.run(); }
    : null;
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
 *
 * @param {{inputs?:Array<{key:string,label:string,type?:string,value?:string}>}} opts
 *        inputs — диалог не подтверждает, а спрашивает: тогда «да» приносит
 *        объект с ответами, а не true. Отмена всегда false, чтобы у зовущего
 *        была одна проверка на оба случая.
 */
function ask({ title, text = '', items = [], inputs = [],
               yes = 'Удалить', no = 'Отмена', danger = true }) {
  return new Promise(resolve => {
    const box = $('ask');
    $('ask-title').textContent = title;
    $('ask-text').textContent = text;
    $('ask-text').classList.toggle('hidden', !text);
    // Список фактов о том, что сейчас произойдёт: собираем узлами, а не
    // разметкой строкой — в значения попадают имя ребёнка и имя файла.
    const list = $('ask-list');
    list.textContent = '';
    for (const [label, value] of items) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = label;
      span.append(b, ' — ' + value);
      li.append(span);
      list.append(li);
    }
    list.classList.toggle('hidden', !items.length);

    const fields = $('ask-fields');
    fields.textContent = '';
    const boxes = new Map();
    for (const f of inputs) {
      const label = document.createElement('label');
      label.className = 'field';
      const span = document.createElement('span');
      span.textContent = f.label;
      const input = document.createElement('input');
      input.type = f.type || 'text';
      input.value = f.value || '';
      label.append(span, input);
      fields.append(label);
      boxes.set(f.key, input);
    }
    fields.classList.toggle('hidden', !inputs.length);

    $('ask-yes').textContent = yes;
    $('ask-yes').classList.toggle('btn-danger', danger);
    $('ask-yes').classList.toggle('btn-primary', !danger);
    $('ask-no').textContent = no;
    box.classList.remove('hidden');

    const close = answer => {
      box.classList.add('hidden');
      $('ask-yes').onclick = $('ask-no').onclick = box.onclick = null;
      resolve(answer);
    };
    const answers = () => {
      const out = {};
      for (const [key, input] of boxes) out[key] = input.value.trim();
      return out;
    };
    $('ask-yes').onclick = () => close(inputs.length ? answers() : true);
    $('ask-no').onclick = () => close(false);
    box.onclick = e => { if (e.target === box) close(false); };
    if (inputs.length) boxes.values().next().value.focus();
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

async function saveBlob(blob, filename, title = filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
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

/**
 * Что показывать человеку. С отмеченными глазами — выровненный кадр: на экране
 * должно быть ровно то, что попадёт в таймлапс. Снимков на телефоне не
 * хранится, поэтому показывать нечего, пока день не загружен из папки.
 */
function faceOf(entry, body) {
  if (body && body.photo) return entry.eyes && body.aligned ? body.aligned : body.photo;
  return null;
}

/** Рисует снимок дня в слоте: сам кадр и подпись под ним. */
function paintPhoto(slotId, entry, body) {
  const slot = $(slotId);
  slot.innerHTML = '';
  const face = faceOf(entry, body);
  if (face) {
    const img = document.createElement('img');
    img.src = url(face);
    img.alt = '';
    slot.appendChild(img);
  } else if (canPull()) {
    showThumb(slot, entry);      // не ждём: приедет — дорисуется
  }
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = !body
    ? (canPull() ? 'загружаю снимок…' : 'снимок не загружен на этот телефон')
    : entry.eyes ? 'кадр выровнен' : 'глаза не отмечены';
  slot.appendChild(badge);
}

/**
 * Пока оригинал едет из папки, показываем миниатюру, которую Google сделал
 * сам: она стоит килобайты и приезжает мгновенно, а оригинал — мегабайт и
 * секунды. Раньше на это время в карточке был пустой квадрат.
 *
 * Рисуем тем же расчётом, что и настоящий кадр, поэтому подмена на оригинал
 * не дёргает картинку: глаза уже стоят на своих местах.
 */
async function showThumb(slot, entry) {
  let link;
  try {
    link = await store.thumbUrl(drive(), entry.date, { size: THUMB_VIEW });
  } catch {
    return;                      // нет миниатюры — останется пустой квадрат
  }
  // Пока ходили за ссылкой, слот могли перерисовать или оригинал мог доехать.
  if (!link || !slot.isConnected || slot.querySelector('img, canvas')) return;

  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('миниатюра не открылась'));
      img.src = link;
    });
  } catch {
    return;
  }
  if (!slot.isConnected || slot.querySelector('img, canvas')) return;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = THUMB_VIEW;
  drawAligned(canvas.getContext('2d'), img, img.naturalWidth, img.naturalHeight,
    THUMB_VIEW, entry.eyes, state.cfg.eyeTarget);
  slot.insertBefore(canvas, slot.firstChild);
}

/** Есть ли откуда качать: папка подключена и сеть на месте. */
function canPull() {
  return Boolean(configured() && state.cfg.driveEmail && navigator.onLine);
}

/**
 * Подтягивает комментарий, если его правили с другого телефона. Он крошечный,
 * поэтому его ждут на месте, а не подменяют текст под руками у человека.
 */
async function pullNote(key) {
  if (!canPull()) return null;
  try {
    return await store.ensureNote(drive(), key);
  } catch {
    return null;      // покажем ту копию, что есть
  }
}

/**
 * Дотягивает снимок за день. Тела качаются по требованию, поэтому экран сначала
 * рисуется по тому, что уже есть, и только потом обновляется настоящим кадром.
 * @returns {Promise<boolean>} появилось ли что-то новое
 */
async function pullBody(key, { silent = true } = {}) {
  if (!canPull()) return false;
  try {
    return Boolean(await store.ensureBody(drive(), key, { cfg: state.cfg }));
  } catch (e) {
    if (!silent) toast(e.message || 'Не удалось загрузить снимок');
    return false;
  }
}

// --- Google -----------------------------------------------------------------

/** Диск создаётся лениво: без интернета и без токена он и не нужен. */
function drive() {
  return createDrive({ getToken: opts => G.getAccessToken({ interactive: false, ...opts }) });
}

/** Обновление из папки — с прогрессом и внятным итогом. */
async function runSync() {
  if (!configured()) { toast('Google не настроен'); return; }
  progressOpen('Обновляю из папки');
  try {
    await G.getAccessToken({ interactive: true });
    const res = await store.refresh(drive(), {
      onProgress: (d, t, label) => progressSet(d, t, label),
    });
    progressClose();
    setConn('ok', state.cfg.driveEmail, 'Подключен к Google');
    const parts = [];
    if (res.added) parts.push(`новых дней: ${res.added}`);
    if (res.changed) parts.push(`обновлено: ${res.changed}`);
    if (res.dropped) parts.push(`удалено: ${res.dropped}`);
    toast(parts.length ? parts.join(', ') : 'Всё уже на месте');
    await ensureSharedProfile();
    state.cfg = await settings.all();
    applyTheme(state.cfg.theme);
    freeUrls();
    await renderToday();
    if (!$('screen-calendar').classList.contains('hidden')) await renderCalendar();
    await renderMore();
  } catch (e) {
    progressClose();
    // Папка пропала (удалили, переименовали, вошли другим аккаунтом) —
    // отправлять человека искать её самому незачем, спрашиваем прямо здесь.
    if (e && e.code === 'no-folder' && await ensureAlbumFolder()) return runSync();
    toast(e.message || 'Не удалось обновить из папки');
    await checkConnection();      // не вышло — полоска должна честно покраснеть
  }
}

/**
 * Любая правка уезжает прямо в общую папку, поэтому без сети её делать нельзя:
 * иначе два телефона расходятся, и потом непонятно, чья версия настоящая.
 * Пока Диск не подключён, приложение работает локально и это правило не нужно.
 */
function online() {
  return !state.cfg.driveEmail || navigator.onLine;
}

function requireOnline() {
  if (online()) return true;
  toast('Нет сети. Снимите обычной камерой и добавьте кадр из галереи позже', 4200);
  return false;
}

/** Блокирует всё, чем можно что-то изменить, пока нет сети. */
function applyOnlineState() {
  const can = online();
  for (const id of ['btn-camera', 'btn-library', 'btn-ghost', 'btn-align', 'btn-delete',
                    'day-align', 'day-replace', 'day-add', 'day-delete']) {
    const el = $(id);
    if (el) el.disabled = !can;
  }
  $('today-comment').disabled = !can;
  $('day-comment').disabled = !can;
  $('offline-note').classList.toggle('hidden', can);
}

/** Тихая попытка после съёмки: получилось — хорошо, нет — не мешаем. */
/**
 * Кладёт config.json в папку, если его там ещё нет.
 *
 * Второй родитель читает имя и дату оттуда, а до сих пор файл появлялся
 * только у того, кто заходил в настройки и что-нибудь менял. Пустой экран
 * «Про кого снимаем» у подключившегося к общей папке — как раз этот случай.
 * profileFileId проставляет чтение описи: пусто — значит, в папке файла нет.
 */
async function ensureSharedProfile() {
  const c = await settings.all();
  if (!c.birthDate || c.profileFileId || !c.driveFolderId || !navigator.onLine) return;
  try { await pushProfile(drive()); }
  catch { /* не вышло сейчас — попробуем при следующем обновлении */ }
}

function syncQuietly() {
  if (!configured() || !state.cfg.autoSync || !state.cfg.driveEmail) return;
  if (!navigator.onLine) return;
  store.refresh(drive())
    .then(ensureSharedProfile)
    .then(() => settings.all())
    .then(c => {
      state.cfg = c;
      applyTheme(c.theme);
      if (state.conn.status !== 'ok') setConn('ok', c.driveEmail, 'Подключен к Google');
      if (!$('screen-calendar').classList.contains('hidden')) return renderCalendar();
    })
    .catch(e => {
      // Единственное, о чём тихая попытка молчать не имеет права: папки нет,
      // а значит снятому сегодня некуда деться. Спрашиваем сразу.
      if (e && e.code === 'no-folder') {
        return ensureAlbumFolder().then(ok => { if (ok) syncQuietly(); });
      }
      return checkConnection().catch(() => { /* обновится при следующей возможности */ });
    });
}

// --- связь с Google: полоска в шапке и проверка на входе ---------------------

const ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.6 4.5L19 7.5" ' +
  'fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Плей и стоп для кнопки у дат: одна кнопка, два состояния — «показать» и
// «хватит», третьего у неё нет.
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linejoin="round"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path d="M7.6 7.6h8.8v8.8h-8.8z" fill="currentColor" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linejoin="round"/></svg>';

const ICON_BAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" ' +
  'fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';

/**
 * Живая проверка связи. Смотреть на срок годности сохранённого токена мало:
 * доступ отзывают в настройках Google, пароль меняют, а токен всё ещё «свежий».
 * Поэтому спрашиваем у Google, кто мы, — заодно узнаём почту.
 * @returns {Promise<{email:string}|null>} null — связи нет
 */
async function pingGoogle() {
  const stored = G.currentToken();
  if (stored) {
    try { return await G.fetchUserInfo(stored.accessToken); }
    catch { G.forget(); }     // токен мёртв — выбрасываем, чтобы не носить его дальше
  }
  // Одна тихая попытка получить новый: если сессия Google в браузере жива,
  // человек ничего не заметит.
  try {
    const t = await G.requestToken({ interactive: false });
    return await G.fetchUserInfo(t.accessToken);
  } catch {
    return null;
  }
}

function setConn(status, email, note) {
  state.conn = { status, email, note };
  state.connAt = Date.now();
  renderConn();
  return state.conn;
}

/**
 * @returns {Promise<{status:string,email:string,note:string}>}
 *   ok — Google отвечает; bad — не отвечает или доступ отозван;
 *   off — аккаунт вообще не подключён (приложение живёт локально).
 */
async function checkConnection() {
  const cfg = state.cfg;
  if (!configured()) return setConn('none', '', '');
  if (!cfg.driveEmail) return setConn('off', '', 'Google не подключён');
  if (!navigator.onLine) return setConn('bad', cfg.driveEmail, 'нет сети');

  const me = await pingGoogle();
  if (!me) return setConn('bad', cfg.driveEmail, 'нет доступа');

  // Вошли другой почтой — в полоске должна быть та, что на самом деле.
  if (me.email && me.email !== cfg.driveEmail) {
    await settings.set('driveEmail', me.email);
    state.cfg = await settings.all();
  }
  return setConn('ok', me.email || cfg.driveEmail, 'Подключен к Google');
}

/**
 * Имя папки для показа — без приписки с почтой владельца.
 *
 * Приписка нужна ровно в одном месте: в окне выбора Google, где своя папка и
 * общая иначе неразличимы. На наших экранах она только съедает строку — почта
 * владельца и так стоит рядом, своя в полоске связи, чужая под именем альбома.
 */
function folderLabel(name) {
  return String(name || '').split(' — ')[0].trim();
}

/** Куда уходит снятое — «дом / альбом», обе части без приписок. */
function albumPath(cfg) {
  const album = folderLabel(cfg.driveFolderName);
  if (!album) return '';
  const home = folderLabel(cfg.homeFolderName);
  return cfg.homeFolderId && home ? `${home} / ${album}` : album;
}

function renderConn() {
  const bar = $('conn');
  const { status, email, note } = state.conn;

  // Сборка без ключа Google — полоски нет: обещать в ней нечего.
  const visible = status !== 'none';
  bar.classList.toggle('hidden', !visible);
  document.body.classList.toggle('has-conn', visible);
  if (!visible) return;

  const ok = status === 'ok';
  $('conn-mark').className = 'conn-mark ' + (ok ? 'ok' : 'bad');
  $('conn-mark').innerHTML = ok ? ICON_OK : ICON_BAD;
  $('conn-email').textContent = email || 'Google не подключён';

  // Когда связь есть, «Подключен к Google» пересказывает зелёную галочку.
  // Место дороже: детей и общих папок теперь несколько, и с любого экрана
  // надо видеть, в чью папку и на кого уходит снимок, а не вспоминать.
  const path = albumPath(state.cfg);
  const tail = ok && path ? path : note;
  $('conn-note').textContent = email ? '· ' + tail : '';
  bar.title = ok
    ? `${email} — снятое уезжает в «${path || 'папку'}»`
    : note;

  // Без сети переподключаться некуда: окно Google просто не откроется.
  // Связь вернётся — полоска позеленеет сама, кнопка тут только мешала бы.
  const fix = $('conn-fix');
  const offer = !ok && navigator.onLine;
  fix.classList.toggle('hidden', !offer);
  fix.textContent = email ? 'Переподключить' : 'Подключить';
  bar.classList.toggle('has-fix', offer);
}

// Папка года внутри альбома: в окне Google легко провалиться внутрь и выбрать
// её. Тогда «альбомом» стала бы она, а настройки и прошлые годы остались бы
// снаружи. Имена там всегда числовые, это и ловим.
const YEAR_FOLDER = 'Это папка года внутри альбома, а нужна папка альбома ' +
  'целиком — та, что подписана почтой.';
const yearFolder = name => /^\d{1,4}$/.test(String(name).trim());

// Свои ошибки окно Google показывает внутри себя и наружу не отдаёт, поэтому
// про самую частую говорим сами: догадаться про неё нельзя, а чинится она в
// консоли за минуту.
const PICKER_HINT =
  'Папку не выбрали. Если вместо списка папок Google показал «The API developer ' +
  'key is invalid» — в проекте не включён Google Picker API или ключ ограничен по сайту.';

/**
 * Спрашивает, кто пришёл, и заводит либо подключает папку.
 *
 * Молча создавать её нельзя: у второго родителя рядом с общим альбомом
 * появится свой пустой, он начнёт снимать туда и узнает об этом нескоро.
 * @returns {Promise<boolean>} появилась ли папка
 */
async function askWhoYouAre() {
  const box = $('folder-gate');
  const err = $('folder-gate-error');
  const create = $('folder-gate-create');
  const pick = $('folder-gate-pick');
  err.textContent = '';
  // Без Picker API выбрать чужую папку нечем — предлагать нечестно.
  pick.classList.toggle('hidden', !pickerReady());
  box.classList.remove('hidden');

  const got = await new Promise(resolve => {
    const busy = on => { create.disabled = on; pick.disabled = on; };
    create.onclick = async () => {
      err.textContent = '';
      busy(true);
      try {
        const root = await createFirstAlbum();
        if (!root) return;                 // передумали — окно остаётся
        toast(`Папка «${root.name}» создана`);
        resolve(true);
      } catch (e) {
        err.textContent = e.message || 'Не удалось создать папку';
      } finally {
        busy(false);
      }
    };
    pick.onclick = async () => {
      err.textContent = '';
      busy(true);
      try {
        const folder = await pickShared(t => { err.textContent = t; });
        if (folder) {
          toast(`Папка «${folder.name}» подключена`);
          resolve(true);
        }
      } catch (e) {
        err.textContent = e.message || 'Не удалось выбрать папку';
      } finally {
        busy(false);
      }
    };
    $('folder-gate-later').onclick = () => resolve(false);
  });

  box.classList.add('hidden');
  create.onclick = pick.onclick = $('folder-gate-later').onclick = null;
  state.cfg = await settings.all();
  return got;
}

/**
 * Папка альбома сразу после входа: ищем её в Диске, а если не нашли —
 * спрашиваем, первый родитель пришёл или уже второй. Раньше это умел только
 * мастер настройки, и попасть туда можно было лишь кнопкой в «Настройках».
 * @returns {Promise<boolean>} есть ли теперь папка
 */
async function ensureAlbumFolder() {
  if (!configured() || !state.cfg.driveEmail) return false;
  let home, root;
  try {
    // Дом и альбом ищем вместе: у второго родителя дома нет вовсе, а у
    // первого альбом лежит внутри дома, и знать надо про оба.
    home = await drive().findHome(state.cfg.homeFolderId);
    root = await drive().findRoot(state.cfg.driveFolderId);
  } catch (e) {
    // Не дозвонились до Диска — предлагать «завести папку» тут нельзя:
    // именно так рядом со старым альбомом и появляется второй.
    toast(e.message || 'Google Диск не ответил');
    return false;
  }

  const patch = {};
  if (home) {
    const name = await drive().nameHome(home, state.cfg.driveEmail);
    if (home.id !== state.cfg.homeFolderId) patch.homeFolderId = home.id;
    if (name !== state.cfg.homeFolderName) patch.homeFolderName = name;
  }
  if (root) {
    if (root.id !== state.cfg.driveFolderId) patch.driveFolderId = root.id;
    if (root.name !== state.cfg.driveFolderName) patch.driveFolderName = root.name;
  }
  if (Object.keys(patch).length) {
    await settings.merge(patch);
    state.cfg = await settings.all();
  }
  // Дом без единого альбома — то же самое, что и вовсе без папок: снимать
  // некуда. Спрашиваем, кто пришёл, — заведение дома там уже учтено.
  return root ? true : askWhoYouAre();
}

/**
 * Запоминает дом, в котором мы теперь живём. Метку ставим и на чужой: она
 * приватная, владельцу от неё ни холодно ни жарко, а нам по ней потом искать
 * этот дом с другого телефона.
 */
async function useHome(home) {
  await drive().adoptHome(home.id);
  await settings.merge({ homeFolderId: home.id, homeFolderName: home.name });
  state.cfg = await settings.all();
  return home.id;
}

/**
 * Дом: найти или завести. Заводится он ровно там, где человек сказал «альбом
 * заведу я», — и вместе с первым альбомом, потому что дом без альбомов
 * бесполезен.
 */
async function ensureOwnHome() {
  const found = await drive().findHome(state.cfg.homeFolderId);
  const home = found
    || await drive().createHome(rootName(GOOGLE.folderName, state.cfg.driveEmail));
  const name = found ? await drive().nameHome(home, state.cfg.driveEmail) : home.name;
  await settings.merge({ homeFolderId: home.id, homeFolderName: name });
  state.cfg = await settings.all();
  return home.id;
}

/**
 * Первый альбом: дом плюс папка ребёнка внутри него.
 *
 * Имя и дату спрашиваем до создания, как и при заведении второго альбома:
 * папку человек потом ищет в Диске глазами, и «Малыш» среди прочих папок
 * ему ничего не говорит, а без даты рождения нечем считать дни.
 *
 * @returns {Promise<?{id:string,name:string}>} null — передумали
 */
async function createFirstAlbum() {
  const got = await askAboutBaby(
    `Главная папка появится в вашем Google Диске под именем ` +
    `«${rootName(GOOGLE.folderName, state.cfg.driveEmail)}», а внутри неё — ` +
    'папка ребёнка. Второй ребёнок потом ляжет рядом с первым.');
  if (!got) return null;

  const homeId = await ensureOwnHome();
  const root = await drive().createRoot(got.name, homeId);
  await settings.merge({
    driveFolderId: root.id,
    driveFolderName: root.name,
    ...babyPatch(got),
  });
  state.cfg = await settings.all();
  return root;
}

/**
 * Имя и дата рождения — всё, что нужно знать про нового ребёнка. Один и тот
 * же вопрос и для первого альбома, и для каждого следующего: заводят их
 * в разных местах, а спрашивают одно и то же.
 *
 * @returns {Promise<?{name:string, birth:string}>} null — отменили
 */
async function askAboutBaby(text) {
  const got = await ask({
    title: 'Про кого снимаем',
    text,
    inputs: [
      { key: 'name', label: 'Имя ребёнка', type: 'text' },
      { key: 'birth', label: 'Дата рождения', type: 'date', value: D.todayKey() },
    ],
    yes: 'Завести',
    danger: false,
  });
  if (!got) return null;
  if (!got.name) { toast('Без имени папку не завести'); return null; }
  if (!got.birth) { toast('Поставьте дату — от неё считаются дни'); return null; }
  return got;
}

/** Дата в будущем — это ПДР: до родов приложение считает недели, а не дни. */
function babyPatch(got) {
  const future = D.diffDays(D.todayKey(), got.birth) > 0;
  return { babyName: got.name, birthDate: got.birth, dueDate: future ? got.birth : null };
}

/**
 * Подключение к чужой папке. Что именно выбрали — дом со всеми детьми или
 * папку одного ребёнка, — решает не человек, а содержимое: первому родителю
 * проще поделиться домом целиком, но чаще делятся одним ребёнком.
 *
 * @param {(s:string)=>void} say куда писать отказы: в «Настройках» это тост,
 *        а поверх окна выбора папки тоста не видно — там строчка ошибки.
 * @returns {Promise<?{id:string,name:string}>} папка альбома, если подключились
 */
async function pickShared(say = toast) {
  const token = await G.getAccessToken({ interactive: true });
  const folder = await pickFolder(token);
  if (!folder) { say(PICKER_HINT); return null; }
  if (yearFolder(folder.name)) { say(YEAR_FOLDER); return null; }

  const kind = await drive().folderKind(folder.id);
  if (kind === 'home') {
    await drive().adoptHome(folder.id);
    await settings.merge({ homeFolderId: folder.id, homeFolderName: folder.name });
    const albums = await drive().listProjects(folder.id);
    if (!albums.length) {
      say(`В папке «${folder.name}» нет ни одного альбома. Попросите первого ` +
          'родителя дать доступ на папку ребёнка — она лежит внутри этой.');
      state.cfg = await settings.all();
      return null;
    }
    // Метку на чужие папки ставим свою: она приватная, владельцу от неё ни
    // холодно ни жарко, а без неё эти альбомы не попадут в список «Кого
    // снимаем» — он собирается как раз по меткам.
    for (const a of albums) await drive().adoptRoot(a.id);
    // Детей может оказаться несколько — открываем первого и говорим, где
    // переключиться: гадать за человека тут не на чем.
    await store.switchProject(drive(), albums[0]);
    if (albums.length > 1) toast('Кого снимаем — выбирается в настройках');
    state.cfg = await settings.all();
    return albums[0];
  }

  await drive().adoptRoot(folder.id);
  // Дни прежней папки к этой не относятся: человек только что сказал,
  // какой альбом его, — остальное кэш, и он пересоберётся из папки.
  await store.switchProject(drive(), folder);
  state.cfg = await settings.all();
  return folder;
}

/**
 * Вход руками: человек нажал «Подключить» или «Переподключить».
 * @param {HTMLElement|null} btn кнопку гасим, пока Google думает
 */
async function connectGoogle(btn = null) {
  if (btn) btn.disabled = true;
  try {
    // Выбор аккаунта показываем только тем, кто ещё не входил: у остальных
    // почта известна, и переспрашивать каждый раз — лишний шаг.
    const chooseAccount = !state.cfg.driveEmail;
    const { accessToken } = await G.requestToken({ interactive: true, chooseAccount });
    const me = await G.fetchUserInfo(accessToken);
    if (!G.emailAllowed(me.email)) {
      G.forget();
      throw new Error('Этот аккаунт не в списке разрешённых');
    }
    await settings.set('driveEmail', me.email);
    state.cfg = await settings.all();
    setConn('ok', me.email, 'Подключен к Google');
    // Вход без папки — это ещё не подключённое приложение: снимать некуда.
    await ensureAlbumFolder();
    return true;
  } catch (e) {
    await checkConnection();
    throw e;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Первым делом — связь. Пока непонятно, дойдёт ли снятое до общей папки,
 * пускать в приложение нечестно: человек снимет день, а кадр осядет на
 * телефоне и не попадёт ни второму родителю, ни на новый телефон. Поэтому
 * из ворот один выход — войти в Google.
 */
async function runGate() {
  const gate = $('gate');
  const retry = $('gate-retry');
  const showFail = () => {
    const off = state.conn.status === 'off';
    $('gate-mark').className = 'conn-mark big bad';
    $('gate-mark').innerHTML = ICON_BAD;
    $('gate-title').textContent = off ? 'Google не подключён' : 'Google не отвечает';
    $('gate-text').textContent = off
      ? 'Без него фотографии останутся только на этом телефоне: ни второму ' +
        'родителю, ни на новый телефон они не попадут.'
      : navigator.onLine
        ? 'Доступ к папке нужно выдать заново — это один тап, ' +
          'ничего вводить не придётся.'
        : 'Похоже, сейчас нет сети. Войти получится, когда связь появится.';
    $('gate-error').textContent = '';
    $('gate-retry-label').textContent = off ? 'Подключить Google' : 'Переподключить Google';
    retry.classList.remove('hidden');
    gate.classList.remove('hidden');
  };

  // Проверка обычно занимает доли секунды. Мигать ради неё целым экраном
  // незачем — показываем его, только если Google задумался.
  const wait = setTimeout(() => {
    $('gate-mark').className = 'conn-mark big wait';
    $('gate-mark').innerHTML = '';
    $('gate-title').textContent = 'Проверяю связь с Google…';
    $('gate-text').textContent = 'Секунду — смотрю, отвечает ли Диск и жив ли доступ к папке.';
    retry.classList.add('hidden');
    gate.classList.remove('hidden');
  }, 400);

  await checkConnection();
  clearTimeout(wait);

  // Останавливаем только тех, у кого связь была и пропала. Тому, кто Google
  // отключил сам, незачем на каждом запуске отвечать на один и тот же вопрос:
  // ему хватит красного крестика в полоске.
  if (state.conn.status !== 'bad') {
    gate.classList.add('hidden');
    return;
  }

  showFail();
  await new Promise(resolve => {
    retry.onclick = async () => {
      $('gate-error').textContent = '';
      // Без сети окно Google не откроется и молча ничего не произойдёт —
      // честнее сказать это сразу, чем оставить человека жать на кнопку.
      if (!navigator.onLine) {
        $('gate-error').textContent = 'Нет сети — Google не откроется';
        return;
      }
      try {
        await connectGoogle(retry);
        resolve();
      } catch (e) {
        showFail();
        $('gate-error').textContent = e.message || 'Не получилось войти';
      }
    };
  });
  gate.classList.add('hidden');
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
    status.classList.remove('hidden');
    ['btn-sync', 'drive-link', 'btn-pick-folder', 'btn-google-off', 'google-hint',
      'btn-google-connect', 'google-folder'].forEach(id => show(id, false));
    return;
  }
  show('google-hint', true);

  const cfg = state.cfg;
  const connected = Boolean(cfg.driveEmail);
  const token = G.currentToken();

  // Всё, что раньше делала кнопка «Пройти настройку заново», приложение делает
  // само при входе: ищет папку, а если её нет — спрашивает, кто пришёл.
  show('btn-google-connect', !connected);
  show('btn-google-off', connected);

  // Какая папка подключена — как в мастере. У второго родителя рядом с общей
  // папкой лежит своя, названия отличаются только почтой в конце, и без этой
  // строчки перепутать их можно, ничего не заметив.
  const hasFolder = connected && Boolean(cfg.driveFolderId);
  show('google-folder', connected);
  // Показываем путь, а не одно имя: папок теперь две, и «Алиса» без дома над
  // ней не отвечает на вопрос «куда именно уходят снимки».
  $('google-folder-name').textContent = hasFolder
    ? albumPath(cfg)
    : 'Папка не выбрана';
  $('google-folder-name').title = hasFolder ? cfg.driveFolderName : '';

  // Обновлять и открывать нечего, пока папки нет; выбрать — единственное,
  // что в этот момент имеет смысл, поэтому кнопка так и называется.
  show('btn-sync', hasFolder);
  show('drive-link', hasFolder);
  $('btn-pick-label').textContent = hasFolder ? 'Поменять' : 'Выбрать';
  if (hasFolder) {
    $('drive-link').href = `https://drive.google.com/drive/folders/${cfg.driveFolderId}`;
  }

  // Почта и время синхронизации ушли: почта и так в полоске наверху, а «когда
  // синхронизировано» приложение решает само и спрашивать об этом нечего.
  // Строчка остаётся для того, что человеку и правда нужно знать.
  if (!connected) {
    status.classList.remove('hidden');
    status.textContent = 'Аккаунт не подключён.';
    return;
  }
  status.textContent = token ? '' : 'Нужен один тап, чтобы обновить доступ.';
  status.classList.toggle('hidden', Boolean(token));
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

  let entry = await entries.get(key);
  if (entry && entry.noteStale) entry = await pullNote(key) || entry;
  const body = entry && entry.fileId ? await blobs.get(key) : null;
  const slot = $('today-photo');
  slot.innerHTML = '';

  if (entry && entry.fileId) {
    paintPhoto('today-photo', entry, body);
    $('today-actions').classList.remove('hidden');
    $('btn-camera-label').textContent = 'Переснять';
    // Сегодняшний день смотрят чаще всего, поэтому его снимок дотягиваем сразу.
    // Перерисовываем при этом только сам кадр: человек мог уже начать печатать
    // комментарий, и подменять поле под руками нельзя.
    if (!body) {
      pullBody(key).then(async got => {
        if (!got || D.todayKey() !== key) return;
        paintPhoto('today-photo', await entries.get(key), await blobs.get(key));
      });
    }
  } else {
    slot.innerHTML = `<div class="photo-empty">
      <svg viewBox="0 0 24 24" width="42" height="42"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="13.5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
      <p>Фото за этот день ещё нет</p></div>`;
    $('today-actions').classList.add('hidden');
    $('btn-camera-label').textContent = 'Снять';
  }

  $('today-comment').value = entry ? (entry.comment || '') : '';
  applyOnlineState();
  // Поле комментария приходит вместе с кадром. Подписывать пока нечего, а
  // серое поле с «сначала снимите» занимало экран и ничего не предлагало.
  $('today-comment').classList.toggle('hidden', !(entry && entry.fileId));
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
  progressOpen('Загружаю в общую папку');
  try {
    await store.putPhoto(drive(), dateKey, file);
  } catch (e) {
    progressClose();
    toast(e.message || 'Не удалось загрузить снимок — ничего не изменилось');
    return;
  }
  progressClose();
  freeUrls();
  await renderToday();
  if (!$('overlay-day').classList.contains('hidden')) await openDay(dateKey);
  if (!$('screen-calendar').classList.contains('hidden')) await renderCalendar();
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
    // Сначала галочка — она не стоит ни байта и рисуется мгновенно. Миниатюра
    // придёт следом и займёт её место, если приедет.
    if (entry && entry.fileId) cell.classList.add('has-photo', 'no-thumb');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d;
    cell.appendChild(num);
    cell.onclick = () => openDay(key);
    grid.appendChild(cell);
  }

  const total = (await entries.allDates()).length;
  const inMonth = rows.filter(r => r.fileId).length;
  $('cal-stats').textContent =
    `${inMonth} ${D.plural(inMonth, 'день', 'дня', 'дней')} в этом месяце · ${total} всего`;

  loadMonthThumbs(rows.filter(r => r.fileId).map(r => r.date));
}

/**
 * Миниатюры открытого месяца.
 *
 * Единственное, что календарь вообще качает, и качает он не снимки: у Google
 * уже есть готовые миниатюры, и ссылки на них приехали вместе с описью папки.
 * Месяц — это три десятка картинок по несколько килобайт, ни одна из которых
 * не ложится на диск. Платим только за те месяцы, которые открыли.
 *
 * Ушли на другой месяц — прошлая очередь бросается: догружать то, чего никто
 * уже не видит, значит тратить чужой трафик впустую.
 */
let monthRun = 0;
async function loadMonthThumbs(dates) {
  const token = ++monthRun;
  if (!dates.length || !canPull()) return;

  let frames;
  try {
    frames = await store.previewFrames(drive(), dates, { size: CAL_THUMB });
  } catch {
    return;                    // не приехали — в клетках останутся галочки
  }
  if (token !== monthRun) return;

  // Загружаем разом, а не по очереди: месяц иначе проявляется по клетке в
  // секунду, и это заметно неприятнее, чем тридцать запросов сразу.
  await Promise.all(frames.map(async frame => {
    const img = new Image();
    try {
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('миниатюра не открылась'));
        img.src = frame.url;
      });
    } catch {
      return;                  // у этого дня останется галочка
    }
    if (token !== monthRun) return;
    const cell = $('cal-grid').querySelector(`[data-date="${frame.date}"]`);
    if (cell) paintCellThumb(cell, img, frame.eyes);
  }));
}

/**
 * Миниатюра в клетке: тем же расчётом, что и настоящий кадр, — в календаре
 * видно именно то, что окажется в таймлапсе. Иначе размеченный день выглядел
 * бы в сетке одним кадром, а в видео уезжал другим.
 */
function paintCellThumb(cell, img, eyes) {
  if (cell.querySelector('canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CAL_THUMB;
  drawAligned(canvas.getContext('2d'), img, img.naturalWidth, img.naturalHeight,
    CAL_THUMB, eyes, state.cfg.eyeTarget);
  cell.classList.remove('no-thumb');
  cell.insertBefore(canvas, cell.firstChild);
}

// --- карточка дня -----------------------------------------------------------

let dayKey = null;

async function openDay(key) {
  dayKey = key;
  const info = D.dayLabel(key, state.cfg);
  $('day-title').textContent = info.label;
  $('day-sub').textContent = D.formatLong(key) + (info.sub ? ` · ${info.sub}` : '');

  let entry = await entries.get(key);
  if (entry && entry.noteStale) entry = await pullNote(key) || entry;
  const body = entry && entry.fileId ? await blobs.get(key) : null;
  const slot = $('day-photo');
  slot.innerHTML = '';

  if (entry && entry.fileId) {
    paintPhoto('day-photo', entry, body);
    $('day-share').classList.remove('hidden');
    $('day-align').classList.remove('hidden');
    $('day-replace').classList.remove('hidden');
    $('day-add').classList.add('hidden');
    $('day-delete').classList.remove('hidden');
  } else {
    slot.innerHTML = '<div class="photo-empty"><p>За этот день фото нет</p></div>';
    $('day-share').classList.add('hidden');
    $('day-align').classList.add('hidden');
    $('day-replace').classList.add('hidden');
    $('day-add').classList.remove('hidden');
    $('day-delete').classList.toggle('hidden', !entry);
  }

  $('day-comment').value = entry ? (entry.comment || '') : '';
  applyOnlineState();
  // Комментарий лежит файлом рядом со снимком, поэтому без снимка ему негде быть
  const hasPhoto = Boolean(entry && entry.fileId);
  $('day-comment').disabled = $('day-comment').disabled || !hasPhoto;
  $('day-comment').placeholder = hasPhoto
    ? 'Комментарий…' : 'Сначала добавьте фото за этот день';
  await overlay('overlay-day', true);

  // Открыли день — значит, снимок и правда нужен: качаем именно его одного.
  // Как и на «Сегодня», меняем только кадр, не трогая поле комментария.
  if (hasPhoto && !body) {
    pullBody(key).then(async got => {
      if (!got || dayKey !== key || $('overlay-day').classList.contains('hidden')) return;
      paintPhoto('day-photo', await entries.get(key), await blobs.get(key));
    });
  }
}

function closeDay() {
  clearTimeout(dayCommentTimer);
  if (dayKey) saveComment(dayKey, $('day-comment').value);
  overlay('overlay-day', false);
  dayKey = null;
}

async function saveComment(key, text) {
  if (!key || !online()) return;
  const existing = await entries.get(key);
  if (!existing) return;            // комментарий без снимка хранить негде
  if ((existing.comment || '') === text) return;
  try {
    await store.putComment(drive(), key, text);
  } catch (e) {
    toast(e.message || 'Комментарий не сохранился');
  }
}

// --- поделиться одним днём --------------------------------------------------
//
// Таймлапс собирают раз в несколько месяцев, а «смотри, какой он сегодня»
// отправляют каждый день — и до сих пор ради этого приходилось идти в галерею
// телефона, где снимка нет: он лежит в общей папке, а не здесь.
//
// Кадр собирается тем же расчётом, что и кадр таймлапса: тот же квадрат, те же
// глаза на своих местах, та же подпись. Отправленное сегодня и год спустя
// встанет в одну строчку с тем, что окажется в видео.

/** Выжигает подпись в готовый квадрат. Сторону берём у самого кадра. */
async function withCaption(square, text) {
  if (!text) return square;
  const { img, width, release } = await loadImage(square);
  try {
    const canvas = makeCanvas(width, width);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    drawCaption(ctx, text, width);
    return await canvasToBlob(canvas, 'image/jpeg', 0.9);
  } finally {
    release();
  }
}

async function shareDay(key) {
  if (!key) return;
  const entry = await entries.get(key);
  if (!entry || !entry.fileId) return;

  let body = await blobs.get(key);
  if (!body || !body.photo) {
    // Снимка на телефоне нет — он и не должен тут жить. Без сети отправлять
    // нечего, и честнее сказать это сразу, чем показать пустой квадрат.
    if (!canPull()) {
      toast('Нет сети — снимок лежит в общей папке, а не на телефоне', 3600);
      return;
    }
    progressOpen('Готовлю кадр');
    const got = await pullBody(key, { silent: false });
    progressClose();
    if (!got) return;
    body = await blobs.get(key);
  }
  if (!body || !body.photo) { toast('Снимок не открылся'); return; }

  const cfg = state.cfg;
  let blob;
  try {
    // ensureBody уже мог собрать выровненный кадр — тогда переделывать нечего.
    const square = body.aligned || await renderSquareBlob(body.photo,
      { size: cfg.videoSize, eyes: entry.eyes, target: cfg.eyeTarget });
    // Подпись здесь не спрашивает галочку «подписывать кадры»: та про видео,
    // где счётчик идёт подряд и виден сам собой. Отдельный кадр уезжает к
    // человеку, у которого нет ни календаря, ни соседних дней, — «День 47»
    // и есть всё, что он о снимке узнает. Без даты рождения счётчика нет.
    blob = await withCaption(square, cfg.birthDate ? captionFor(key) : '');
  } catch (e) {
    toast(e.message || 'Не удалось собрать кадр');
    return;
  }

  const info = D.dayLabel(key, cfg);
  const name = `${cfg.babyName || 'kadr'}-${key}.jpg`;
  const title = cfg.birthDate ? `${info.label} · ${D.formatLong(key)}` : D.formatLong(key);
  if (await saveBlob(blob, name, title) === 'downloaded') {
    toast('Кадр сохранён в «Загрузки»');
  }
}

// --- съёмка по вчерашнему кадру ---------------------------------------------
//
// Разметка глаз спасает от смещения на десятки пикселей. От «вчера снимал
// сидя, сегодня стоя» она не спасает: масштаб и ракурс уже не те, и голова в
// таймлапсе всё равно прыгает. Лечится это только в момент съёмки — тем, что
// вчерашний кадр видно прямо в видоискателе.

/**
 * Вчерашний кадр для призрака — миниатюрой Диска, а не оригиналом.
 *
 * Для наложения её хватает с запасом: призрак и так бледный, и совмещают по
 * силуэту головы, а не по ресницам. Зато открывается мгновенно и стоит
 * килобайты — камеру не заставляют ждать мегабайт.
 */
async function ghostSource(beforeDate) {
  const rows = await entries.range('0000-01-01', beforeDate);
  const prev = [...rows].reverse().find(r => r.date !== beforeDate && r.fileId);
  if (!prev) return null;

  let link;
  try {
    link = await store.thumbUrl(drive(), prev.date, { size: THUMB_VIEW });
  } catch {
    return null;
  }
  if (!link) return null;

  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('кадр не открылся'));
      img.src = link;
    });
  } catch {
    return null;
  }
  return { img, eyes: prev.eyes, date: prev.date };
}

async function openGhost(key) {
  if (!requireOnline()) return;

  const cam = createGhostCamera({
    video: $('ghost-video'),
    guide: $('ghost-guide'),
    still: $('ghost-still'),
    target: state.cfg.eyeTarget,
  });
  state.ghost = { cam, key, hint: '' };
  showLive();

  $('ghost-title').textContent = D.dayLabel(key, state.cfg).label;
  setGhostHint('Включаю камеру…');
  await overlay('overlay-ghost', true);

  try {
    await cam.start();
  } catch (e) {
    closeGhost();
    toast(cameraError(e), 5200);
    return;
  }

  cam.setAlpha(Number($('ghost-opacity').value) / 100);

  const prev = await ghostSource(key);
  if (!state.ghost) return;            // успели закрыть, пока ехала миниатюра
  if (prev) {
    cam.setGhost(prev.img, prev.eyes);
    setGhostHint('Совместите голову с бледным кадром за ' +
      D.formatLong(prev.date).replace(/ \d{4}$/, '') + '.');
  } else {
    // Первый кадр в альбоме: совмещать не с чем, зато овал уже задаёт, как
    // будут выглядеть все следующие.
    setGhostHint('Первый кадр — по нему выстроятся остальные. ' +
      'Впишите голову в овал, глаза на линию.');
  }
}

function closeGhost() {
  if (state.ghost) state.ghost.cam.stop();
  state.ghost = null;
  showLive();
  overlay('overlay-ghost', false);
}

/** Подсказку под кадром помним: после «Переснять» нужна та же самая. */
function setGhostHint(text) {
  if (state.ghost) state.ghost.hint = text;
  $('ghost-hint').textContent = text;
}

/** Живая картинка: снимаем, пока не сняли. */
function showLive() {
  $('ghost-still').classList.add('hidden');
  $('ghost-live-row').classList.remove('hidden');
  $('ghost-shot-row').classList.add('hidden');
}

/**
 * Снимок фиксируется по нажатию и сразу застывает на экране.
 *
 * Раньше кадр уезжал в папку тем же нажатием, а на экране всё это время
 * шевелилась живая картинка — и выходило, что съёмка будто длится секунды и
 * телефон надо держать ровно до конца. На самом деле кадр берётся мгновенно,
 * а секунды уходят на сжатие и заливку. Теперь это видно: вспышка, застывший
 * кадр и вопрос «сохранить или переснять». В папку до «Сохранить» не уходит
 * ничего, поэтому переснимать можно сколько угодно.
 */
function shootGhost() {
  const g = state.ghost;
  if (!g) return;
  try {
    g.cam.capture();
  } catch (e) {
    toast(e.message || 'Кадр не получился');
    return;
  }

  const stage = $('ghost-stage');
  stage.classList.remove('flash');
  void stage.offsetWidth;              // перезапуск анимации на втором дубле
  stage.classList.add('flash');

  $('ghost-still').classList.remove('hidden');
  $('ghost-live-row').classList.add('hidden');
  $('ghost-shot-row').classList.remove('hidden');
  $('ghost-hint').textContent =
    'Кадр снят. Сравните с бледным вчера — и сохраняйте. В папку он уйдёт ' +
    'только по «Сохранить».';
}

function retakeGhost() {
  const g = state.ghost;
  if (!g) return;
  g.cam.resume();
  showLive();
  $('ghost-hint').textContent = g.hint;
}

async function saveGhost() {
  const g = state.ghost;
  if (!g) return;
  let file;
  try {
    file = await g.cam.blob(state.cfg.masterQuality);
  } catch (e) {
    toast(e.message || 'Кадр не получился');
    return;
  }
  const key = g.key;
  closeGhost();                        // камеру гасим до заливки: она не нужна
  await handlePhotoFile(file, key);
}

// --- разметка глаз ----------------------------------------------------------

async function openAlign(key) {
  const entry = await entries.get(key);
  if (!entry || !entry.fileId) return;

  // Размечают по оригиналу, поэтому здесь тело нужно обязательно.
  let body = await blobs.get(key);
  if (!body || !body.photo) {
    progressOpen('Загружаю снимок');
    const got = await pullBody(key, { silent: false });
    progressClose();
    body = got ? await blobs.get(key) : null;
    if (!body || !body.photo) { toast('Нужна сеть, чтобы разметить этот кадр'); return; }
  }

  const img = $('align-img');
  img.src = url(body.photo);
  $('align-title').textContent = D.dayLabel(key, state.cfg).label;

  // День ещё не размечали — подставляем вчерашние точки. Снимки изо дня в день
  // похожи, поэтому обычно они уже стоят там, где надо, и остаётся проверить.
  // Сохранится всё равно только то, что человек подтвердил кнопкой.
  const eyes = entry.eyes || await store.eyesBefore(key);
  const guessed = !entry.eyes && Boolean(eyes);

  state.align = { key, entry, guessed,
                  l: eyes ? { x: eyes.lx, y: eyes.ly } : null,
                  r: eyes ? { x: eyes.rx, y: eyes.ry } : null, drag: null };
  drawDots();
  await overlay('overlay-align', true);
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
    : a.guessed ? 'Точки стоят как вчера. Поправьте, если сместились, — и сохраняйте.'
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

  progressOpen('Сохраняю разметку');
  try {
    await store.putEyes(drive(), a.key, { lx: a.l.x, ly: a.l.y, rx: a.r.x, ry: a.r.y });
  } catch (e) {
    progressClose();
    toast(e.message || 'Разметка не сохранилась');
    return;
  }
  progressClose();

  await overlay('overlay-align', false);
  state.align = null;
  freeUrls();
  await renderToday();
  if (dayKey) await openDay(dayKey);
  toast('Кадр выровнен');
}

// --- видео ------------------------------------------------------------------

/** Дни выбранного промежутка, у которых в папке есть снимок. */
async function videoDays() {
  const from = $('video-from').value || '0000-01-01';
  const to = $('video-to').value || '9999-12-31';
  const rows = await entries.range(from, to);
  return rows.filter(r => r.fileId).map(r => r.date);
}

/** Все дни альбома, у которых есть снимок. */
async function allDays() {
  const rows = await entries.range('0000-01-01', '9999-12-31');
  return rows.filter(r => r.fileId).map(r => r.date);
}

/**
 * Кадры для сборки. Здесь и только здесь качается вся история целиком: видео
 * иначе не собрать. Зато человек платит за это осознанно — нажав кнопку, а не
 * открыв приложение.
 *
 * Кадры ложатся на верстак, а не в память вкладки: год оригиналов вместе с
 * год выровненных кадров телефон не удержит. Верстак стирается при уходе с
 * экрана — store.clearBench().
 */
async function framesForBuild(days) {
  if (!days) days = await videoDays();
  if (!days.length) return [];

  const puller = canPull() ? drive() : null;
  const pending = await store.pendingFrames(days);
  if (pending && !puller) {
    toast(`Без сети собираю из ${days.length - pending} загруженных кадров`, 3600);
  }
  if (pending && puller) progressOpen('Готовлю кадры');

  const { frames, missing } = await store.buildFrames(puller, days,
    { onProgress: (d, t, label) => progressSet(d, t, label) });
  progressClose();

  if (state.cfg.videoCaption) {
    for (const frame of frames) frame.caption = captionFor(frame.date);
  }

  if (missing && puller) {
    toast(`Не удалось загрузить ${missing} ${D.plural(missing, 'кадр', 'кадра', 'кадров')}`);
  }
  return frames;
}

/**
 * Что выжигать в кадр. Тот же счётчик, что и в заголовке «Сегодня»: «День 47»
 * после родов, «За 30 дней до встречи» до них. Без даты рождения счётчика нет
 * — тогда и подписывать нечем, и чекбокс не показывается.
 */
function captionFor(date) {
  return D.dayLabel(date, state.cfg).label;
}

async function refreshVideoInfo() {
  const days = await videoDays();
  const fps = Number($('video-fps').value);
  const secs = days.length / fps;
  $('video-info').textContent = days.length
    ? `${days.length} ${D.plural(days.length, 'кадр', 'кадра', 'кадров')} · примерно ${secs.toFixed(1)} с`
    : 'В этом промежутке ещё нет кадров.';
  $('btn-render').disabled = !days.length;
  $('btn-preview').disabled = !days.length;

  // Обещать сборку там, где браузер её не умеет, нечестно: кнопка всё равно
  // ответила бы отказом. Убираем её и объясняем, чем собрать вместо неё.
  const canRecord = videoSupported();
  $('btn-render').classList.toggle('hidden', !canRecord);
  $('video-unsupported').classList.toggle('hidden', canRecord);
}

/** @param {boolean} playing Идёт ли показ: от этого вся разница в кнопке. */
function setPlayButton(playing) {
  const b = $('btn-preview');
  b.innerHTML = playing ? ICON_STOP : ICON_PLAY;
  b.setAttribute('aria-label', playing ? 'Остановить' : 'Посмотреть');
}

/**
 * Проигрыватель предпросмотра.
 *
 * Кадры — миниатюры из Диска, поэтому весь ряд помещается в памяти и можно
 * не «проигрывать поток», а просто рисовать нужный кадр: отсюда и пауза, и
 * перемотка в любое место, чего у прежнего показа не было.
 */
// Декодированный кадр 540×540 — это больше мегабайта сверх самой миниатюры.
// Год таких в памяти не держат, поэтому вокруг текущего места оставляем окно,
// а остальное отпускаем: пролистнули назад — декодируется заново, это дёшево.
const PLAYER_WINDOW = 24;

const player = {
  frames: [],        // [{date, url, eyes}] по порядку
  images: new Map(),  // date -> HTMLImageElement, декодируем по требованию
  i: 0,
  playing: false,
  timer: null,
  key: '',           // какой промежуток загружен: сменился — перезагружаем
};

function playerStop() {
  player.playing = false;
  clearTimeout(player.timer);
  player.timer = null;
  setPlayButton(false);
  setOverlay('play');
}

/**
 * Значок поверх кадра. Во время показа над видео не должно быть ничего:
 * таймлапс идёт секунды, и кружок посреди лица успевает только помешать.
 * @param {?string} kind 'play' — приглашение нажать; null — чистый кадр
 */
function setOverlay(kind) {
  $('video-overlay').className = 'video-overlay' + (kind ? ' ' + kind : ' hidden');
}

/**
 * Миниатюру грузим обычной картинкой: скачать её запросом нельзя — сервер
 * картинок Google не отдаёт заголовок CORS. Рисовать это на холсте можно,
 * читать холст обратно — нет, но предпросмотру и не нужно: файл собирается
 * из оригиналов, а не отсюда.
 */
function imageFor(frame) {
  let img = player.images.get(frame.date);
  if (img) return img;
  img = new Image();
  img.src = frame.url;
  player.images.set(frame.date, img);
  return img;
}

async function drawFrame(i) {
  const frame = player.frames[i];
  if (!frame) return;
  player.i = i;
  const canvas = $('video-canvas');
  const ctx = canvas.getContext('2d');
  const img = imageFor(frame);
  if (!img.complete) {
    await new Promise(res => { img.onload = res; img.onerror = res; });
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (img.naturalWidth) {
    // Тот же расчёт, что и у настоящего кадра: глаза встают на своё место,
    // поэтому предпросмотр показывает именно то, что окажется в файле.
    drawAligned(ctx, img, img.naturalWidth, img.naturalHeight,
      canvas.width, frame.eyes, state.cfg.eyeTarget);
    if (state.cfg.videoCaption) {
      drawCaption(ctx, captionFor(frame.date), canvas.width);
    }
  }
  $('video-seek').value = String(i);
  $('video-pos').textContent = D.formatLong(frame.date).replace(/ \d{4}$/, '');
  // Следующий кадр начинаем грузить заранее: иначе на первом показе темп плывёт.
  if (player.frames[i + 1]) imageFor(player.frames[i + 1]);
  trimImages(i);
}

/** Отпускает кадры за пределами окна — иначе год показа съедает всю память. */
function trimImages(i) {
  if (player.images.size <= PLAYER_WINDOW * 2 + 2) return;
  const keep = new Set();
  for (let k = i - PLAYER_WINDOW; k <= i + PLAYER_WINDOW; k++) {
    const frame = player.frames[k];
    if (frame) keep.add(frame.date);
  }
  for (const date of [...player.images.keys()]) {
    if (!keep.has(date)) player.images.delete(date);
  }
}

function playerPlay() {
  if (!player.frames.length) return;
  // Досмотрели до конца — следующий пуск начинает сначала.
  if (player.i >= player.frames.length - 1) player.i = 0;
  player.playing = true;
  setPlayButton(true);
  setOverlay(null);
  const step = async () => {
    if (!player.playing) return;
    await drawFrame(player.i);
    if (player.i >= player.frames.length - 1) { playerStop(); return; }
    player.timer = setTimeout(() => { player.i++; step(); },
      1000 / Number($('video-fps').value));
  };
  step();
}

function playerToggle() {
  if (!player.frames.length) return previewVideo();
  if (player.playing) playerStop(); else playerPlay();
}

/**
 * Предпросмотр идёт по миниатюрам Google: посмотреть год так стоит мегабайта
 * вместо сотни. Оригиналы качаются только за настоящим файлом — там качество
 * решает, здесь достаточно узнать лицо в квадрате 400×400.
 */
async function previewVideo() {
  const days = await videoDays();
  if (!days.length) return;
  if (!canPull()) { toast('Нет сети — предпросмотр не из чего собрать'); return; }

  const key = days.join(',');
  if (key !== player.key) {
    let frames = [];
    try {
      frames = await store.previewFrames(drive(), days);
    } catch (e) {
      toast(e.message || 'Не удалось получить кадры для предпросмотра');
    }
    if (!frames.length) { toast('Кадры для предпросмотра не приехали'); return; }
    player.frames = frames;
    player.images.clear();
    player.key = key;
    player.i = 0;
  }

  $('video-result').classList.add('hidden');
  $('video-canvas').classList.remove('hidden');
  $('video-track').classList.remove('hidden');
  $('video-seek').max = String(player.frames.length - 1);
  await drawFrame(player.i);
  playerPlay();
}

/** Промежуток или скорость поменялись — показанное больше не про них. */
function resetPlayer() {
  playerStop();
  player.frames = [];
  player.images.clear();
  player.key = '';
  player.i = 0;
  $('video-track').classList.add('hidden');
  $('video-overlay').classList.add('hidden');
  const canvas = $('video-canvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Что будет, если нажать «Скачать». Сборка идёт в реальном времени и на
 * телефоне, файл выходит увесистый — человеку честнее знать это до того, как
 * экран на полминуты займёт полоска прогресса.
 *
 * Числа приблизительные и такими названы: длительность считается точно, а
 * размер зависит от того, насколько кодек сожмёт конкретные кадры.
 * @returns {Promise<boolean>} согласился ли человек
 */
async function confirmRender(days) {
  const pending = await store.pendingFrames(days);
  const fps = Number($('video-fps').value);
  // Столько же, сколько добавляет buildVideo: разгон рекордера и удержание
  // последнего кадра, иначе таймлапс обрывается на полуслове.
  const hold = Math.max(0.4, 4 / fps);
  const secs = days.length / fps + hold + 0.12;
  const ext = (pickMime() || '').startsWith('video/mp4') ? 'mp4' : 'webm';
  const name = `${state.cfg.babyName || 'timelapse'}-${D.todayKey()}.${ext}`;
  // Тот же битрейт, с которым пишет buildVideo: 8 Мбит/с ≈ 1 МБ на секунду.
  const bytes = 8_000_000 / 8 * secs;
  const shares = Boolean(navigator.canShare && navigator.canShare({
    files: [new File([new Blob()], name, { type: `video/${ext}` })],
  }));

  return ask({
    title: 'Собрать и скачать видео',
    text: 'В отличие от предпросмотра, файл собирается из настоящих ' +
      'фотографий: они скачаются из папки, проиграются по одной и запишутся ' +
      'в видео. На телефоне ничего из этого не останется.',
    items: [
      ['Кадров', `${days.length} · видео примерно на ${secs.toFixed(1)} с` +
        (pending ? ` · скачаю ${pending} из папки` : '')],
      ['Файл', `${name}, примерно ${formatBytes(bytes)}`],
      ['Куда', shares
        ? 'телефон спросит сам — можно сохранить или сразу отправить'
        : 'в папку «Загрузки»'],
      ['Сколько ждать', `примерно ${Math.ceil(secs + 1)} с — ` +
        'приложение должно оставаться открытым'],
    ],
    yes: 'Скачать',
    no: 'Не сейчас',
    danger: false,
  });
}

async function renderVideo() {
  const days = await videoDays();
  if (!days.length) return;
  if (!videoSupported()) {
    toast('Этот браузер не умеет записывать видео — выгрузите кадры в ZIP');
    return;
  }
  if (!await confirmRender(days)) return;

  const frames = await framesForBuild();
  if (!frames.length) return;
  progressOpen('Собираю видео');
  try {
    const fps = Number($('video-fps').value);
    const { blob, ext } = await buildVideo(frames, { fps, size: state.cfg.videoSize },
      (d, t) => progressSet(d, t, 'Собираю видео'));
    const v = $('video-result');
    v.src = url(blob);
    v.classList.remove('hidden');
    $('video-canvas').classList.add('hidden');
    // Кнопка обещала «скачать», а не «подождите вторую кнопку»: окно прогресса
    // закрываем и сразу отдаём файл — иначе поверх него откроется «Поделиться».
    progressClose();
    const name = `${state.cfg.babyName || 'timelapse'}-${D.todayKey()}.${ext}`;
    if (await saveBlob(blob, name) === 'downloaded') toast('Файл сохранён в «Загрузки»');
    // Оригиналы качались только ради этого файла — держать в памяти
    // мегабайты после того, как он готов, незачем.
    await blobs.clear();
  } catch (e) {
    toast(e.message || 'Не удалось собрать видео');
  } finally {
    progressClose();
  }
}

/**
 * @param {string[]} [days] Дни для выгрузки. Без них — выбранный на «Видео»
 *   промежуток; из «Настроек» приходит весь альбом целиком.
 */
async function framesToZip(days) {
  const frames = await framesForBuild(days);
  if (!frames.length) { toast('Пока нет ни одного кадра'); return; }
  progressOpen('Пакую кадры');
  const files = frames.map((f, i) => ({
    name: `frames/${String(i + 1).padStart(4, '0')}_${f.date}.jpg`,
    data: f.blob,
  }));
  // Скорость в команде — та, что выставлена ползунком: иначе собранное по
  // подсказке видео шло бы не в том темпе, который человек только что выбрал.
  const fps = Number($('video-fps').value);
  files.push({
    name: 'frames/КАК-СОБРАТЬ.txt',
    data: 'Кадры уже выровнены по глазам и пронумерованы по порядку.\n\n' +
          'Собрать видео из них можно одной командой:\n\n' +
          `  ffmpeg -framerate ${fps} -pattern_type glob -i "*.jpg" ` +
          '-c:v libx264 -pix_fmt yuv420p timelapse.mp4\n',
  });
  const zip = await createZip(files, (d, t) => progressSet(d, t));
  progressClose();
  await saveBlob(zip, `kadry-${D.todayKey()}.zip`);
}

// --- настройки --------------------------------------------------------------

const THEMES = ['girl', 'boy'];

/**
 * Оформление. Настоящее значение — в настройках, а значит и в config.json
 * рядом с фотографиями: второй родитель видит то же самое. В localStorage
 * кладём только слепок имени — по нему index.html красит экран до того, как
 * ответит база, иначе розовое приложение открывалось бы тёмной вспышкой.
 */
function applyTheme(name) {
  // Тёмное «обычное» оформление убрано: приложение открывают в роддоме и
  // ночью у кроватки, и светлая тема здесь единственная, которую доводили
  // до ума. Старое значение из настроек и из папки читается как «девочка».
  const theme = THEMES.includes(name) ? name : 'girl';
  const root = document.documentElement;
  root.dataset.theme = theme;

  // Цвета не повторяем — спрашиваем у темы, которую только что включили.
  const css = getComputedStyle(root);
  const meta = (which, value) => {
    const el = document.querySelector(`meta[name="${which}"]`);
    if (el && value) el.content = value.trim();
  };
  meta('theme-color', css.getPropertyValue('--bg'));
  // Полоску состояния iOS перечитывает только при запуске: на открытом
  // приложении она сменится в следующий раз, и это не беда.
  meta('apple-mobile-web-app-status-bar-style', css.getPropertyValue('--status-bar'));

  try { localStorage.setItem('theme', theme); } catch { /* приватный режим */ }
}

function renderThemeCard() {
  const active = THEMES.includes(state.cfg.theme) ? state.cfg.theme : 'girl';
  for (const btn of $('set-theme').querySelectorAll('.theme-opt')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === active));
  }
}

/**
 * Список альбомов: по одному на ребёнка — те, что лежат внутри главной папки,
 * плюс тот, в который снимают сейчас, если он лежит не там.
 *
 * Собирается не из локальной памяти, а из Диска. Иначе второй телефон того же
 * человека не увидел бы альбом, заведённый на первом, и завёл бы рядом второй
 * такой же.
 */
async function renderAlbumsCard() {
  const list = $('albums-list');
  const status = $('albums-status');
  const add = $('btn-album-new');
  const say = (text, canAdd = false) => {
    list.textContent = '';
    status.textContent = text;
    status.classList.remove('hidden');
    add.classList.toggle('hidden', !canAdd);
  };

  if (!configured() || !state.cfg.driveEmail) {
    return say('Альбомы живут в папках Google Диска — подключите Google.');
  }
  // Список стоит запроса к Диску, поэтому платим за него только когда на
  // него смотрят: «Настройки» перерисовываются и после каждой синхронизации,
  // с какого бы экрана она ни шла.
  if ($('screen-more').classList.contains('hidden')) return;
  if (!navigator.onLine) {
    return say(state.cfg.driveFolderName
      ? `Нет сети. Сейчас снимаем в «${state.cfg.driveFolderName}».`
      : 'Нет сети — список альбомов покажу, когда связь появится.');
  }

  say('Смотрю, какие есть…');
  let albums;
  try {
    albums = await drive().albumsFor(state.cfg.homeFolderId, state.cfg.driveFolderId);
  } catch (e) {
    return say(e.message || 'Диск не ответил — список альбомов не пришёл.');
  }

  list.textContent = '';
  status.classList.add('hidden');
  add.classList.remove('hidden');
  if (!albums.length) {
    return say('Ни одного альбома пока нет.', true);
  }
  // Один альбом — переключаться не с чем, но видеть, на кого снимаем, всё
  // равно нужно: строчка остаётся, а вот обещать выбор ей незачем.
  list.classList.toggle('single', albums.length === 1);

  for (const album of albums) {
    const on = album.id === state.cfg.driveFolderId;
    const row = document.createElement('button');
    row.className = 'album' + (on ? ' now' : '');
    row.type = 'button';
    row.setAttribute('aria-pressed', String(on));
    row.title = album.name;               // полное имя папки, как в Диске

    const text = document.createElement('span');
    text.className = 'album-text';
    const name = document.createElement('b');
    name.textContent = folderLabel(album.name);
    text.append(name);

    // Чужая папка — это общий альбом второго родителя. Разница видна и в
    // Диске, но здесь она важнее: снимать в неё можно, переименовывать её
    // нельзя, и человек должен понимать, почему. Чья именно папка — тоже:
    // общих может быть несколько, от разных людей.
    if (!album.ownedByMe) {
      const owner = (album.owners || [])[0];
      const sub = document.createElement('span');
      sub.className = 'album-sub';
      sub.textContent = owner && owner.emailAddress
        ? `общая папка ${owner.emailAddress}`
        : 'общая папка';
      text.append(sub);
    }
    row.append(text);

    // Галочка на выбранном. Одна рамка читается как «поле ввода», и понять,
    // что строчки переключаются, по ней нельзя.
    const tick = document.createElement('span');
    tick.className = 'album-tick';
    tick.innerHTML = on ? ICON_OK : '';
    row.append(tick);

    row.onclick = () => useAlbum(album);
    list.append(row);
  }
}

/** Переключение на другой альбом — по нажатию на строчку в списке. */
async function useAlbum(album) {
  if (album.id === state.cfg.driveFolderId) return;
  progressOpen(`Открываю «${album.name}»`);
  try {
    await store.switchProject(drive(), album);
    state.cfg = await settings.all();
    applyTheme(state.cfg.theme);
    freeUrls();
    progressClose();
    await runSync();
  } catch (e) {
    progressClose();
    toast(e.message || 'Не удалось переключиться на другой альбом');
  }
}

/**
 * Где заведётся новый альбом. Смотрим, но ничего не создаём: человек ещё не
 * подтвердил, а дом, заведённый «на всякий случай», — лишняя папка в Диске.
 *
 * Первым делом спрашиваем, где лежит текущий альбом. Переключившийся в общую
 * папку заводит второго ребёнка рядом с первым — чтобы оба родителя видели
 * обоих детей, а не по одному у каждого. Своим домом отвечаем только когда
 * рядом с текущим альбомом класть некуда: он лежит в чужом корне или доступ
 * дали на просмотр.
 *
 * @returns {Promise<{id:?string, name:string}>} id null — дома ещё нет,
 *          заведём с этим именем после подтверждения.
 */
async function plannedHome() {
  const near = await drive().parentHome(state.cfg.driveFolderId);
  if (near) return near;
  const own = await drive().findHome(state.cfg.homeFolderId);
  if (own) return own;
  return { id: null, name: rootName(GOOGLE.folderName, state.cfg.driveEmail) };
}

/**
 * Новый альбом. Имя и дату спрашиваем сразу: без даты рождения приложение не
 * умеет считать дни, а альбом без имени — безымянная папка в Диске.
 */
async function newAlbum() {
  let home;
  try {
    home = await plannedHome();
  } catch (e) {
    return toast(e.message || 'Диск не ответил — не понять, куда класть альбом');
  }

  // Куда именно ляжет папка, человек должен знать до нажатия: у второго
  // родителя это чужая общая папка, и разница между «рядом с первым ребёнком»
  // и «отдельно у меня» — вся суть.
  const got = await askAboutBaby(
    `Папка появится внутри «${home.name}»${home.id ? '' : ' — её заведу тут же'}. ` +
    'Оформление и настройки видео перейдут из общих — вводить их заново не нужно.');
  if (!got) return;

  progressOpen(`Завожу «${got.name}»`);
  try {
    const homeId = home.id ? await useHome(home) : await ensureOwnHome();
    const root = await drive().createRoot(got.name, homeId);
    await store.switchProject(drive(), root);
    await settings.merge(babyPatch(got));
    state.cfg = await settings.all();
    await pushProfile(drive());
    freeUrls();
    progressClose();
    toast(`Альбом «${root.name}» заведён`);
    await runSync();
  } catch (e) {
    progressClose();
    toast(e.message || 'Не удалось завести альбом');
  }
}

async function renderMore() {
  const cfg = state.cfg;
  await renderGoogleCard();
  await renderAlbumsCard();
  $('set-name').value = cfg.babyName || '';
  $('set-birth').value = cfg.birthDate || '';
  renderThemeCard();
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

  await renderStorageCard(total);
}

/**
 * Место меряем там, где фотографии и лежат по-настоящему, — в Google Диске.
 * Запрос сетевой, поэтому карточка сначала честно говорит, что считает, а
 * при отключённом Google не спрашивает ничего.
 * @param {number} total сколько всего дней снято
 */
async function renderStorageCard(total) {
  const el = $('storage-status');
  if (!configured() || !state.cfg.driveEmail) {
    el.textContent = 'Google не подключён — считать нечего.';
    return;
  }
  if (!navigator.onLine) {
    el.textContent = 'Нет сети — спрошу у Диска, когда связь появится.';
    return;
  }
  el.textContent = 'Считаю…';
  try {
    const u = await drive().usage(state.cfg.driveFolderId);
    const days = total
      ? ` за ${total} ${D.plural(total, 'день', 'дня', 'дней')}`
      : '';
    const free = u.limit
      ? ` Свободно ${formatBytes(Math.max(0, u.limit - u.used))} из ${formatBytes(u.limit)}.`
      : ' Google не сообщает объём хранилища для этого аккаунта.';
    el.textContent = `Альбом занимает ${formatBytes(u.albumBytes)}${days}.` + free;
  } catch (e) {
    el.textContent = e.message || 'Диск не ответил — не получилось посчитать.';
  }
}

// --- навигация --------------------------------------------------------------

/**
 * Подменяет разметку с переходом — тем самым, по которому приложение и
 * отличается от страницы: одно перетекает в другое, а не сменяется рывком.
 *
 * Рисует переход браузер сам (View Transitions), от нас нужен только момент,
 * когда меняется разметка. Где такого не умеют — меняем как раньше, разом:
 * это оформление, без него всё работает. Так же поступаем, когда человек
 * попросил систему поменьше двигать, — движение бывает и в тягость.
 *
 * Обещание разрешается на подмене, а не в конце анимации: содержимое экрана
 * дорисовывается под неё. Дожидаться конца значило бы превратить переход в
 * паузу перед работой.
 */
function transition(mutate) {
  if (typeof document.startViewTransition !== 'function' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches) {
    mutate();
    return Promise.resolve();
  }
  return document.startViewTransition(mutate).updateCallbackDone.catch(() => {});
}

/**
 * Показать или спрятать оверлей: он выезжает снизу и уезжает вниз.
 *
 * Уже открытый не открываем заново. Дело не в экономии: новый переход обрывает
 * идущий, и лист, который в этот момент уезжал, исчезал бы вместо этого разом.
 */
function overlay(id, show) {
  const el = $(id);
  if (el.classList.contains('hidden') === !show) return Promise.resolve();
  return transition(() => el.classList.toggle('hidden', !show));
}

/**
 * Закрыть открытый лист, уходя со вкладки. Меню под листом видно и нажимается,
 * поэтому уйти с него могут в любой момент, — а лист, оставшийся поверх нового
 * экрана, был бы тупиком. Прячем его прямо в переходе экрана: отдельный
 * переход оборвал бы этот же и лист исчез бы рывком.
 */
function dropSheets() {
  if (!$('overlay-day').classList.contains('hidden')) {
    clearTimeout(dayCommentTimer);
    if (dayKey) saveComment(dayKey, $('day-comment').value);
    dayKey = null;
    $('overlay-day').classList.add('hidden');
  }
  if (!$('overlay-align').classList.contains('hidden')) {
    $('overlay-align').classList.add('hidden');
    state.align = null;
  }
}

async function showScreen(name) {
  // Верстак живёт ровно столько, сколько человек стоит на экране видео.
  // Ушёл — от собранного года на телефоне не остаётся ничего.
  if (state.screen === 'video' && name !== 'video') {
    resetPlayer();
    await store.clearBench().catch(() => {});
  }
  state.screen = name;
  await transition(() => {
    dropSheets();
    freeUrls();
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    $('screen-' + name).classList.remove('hidden');
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('tab-active', t.dataset.screen === name);
    }
    window.scrollTo(0, 0);
  });
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
  // Скорость — общая настройка: она уезжает в config.json, значит второй
  // родитель видит тот же темп. Раньше ползунок жил сам по себе и после
  // перезапуска возвращался к тому, что подставил браузер.
  $('video-fps').value = String(state.cfg.videoFps);
  $('fps-label').textContent = String(state.cfg.videoFps);

  // Без даты рождения счётчика дней нет, подписывать нечем — прячем совсем,
  // чтобы галочка не обещала того, чего не будет.
  const canCaption = Boolean(state.cfg.birthDate);
  $('video-caption').closest('.check').classList.toggle('hidden', !canCaption);
  $('video-caption').checked = Boolean(state.cfg.videoCaption);
  if (canCaption) {
    $('caption-sample').textContent = captionFor($('video-from').value || D.todayKey());
  }

  await refreshVideoInfo();
}

// --- привязка событий -------------------------------------------------------

function bind() {
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => showScreen(t.dataset.screen);
  }
  // фото
  let pendingDate = null;
  const pick = (date, input) => () => {
    if (!requireOnline()) return;
    pendingDate = date();
    $(input).click();
  };
  $('btn-camera').onclick = pick(D.todayKey, 'file-camera');
  $('btn-library').onclick = pick(D.todayKey, 'file-input');
  $('day-replace').onclick = pick(() => dayKey, 'file-input');
  $('day-add').onclick = pick(() => dayKey, 'file-input');

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

  $('btn-ghost').onclick = () => openGhost(D.todayKey());
  $('ghost-close').onclick = closeGhost;
  $('ghost-shoot').onclick = shootGhost;
  $('ghost-retake').onclick = retakeGhost;
  $('ghost-save').onclick = saveGhost;
  $('ghost-flip').onclick = async () => {
    if (!state.ghost) return;
    try {
      await state.ghost.cam.flip();
    } catch (e) {
      toast(cameraError(e), 4200);
    }
  };
  $('ghost-opacity').oninput = e => {
    $('ghost-opacity-label').textContent = e.target.value;
    if (state.ghost) state.ghost.cam.setAlpha(Number(e.target.value) / 100);
  };

  $('btn-align').onclick = () => { if (requireOnline()) openAlign(D.todayKey()); };
  $('day-align').onclick = () => { if (requireOnline()) openAlign(dayKey); };
  $('align-close').onclick = () => { overlay('overlay-align', false); state.align = null; };
  $('align-reset').onclick = () => {
    state.align.l = null;
    state.align.r = null;
    state.align.guessed = false;    // сбросили — значит ставят заново, не «как вчера»
    drawDots();
  };
  $('align-save').onclick = saveAlign;
  bindAlignStage();

  const removeDay = async key => {
    if (!requireOnline()) return;
    const ok = await ask({
      title: 'Удалить этот день?',
      text: 'Снимок и комментарий пропадут из общей папки — у всех, кто снимает ' +
            'вместе с вами. В корзине Диска файл полежит ещё 30 дней.',
    });
    if (!ok) return;

    // Гасим отложенные сохранения и то, что делает закрытие карточки, — иначе
    // только что удалённый день воскресает комментарием.
    clearTimeout(dayCommentTimer);
    clearTimeout(todayCommentTimer);
    dayKey = null;
    $('day-comment').value = '';
    $('today-comment').value = '';

    progressOpen('Удаляю из общей папки');
    let removed;
    try {
      removed = await store.removeDay(drive(), key);   // сначала папка, потом кэш
    } catch (e) {
      progressClose();
      toast(e.message || 'Не удалось удалить из папки — на телефоне тоже оставил');
      return;
    }
    progressClose();
    freeUrls();
    closeDay();
    await renderToday();
    if (!$('screen-calendar').classList.contains('hidden')) await renderCalendar();

    // Файл лежит в корзине Диска 30 дней, поэтому «вернуть» — это снятый
    // флажок, а не хранение копии у нас. Десяти секунд хватает, чтобы понять,
    // что удалил не тот день; дальше остаётся корзина Диска.
    toast('Удалено', 10000, { label: 'Вернуть', run: () => undoRemove(removed) });
  };
  const undoRemove = async removed => {
    progressOpen('Возвращаю день');
    try {
      await store.restoreDay(drive(), removed);
    } catch (e) {
      progressClose();
      toast(e.message || 'Не удалось вернуть — день остался в корзине Диска', 4200);
      return;
    }
    progressClose();
    freeUrls();
    await renderToday();
    if (!$('screen-calendar').classList.contains('hidden')) await renderCalendar();
    toast('День вернулся');
  };

  $('btn-delete').onclick = () => removeDay(D.todayKey());
  $('day-share').onclick = () => shareDay(dayKey);
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
  $('video-fps').onchange = async e => {
    await settings.set('videoFps', Number(e.target.value));
    state.cfg = await settings.all();
    await saveShared();
  };
  // Промежуток сменился — показанный ряд кадров уже не про него.
  $('video-caption').onchange = async e => {
    await settings.set('videoCaption', e.target.checked);
    state.cfg = await settings.all();
    await saveShared();
    // Кадры уже нарисованы без подписи — перерисовываем то, что на экране.
    if (player.frames.length) await drawFrame(player.i);
  };

  const onRange = () => { resetPlayer(); refreshVideoInfo(); };
  $('video-from').onchange = onRange;
  $('video-to').onchange = onRange;
  // Календарь по нажатию на поле открывает браузер сам, но не везде и не
  // всегда: где-то нажатие лишь ставит курсор в «день». Подстраховываемся —
  // если пикер уже открылся, повторный вызов просто бросит исключение.
  for (const id of ['video-from', 'video-to']) {
    $(id).onclick = e => {
      if (!e.currentTarget.showPicker) return;
      try { e.currentTarget.showPicker(); } catch { /* уже открыт */ }
    };
  }
  $('btn-preview').onclick = playerToggle;

  // Нажатие по самому кадру — то же самое: большая мишень вместо кнопки.
  $('video-preview').onclick = e => {
    if (e.target.closest('#video-result')) return;   // у видео свои элементы
    playerToggle();
  };
  $('video-preview').onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    playerToggle();
  };

  // Перемотка: тянут ползунок — показ встаёт на паузу и слушается пальца.
  $('video-seek').oninput = e => {
    playerStop();
    drawFrame(Number(e.target.value));
  };
  $('btn-render').onclick = renderVideo;
  // Из «Настроек» выгружается весь альбом: промежутка там не выбирают, и
  // молча зависеть от дат на другом экране кнопка не должна.
  $('btn-frames-zip').onclick = async () => framesToZip(await allDays());

  // настройки
  // Общие настройки живут в config.json в папке, поэтому уезжают туда сразу —
  // тогда второй телефон получит их при ближайшем обновлении.
  const saveShared = async () => {
    state.cfg = await settings.all();
    if (!configured() || !state.cfg.driveEmail || !navigator.onLine) return;
    try { await pushProfile(drive()); }
    catch (e) { toast(e.message || 'Настройка сохранена только на этом телефоне'); }
  };

  const saveField = (id, key, transform = v => v || null) =>
    $(id).onchange = async e => {
      await settings.set(key, transform(e.target.value));
      await saveShared();
      toast('Сохранено');
    };
  saveField('set-birth', 'birthDate');

  const renameProjectFolder = async name => {
    if (!configured() || !state.cfg.driveEmail || !navigator.onLine) return null;
    return store.renameProject(drive(), name);
  };

  // Имя ребёнка — ещё и имя его папки в Диске. Переименовываем сразу: искать
  // «Алису» человек будет по имени, а не по тому, как папку назвали в день
  // заведения альбома.
  $('set-name').onchange = async e => {
    const name = e.target.value.trim();
    await settings.set('babyName', name);
    await saveShared();
    try {
      const got = await renameProjectFolder(name);
      state.cfg = await settings.all();
      await renderAlbumsCard();
      toast(got ? `Сохранено, папка теперь «${got}»` : 'Сохранено');
    } catch {
      toast('Сохранено, но папку переименовать не вышло');
    }
  };

  $('btn-album-new').onclick = newAlbum;

  $('set-theme').onclick = async e => {
    const btn = e.target.closest('.theme-opt');
    if (!btn) return;
    applyTheme(btn.dataset.theme);
    await settings.set('theme', btn.dataset.theme);
    await saveShared();
    renderThemeCard();
    toast('Сохранено');
  };

  // Google
  $('conn-fix').onclick = async () => {
    try {
      await connectGoogle($('conn-fix'));
      toast('Google на связи');
      await renderGoogleCard();
      syncQuietly();
    } catch (e) {
      toast(e.message || 'Не получилось подключить Google');
    }
  };

  // Вход из «Настроек»: сам разберётся и с аккаунтом, и с папкой.
  $('btn-google-connect').onclick = async () => {
    try {
      await connectGoogle($('btn-google-connect'));
    } catch (e) {
      toast(e.message || 'Не получилось подключить Google');
      return;
    }
    freeUrls();
    await renderGoogleCard();
    await runSync();
    await renderToday();
  };

  $('btn-sync').onclick = runSync;

  $('btn-pick-folder').onclick = async () => {
    try {
      const folder = await pickShared();
      if (!folder) return;
      await renderGoogleCard();
      toast(`Папка «${folder.name}» подключена`);
      await runSync();
    } catch (e) {
      toast(e.message || 'Не удалось выбрать папку');
    }
  };

  $('btn-google-off').onclick = async () => {
    const ok = await ask({
      title: 'Выйти из учётной записи Google?',
      text: 'Телефон забудет аккаунт, синхронизация остановится. Фотографии и ' +
            'комментарии останутся и здесь, и в папке Диска — чтобы снимать ' +
            'в неё дальше, нужно будет войти снова, можно другим аккаунтом.',
      yes: 'Выйти',
    });
    if (!ok) return;
    await G.revoke();
    await settings.merge({ driveEmail: null });
    state.cfg = await settings.all();
    setConn('off', '', 'Google не подключён');
    await renderGoogleCard();
    toast('Вы вышли из учётной записи Google');
  };

  $('btn-export').onclick = async () => {
    const dates = await entries.allDates();
    if (!dates.length) { toast('Пока нечего выгружать'); return; }
    progressOpen('Собираю архив');
    try {
      // Архив — это оригиналы, и на телефоне их нет: они лежат в папке и
      // качаются по ходу упаковки, прямо в собираемый файл. В базу по дороге
      // не ложится ничего; верстак вытирается следом на всякий случай — на
      // нём могли остаться кадры от сборки видео.
      const { zip, skipped } = await exportArchive(canPull() ? drive() : null,
        (d, t, label) => progressSet(d, t, label));
      progressClose();
      const name = `${state.cfg.babyName || 'archive'}-${D.todayKey()}.zip`;
      const how = await saveBlob(zip, name);
      if (skipped) {
        toast(`В архиве нет ${skipped} ${D.plural(skipped, 'дня', 'дней', 'дней')}: ` +
          'эти снимки не удалось забрать из папки', 4200);
      } else if (how === 'downloaded') toast('Архив сохранён в «Загрузки»');
      state.cfg = await settings.all();
      await renderMore();
    } catch (e) {
      progressClose();
      toast(e.message || 'Не удалось собрать архив');
    } finally {
      await store.clearBench().catch(() => {});
    }
  };

  $('btn-import').onclick = () => $('zip-input').click();
  $('zip-input').onchange = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    progressOpen('Читаю архив');
    try {
      const res = await importArchive(drive(), file, { replace: false },
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
  // Тёмное оформление убрано: у тех, кто на нём сидел, в настройках (и в
  // config.json в папке) осталось его имя. Переписываем один раз, иначе
  // второму родителю так и уезжало бы значение, которого больше нет.
  if (!THEMES.includes(state.cfg.theme)) {
    await settings.set('theme', 'girl');
    state.cfg = await settings.all();
  }
  applyTheme(state.cfg.theme);

  // Если прошлый заход убили посреди сборки, на верстаке остались кадры.
  // Это единственное место, где снимок мог пережить закрытие приложения, —
  // и здесь оно кончается.
  await store.clearBench().catch(() => {});

  // Настройка проходится один раз. Дальше приложение открывается офлайн:
  // иначе оно не работало бы там, где чаще всего и снимают, — в самолёте,
  // в роддоме, на даче без связи.
  let justSetUp = false;
  if (!state.cfg.onboardingDone || !state.cfg.birthDate) {
    await runOnboarding({ onToast: toast });
    state.cfg = await settings.all();
    applyTheme(state.cfg.theme);
    justSetUp = true;
  }

  // Первым делом — связь с Google, и только потом приложение: человек должен
  // войти уже зная, уедет ли снятое сегодня в общую папку.
  await runGate();

  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();

  bind();
  $('app').classList.remove('hidden');
  await showScreen('today');

  // Сразу после настройки опись тянется на виду, с прогрессом: человек должен
  // попасть в заполненный календарь, а не в пустой, который молча догружается.
  // Стоит это одного запроса — снимки приедут потом и поодиночке.
  if (justSetUp && configured() && state.cfg.driveEmail) await runSync();
  else syncQuietly();

  // Снимки живут в памяти вкладки. Уходя — стираем и их, и предпросмотр:
  // после закрытия приложения на телефоне не должно остаться ни кадра.
  // Верстак вытирается тут же, но полагаться на это нельзя: браузер вправе
  // убить вкладку, не дав транзакции дойти. Настоящая гарантия — уборка при
  // запуске, она выше.
  window.addEventListener('pagehide', () => {
    closeGhost();                      // камера не должна гореть в фоне
    freeUrls();
    store.clearPreview();
    blobs.clear();
    store.clearBench().catch(() => {});
  });

  window.addEventListener('online', () => {
    applyOnlineState();
    checkConnection().then(() => syncQuietly());
  });
  window.addEventListener('offline', () => { applyOnlineState(); checkConnection(); });

  // Токен живёт час, и за это время приложение обычно успевают свернуть.
  // Возвращаются к нему — перепроверяем, чтобы галочка не врала.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (Date.now() - state.connAt < 300000) return;
    checkConnection();
  });

  applyOnlineState();
}

boot();
