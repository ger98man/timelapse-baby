// Авторизация через Google. Браузерное приложение не получает refresh-токен —
// только часовой access-токен. Поэтому приложение спроектировано так, что
// токен нужен исключительно в момент синхронизации: снимать, писать
// комментарии и смотреть таймлапс можно без интернета и без Google вообще.

import { GOOGLE } from '../config.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/**
 * Доступ к Диску целиком, а не к «своим файлам».
 *
 * Хотелось обойтись drive.file — он честнее и просит меньше. Не выходит:
 * этот доступ выдаётся не приложению вообще, а паре «приложение + человек».
 * Второй родитель, выбрав общую папку, получает права на саму папку, а на
 * лежащие в ней снимки первого — нет: Диск отвечает на них «файл не найден».
 * Общего альбома при этом не получается вовсе, а это и есть смысл затеи.
 */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const SCOPES = ['openid', 'email', 'profile', DRIVE_SCOPE].join(' ');

const TOKEN_KEY = 'google-token';

let gisPromise = null;
let tokenClient = null;

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve(window.google);
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => reject(new Error('Не удалось загрузить Google — проверьте интернет'));
    document.head.appendChild(s);
  });
  return gisPromise;
}

/**
 * Токен помнит, что именно ему разрешили. Иначе после расширения доступа
 * сохранённый со старым разрешением токен выглядел бы живым ещё час и всё
 * это время получал бы отказы, а человек — «непонятно, почему не работает».
 */
function usable(t) {
  return Boolean(t.granted) && t.granted.split(' ').includes(DRIVE_SCOPE);
}

function readStored() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!usable(t)) return null;
    // минута запаса, чтобы токен не протух посреди загрузки
    return t.expiresAt - 60000 > Date.now() ? t : null;
  } catch {
    return null;
  }
}

function store(token) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch { /* приватный режим */ }
}

export function forget() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ничего */ }
}

/**
 * Выбрасывает токен, который Google только что не принял. Сверяем с
 * сохранённым: пока один запрос спотыкался о мёртвый токен, соседний мог уже
 * получить новый, и стирать его вслепую — значит ходить за токеном по кругу.
 */
export function invalidate(accessToken) {
  const t = readStored();
  if (!t || t.accessToken === accessToken) forget();
}

/** Вызывать после смены clientId — иначе останется клиент со старым ключом. */
export function resetClient() {
  tokenClient = null;
  forget();
}

async function client() {
  if (tokenClient) return tokenClient;
  const g = await loadGis();
  tokenClient = g.accounts.oauth2.initTokenClient({
    client_id: GOOGLE.clientId,
    scope: SCOPES,
    callback: () => {},   // подменяется на каждый запрос
  });
  return tokenClient;
}

/**
 * Ошибка входа. Помечаем их все одним признаком: снаружи важно не то, что
 * именно сказал Google, а что чинится это одинаково — тапом по «войти».
 * Само окно Google открывается только из обработчика нажатия, поэтому
 * подсунуть его молча вместо ошибки нельзя, а вот вывести человека к кнопке —
 * можно, и это единственный выход, который работает.
 */
function authError(message) {
  const e = new Error(message);
  e.code = 'auth';
  return e;
}

/** Google отвечает кодами; человеку нужно знать, что именно чинить. */
export function explain(code, description) {
  const map = {
    popup_closed: 'Окно Google закрыли, не завершив вход',
    popup_failed_to_open:
      'Браузер заблокировал окно Google. Разрешите всплывающие окна для этого сайта.',
    access_denied:
      'Доступ не выдан. На экране Google нужно нажать «Разрешить» — иначе приложению некуда складывать фото.',
    invalid_client:
      'Google не узнал Client ID. Проверьте, что скопировали его целиком, вместе с «.apps.googleusercontent.com».',
    invalid_request:
      `Google не принимает адрес этой страницы. Добавьте ${location.origin} в Authorized JavaScript origins у вашего OAuth client ID.`,
    idpiframe_initialization_failed:
      `Google не принимает адрес этой страницы. Добавьте ${location.origin} в Authorized JavaScript origins у вашего OAuth client ID.`,
  };
  return map[code] || description || 'Google отказал в доступе';
}

