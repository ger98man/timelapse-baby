import { entries, blobs, settings, DB_NAME } from './db.js';
import * as D from './dates.js';
import { formatBytes } from './img.js';
import { deriveFrom, drawAligned } from './align.js';
import { buildVideo, videoSupported, pickMime } from './video.js';
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
const state = {
  cfg: null,
  calYear: 0,
  calMonth: 0,
  urls: [],          // объектные URL текущего экрана, чтобы не течь памятью
  align: null,       // контекст оверлея разметки глаз
  video: null,       // последнее собранное видео
  conn: { status: 'unknown', email: '', note: '' },   // связь с Google
  connAt: 0,         // когда её проверяли в последний раз
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
function ask({ title, text = '', items = [], yes = 'Удалить', no = 'Отмена', danger = true }) {
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
  }
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = !body
    ? (canPull() ? 'загружаю снимок…' : 'снимок не загружен на этот телефон')
    : entry.eyes ? 'кадр выровнен' : 'глаза не отмечены';
  slot.appendChild(badge);
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
  return createDrive({ getToken: () => G.getAccessToken({ interactive: false }) });
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
  for (const id of ['btn-camera', 'btn-library', 'btn-align', 'btn-delete',
                    'day-align', 'day-replace', 'day-add', 'day-delete']) {
    const el = $(id);
    if (el) el.disabled = !can;
  }
  $('today-comment').disabled = !can;
  $('day-comment').disabled = !can;
  $('offline-note').classList.toggle('hidden', can);
}

/** Тихая попытка после съёмки: получилось — хорошо, нет — не мешаем. */
function syncQuietly() {
  if (!configured() || !state.cfg.autoSync || !state.cfg.driveEmail) return;
  if (!navigator.onLine) return;
  store.refresh(drive())
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
  $('conn-note').textContent = email ? '· ' + note : '';
  bar.title = ok ? `${email} — снятое уезжает в папку` : note;

  // Без сети переподключаться некуда: окно Google просто не откроется.
  // Связь вернётся — полоска позеленеет сама, кнопка тут только мешала бы.
  const fix = $('conn-fix');
  const offer = !ok && navigator.onLine;
  fix.classList.toggle('hidden', !offer);
  fix.textContent = email ? 'Переподключить' : 'Подключить';
  bar.classList.toggle('has-fix', offer);
}

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
        const root = await drive().createRoot(rootName(GOOGLE.folderName, state.cfg.driveEmail));
        await settings.merge({ driveFolderId: root.id, driveFolderName: root.name });
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
        const token = await G.getAccessToken({ interactive: true });
        const folder = await pickFolder(token);
        if (!folder) return;
        await drive().adoptRoot(folder.id);
        await settings.merge({ driveFolderId: folder.id, driveFolderName: folder.name });
        toast(`Папка «${folder.name}» подключена`);
        resolve(true);
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
  let root;
  try {
    root = await drive().findRoot(state.cfg.driveFolderId);
  } catch (e) {
    // Не дозвонились до Диска — предлагать «завести папку» тут нельзя:
    // именно так рядом со старым альбомом и появляется второй.
    toast(e.message || 'Google Диск не ответил');
    return false;
  }
  if (!root) return askWhoYouAre();

  const name = await drive().nameRoot(root, state.cfg.driveEmail);
  const patch = {};
  if (root.id !== state.cfg.driveFolderId) patch.driveFolderId = root.id;
  if (name !== state.cfg.driveFolderName) patch.driveFolderName = name;
  if (Object.keys(patch).length) {
    await settings.merge(patch);
    state.cfg = await settings.all();
  }
  return true;
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
    ['btn-sync', 'drive-link', 'btn-pick-folder', 'btn-google-off', 'google-hint',
      'btn-google-connect'].forEach(id => show(id, false));
    return;
  }
  show('google-hint', true);

  const cfg = state.cfg;
  const connected = Boolean(cfg.driveEmail);
  const token = G.currentToken();

  // Всё, что раньше делала кнопка «Пройти настройку заново», приложение делает
  // само при входе: ищет папку, а если её нет — спрашивает, кто пришёл.
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
    // Снимки на телефоне не хранятся, а качать по картинке на каждый день
    // месяца — это мегабайты ради разглядывания клеток 40×40. Галочка.
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
  applyOnlineState();
  // Комментарий лежит файлом рядом со снимком, поэтому без снимка ему негде быть
  const hasPhoto = Boolean(entry && entry.fileId);
  $('day-comment').disabled = $('day-comment').disabled || !hasPhoto;
  $('day-comment').placeholder = hasPhoto
    ? 'Комментарий…' : 'Сначала добавьте фото за этот день';
  $('overlay-day').classList.remove('hidden');

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
  $('overlay-day').classList.add('hidden');
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

  progressOpen('Сохраняю разметку');
  try {
    await store.putEyes(drive(), a.key, { lx: a.l.x, ly: a.l.y, rx: a.r.x, ry: a.r.y });
  } catch (e) {
    progressClose();
    toast(e.message || 'Разметка не сохранилась');
    return;
  }
  progressClose();

  $('overlay-align').classList.add('hidden');
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

/** Выровненные кадры из того, что уже лежит на телефоне. */
async function videoFrames() {
  const out = [];
  for (const date of await videoDays()) {
    const body = await blobs.get(date);
    if (body && body.aligned) out.push({ date, blob: body.aligned });
  }
  return out;
}

/**
 * Кадры для сборки. Здесь и только здесь качается вся история целиком: видео
 * иначе не собрать. Зато человек платит за это осознанно — нажав кнопку, а не
 * открыв приложение.
 */
async function framesForBuild(days) {
  if (!days) days = await videoDays();
  if (!days.length) return [];
  const missing = await store.missingBodies(days);
  if (missing.length) {
    if (!canPull()) {
      toast(`Без сети собираю из ${days.length - missing.length} загруженных кадров`, 3600);
    } else {
      progressOpen('Загружаю кадры');
      try {
        await store.ensureBodies(drive(), days,
          { onProgress: (d, t, label) => progressSet(d, t, label) });
      } catch (e) {
        toast(e.message || 'Не все кадры удалось загрузить');
      }
      progressClose();
    }
  }
  return videoFrames();
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
const player = {
  frames: [],        // [{date, blob}] по порядку
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
  }
  $('video-seek').value = String(i);
  $('video-pos').textContent = D.formatLong(frame.date).replace(/ \d{4}$/, '');
  // Следующий кадр начинаем грузить заранее: иначе на первом показе темп плывёт.
  if (player.frames[i + 1]) imageFor(player.frames[i + 1]);
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
  const missing = await store.missingBodies(days);
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
        (missing.length ? ` · скачаю ${missing.length} из папки` : '')],
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

const THEMES = ['default', 'girl', 'boy'];

/**
 * Оформление. Настоящее значение — в настройках, а значит и в config.json
 * рядом с фотографиями: второй родитель видит то же самое. В localStorage
 * кладём только слепок имени — по нему index.html красит экран до того, как
 * ответит база, иначе розовое приложение открывалось бы тёмной вспышкой.
 */
function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : 'default';
  const root = document.documentElement;
  if (theme === 'default') delete root.dataset.theme;
  else root.dataset.theme = theme;

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
  const active = THEMES.includes(state.cfg.theme) ? state.cfg.theme : 'default';
  for (const btn of $('set-theme').querySelectorAll('.theme-opt')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === active));
  }
}

async function renderMore() {
  const cfg = state.cfg;
  await renderGoogleCard();
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
    const u = await drive().usage();
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
  // Скорость — общая настройка: она уезжает в config.json, значит второй
  // родитель видит тот же темп. Раньше ползунок жил сам по себе и после
  // перезапуска возвращался к тому, что подставил браузер.
  $('video-fps').value = String(state.cfg.videoFps);
  $('fps-label').textContent = String(state.cfg.videoFps);
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

  $('btn-align').onclick = () => { if (requireOnline()) openAlign(D.todayKey()); };
  $('day-align').onclick = () => { if (requireOnline()) openAlign(dayKey); };
  $('align-close').onclick = () => { $('overlay-align').classList.add('hidden'); state.align = null; };
  $('align-reset').onclick = () => { state.align.l = null; state.align.r = null; drawDots(); };
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
    try {
      await store.removeDay(drive(), key);   // сначала папка, потом кэш
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
  $('video-fps').onchange = async e => {
    await settings.set('videoFps', Number(e.target.value));
    state.cfg = await settings.all();
    await saveShared();
  };
  // Промежуток сменился — показанный ряд кадров уже не про него.
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
  saveField('set-name', 'babyName', v => v.trim());
  saveField('set-birth', 'birthDate');

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
    try {
      // Архив — это оригиналы, поэтому перед выгрузкой их приходится собрать
      // на телефоне. Второе и последнее место, где это оправдано.
      const missing = await store.missingBodies(dates);
      if (missing.length && canPull()) {
        progressOpen('Загружаю снимки');
        await store.ensureBodies(drive(), dates,
          { onProgress: (d, t, label) => progressSet(d, t, label) });
      }
    } catch (e) {
      toast(e.message || 'Не все снимки удалось загрузить');
    }
    progressOpen('Собираю архив');
    try {
      const { zip, skipped } = await exportArchive((d, t, label) => progressSet(d, t, label));
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
  applyTheme(state.cfg.theme);

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
  window.addEventListener('pagehide', () => {
    freeUrls();
    store.clearPreview();
    blobs.clear();
  });

  window.addEventListener('online', () => {
    applyOnlineState();
    checkConnection().then(() => syncQuietly());
  });
  window.addEventListener('offline', () => { applyOnlineState(); checkConnection(); });

  // Токен живёт час, и за это время приложение обычно успевают свернуть.
  // Возвращаются к нему — перепроверяем, чтобы галочка не врала.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || Date.now() - state.connAt < 300000) return;
    checkConnection();
  });

  applyOnlineState();
}

boot();