/**
 * Просит токен. interactive:false — тихая попытка: сработает, если Google-сессия
 * жива и браузер не режет сторонние куки. В Safari тихая попытка часто падает,
 * и тогда нужен один тап пользователя. Это ожидаемо, а не поломка.
 *
 * chooseAccount — показать выбор аккаунта. Нужно там, где человек сам нажал
 * «войти»: у него может быть рабочая почта, личная и почта второго родителя,
 * и решать за него, какая из них «текущая», нельзя. В остальных случаях
 * (час прошёл, токен протух) выбор не нужен — молча продлеваем тот же вход,
 * иначе приложение будет спрашивать одно и то же каждый час.
 */
export function requestToken({ interactive = true, chooseAccount = false } = {}) {
  return new Promise(async (resolve, reject) => {
    const tc = await client();
    tc.callback = resp => {
      if (resp.error) return reject(authError(explain(resp.error, resp.error_description)));
      const token = {
        accessToken: resp.access_token,
        expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
        granted: resp.scope || '',
      };
      // Google разрешает выдать не всё, о чём просили: галочки на экране
      // согласия снимаются по одной. Без доступа к Диску приложению нечего
      // делать, и сказать об этом надо сразу, а не первым отказом Диска.
      if (!usable(token)) {
        return reject(authError(
          'Без доступа к Google Диску приложению некуда складывать фото. ' +
          'На экране Google нужно оставить галочку про Диск.'));
      }
      store(token);
      resolve(token);
    };
    tc.error_callback = err => reject(authError(explain(err && err.type, err && err.message)));
    try {
      const prompt = !interactive ? 'none' : chooseAccount ? 'select_account' : '';
      tc.requestAccessToken({ prompt });
    } catch (e) {
      reject(e);
    }
  });
}

/** Действующий токен или null. Ничего не показывает пользователю. */
export function currentToken() {
  return readStored();
}

/**
 * Токен для запроса. Сначала берём сохранённый, потом пробуем тихо,
 * и только если разрешено — показываем окно Google.
 *
 * stale — токен, который Google уже отверг. Срок годности лежит в самом
 * токене, но доступ отзывают и раньше срока: сменили пароль, выкинули
 * приложение из аккаунта, пересобрали ключи проекта. Сохранённый токен при
 * этом выглядит свежим, и без этой подсказки приложение упрямо носило бы
 * мёртвый токен до конца часа, отвечая на каждую попытку одним и тем же 401.
 */
export async function getAccessToken({ interactive = false, stale = null } = {}) {
  if (stale) invalidate(stale);
  const stored = readStored();
  if (stored) return stored.accessToken;
  try {
    const t = await requestToken({ interactive: false });
    return t.accessToken;
  } catch (e) {
    if (!interactive) throw authError('Нужно переподключить Google');
  }
  const t = await requestToken({ interactive: true });
  return t.accessToken;
}

export async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) throw new Error('Google не отдал профиль (' + res.status + ')');
  const j = await res.json();
  return { email: j.email, name: j.name || '', picture: j.picture || '' };
}

/** Список разрешённых — про удобство, а не про безопасность (см. config.js). */
export function emailAllowed(email) {
  const list = GOOGLE.allowedEmails;
  if (!list || !list.length) return true;
  return list.map(e => e.trim().toLowerCase()).includes(String(email).toLowerCase());
}

export async function revoke() {
  const t = readStored();
  forget();
  if (!t) return;
  try {
    const g = await loadGis();
    g.accounts.oauth2.revoke(t.accessToken, () => {});
  } catch { /* и так вышли */ }
}
