// Тонкая обёртка над Google Drive REST v3 — ровно те вызовы, что нужны.
//
// Доступ к Диску у приложения полный (почему — см. google.js), но ходит оно
// только в папку альбома: и опись, и размер альбома считаются по её же
// папкам. Ничего вне альбома приложение не читает и не трогает.
//
// getToken передаётся снаружи, а fetch можно подменить: на этом держатся тесты.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * День и вид файла. Обычно они лежат в метаданных приложения, но в общей папке
 * Google их не показывает: метаданные приватны, а второму родителю выдан
 * доступ на папку, а не на каждый файл в ней. Имя же видно всегда — и это
 * дата, ради чего файлы так и названы.
 */
export function describeFile(f) {
  const p = f.appProperties || {};
  if (p.day) return { day: p.day, kind: p.kind || 'photo' };
  const m = /^(\d{4}-\d{2}-\d{2})\.(jpg|txt)$/i.exec(f.name || '');
  if (!m) return null;
  return { day: m[1], kind: m[2].toLowerCase() === 'txt' ? 'note' : 'photo' };
}

/** Метка, по которой приложение находит свои файлы одним запросом. */
export const TAG = 'everyday';

/**
 * Имя папки подписываем почтой владельца. Без этого у второго родителя в окне
 * выбора оказываются две строчки «TimelapseBaby» — своя и общая, — и понять,
 * какую подключать, нельзя. Почта же видна и в Диске, и в списке доступов.
 */
export const rootName = (base, email) => (email ? `${base} — ${email}` : base);

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createDrive({ getToken, fetchImpl = fetch.bind(globalThis) }) {
  const folderCache = new Map();   // 'rootId/2026/09' -> folderId

  async function call(url, { method = 'GET', body, headers = {}, raw = false } = {}) {
    let lastError;
    let stale = null;                 // токен, который Google только что отверг
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = await getToken(stale ? { stale } : undefined);
      const res = await fetchImpl(url, {
        method,
        body,
        headers: { Authorization: 'Bearer ' + token, ...headers },
      });
      if (res.ok) return raw ? res : res.json();

      // 429 и пятисотые — подождать и повторить, остальное чинить бесполезно
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Google ответил ${res.status}`);
        await sleep(400 * Math.pow(2, attempt));
        continue;
      }

      // 401 — сохранённый токен мёртв. Такое бывает и до истечения часа:
      // доступ отозвали в настройках Google, сменили пароль, пересобрали
      // ключи проекта. Выбрасываем его и повторяем с новым — ровно один раз,
      // иначе разговор с Google превратится в бесконечный круг.
      if (res.status === 401 && !stale) {
        stale = token;
        continue;
      }
      let detail = '';
      try { detail = (await res.json()).error.message; } catch { /* пустой ответ */ }

      // Отдельный случай: папку выбрали, но доступ к ней приложению не выдан.
      // Техническое «has not granted the app … access» не говорит человеку
      // ничего, а починка ровно одна — выбрать папку заново.
      if (res.status === 403 && /has not granted the app/.test(detail)) {
        throw new Error(
          'Приложению не выдан доступ к этой папке. Нажмите «Выбрать папку ' +
          'в Google Диск» и выберите её на вкладке «Доступные мне». ' +
          'Если папку так и не пускает — попросите первого родителя дать ' +
          'вам права редактора.');
      }
      // И новый токен не приняли — значит дело не в токене, а во входе.
      // Английское «invalid authentication credentials» человеку не говорит
      // ничего, а починка ровно одна: войти в Google заново.
      if (res.status === 401) {
        const e = new Error('Google не принял вход — похоже, он устарел. Войдите заново.');
        e.code = 'auth';
        throw e;
      }
      throw new Error(`Google Диск: ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    throw lastError;
  }

  function q(parts) {
    return parts.filter(Boolean).join(' and ');
  }

  const inAny = ids => '(' + ids.map(id => `'${id}' in parents`).join(' or ') + ')';

  async function list(query, fields = 'files(id,name,mimeType,modifiedTime,md5Checksum,appProperties,parents,thumbnailLink),nextPageToken') {
    const out = [];
    let pageToken;
    do {
      const params = new URLSearchParams({
        q: query, fields, pageSize: '1000', spaces: 'drive',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await call(`${API}/files?${params}`);
      out.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async function createFolder(name, parentId, appProperties) {
    const meta = { name, mimeType: FOLDER_MIME };
    if (parentId) meta.parents = [parentId];
    if (appProperties) meta.appProperties = appProperties;
    return call(`${API}/files?fields=id,name,ownedByMe,appProperties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
  }

  /**
   * Папка приложения, если она есть. Ничего не создаёт — и это главное:
   * альбом заводит человек, а не побочный эффект запуска. Папка, созданная
   * молча, — это второй альбом у того, кто хотел подключиться к общему,
   * и вторая одинаковая строчка в окне выбора у второго родителя.
   */
  async function findRoot(knownId) {
    const fields = 'id,name,trashed,ownedByMe,appProperties';
    if (knownId) {
      try {
        const f = await call(`${API}/files/${knownId}?fields=${fields}`);
        if (!f.trashed) return f;
      } catch { /* удалили или отобрали доступ — поищем по метке */ }
    }
    const found = await listRoots();
    return found[0] || null;
  }

  /**
   * Все папки альбома, помеченные приложением: и своя, и те, к которым
   * подключились. Нужны, чтобы не предлагать завести вторую свою, когда
   * первая уже лежит в Диске.
   */
  async function listRoots() {
    return list(q([
      `appProperties has { key='${TAG}Root' and value='1' }`,
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
    ]), 'files(id,name,ownedByMe,appProperties),nextPageToken');
  }

  /** Заводит папку альбома. Вызывается только по явному решению человека. */
  async function createRoot(name) {
    return createFolder(name, null, { [`${TAG}Root`]: '1', [`${TAG}Named`]: '1' });
  }

  /**
   * Дописывает почту к имени своей папки. Только своей: общую, заведённую
   * первым родителем, переименовывать нельзя — она у него на виду.
   *
   * Отметка в метаданных нужна, чтобы сделать это ровно один раз. Иначе
   * человек, переименовавший папку по-своему, спорил бы с приложением
   * при каждой синхронизации.
   */
  async function nameRoot(root, email) {
    if (!email || !root.ownedByMe) return root.name;
    if (root.appProperties && root.appProperties[`${TAG}Named`]) return root.name;
    const name = rootName(root.name, email);
    await call(`${API}/files/${root.id}?fields=id,name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, appProperties: { [`${TAG}Named`]: '1' } }),
    });
    return name;
  }

  async function ensureChildFolder(name, parentId) {
    const key = `${parentId}/${name}`;
    if (folderCache.has(key)) return folderCache.get(key);
    const found = await list(q([
      `name='${name}'`,
      `'${parentId}' in parents`,
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
    ]), 'files(id,name),nextPageToken');
    const id = found.length ? found[0].id : (await createFolder(name, parentId)).id;
    folderCache.set(key, id);
    return id;
  }

  /** root/2026/09 — папки только чтобы человеку было удобно листать Диск. */
  async function folderForDay(rootId, dateKey) {
    const [year, month] = dateKey.split('-');
    const y = await ensureChildFolder(year, rootId);
    return ensureChildFolder(month, y);
  }

  function multipart(meta, blob, mime) {
    const boundary = 'everyday' + Math.random().toString(36).slice(2);
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    return {
      body: new Blob([head, blob, tail]),
      type: `multipart/related; boundary=${boundary}`,
    };
  }

  /**
   * Кладёт или обновляет файл приложения.
   * dateKey = null — файл не про конкретный день (например, config.json),
   * такой лежит прямо в корне папки.
   * @param {{rootId, dateKey, name, blob, mime, kind, fileId?}} opts
   */
  async function putDayFile({ rootId, dateKey, name, blob, mime, kind, fileId, props }) {
    const meta = { name, appProperties: { [TAG]: '1', kind, ...(props || {}) } };
    if (dateKey) meta.appProperties.day = dateKey;
    if (!fileId) {
      meta.parents = [dateKey ? await folderForDay(rootId, dateKey) : rootId];
    }

    const { body, type } = multipart(meta, blob, mime);
    const url = fileId
      ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime,md5Checksum`
      : `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime,md5Checksum`;
    return call(url, { method: fileId ? 'PATCH' : 'POST', body, headers: { 'Content-Type': type } });
  }

  /**
   * Сколько места занимает альбом и сколько осталось в самом Диске.
   *
   * Считаем по файлам альбома — мерить надо именно его, а не весь Диск.
   * Файлы в общей папке лежат на квоте того, кто их залил, — поэтому
   * «свободно» тут про аккаунт, которым вошли, а не про папку.
   * @returns {Promise<{albumBytes:number, files:number, used:number, limit:number}>}
   */
  async function usage(rootId) {
    const files = await list(q([
      `appProperties has { key='${TAG}' and value='1' }`,
      rootId && inAny(await albumFolders(rootId)),
      'trashed=false',
    ]), 'files(id,size),nextPageToken');
    const albumBytes = files.reduce((n, f) => n + Number(f.size || 0), 0);
    const about = await call(`${API}/about?fields=storageQuota`);
    const quota = about.storageQuota || {};
    return {
      albumBytes,
      files: files.length,
      used: Number(quota.usage || 0),
      // Безлимитные аккаунты limit не присылают — там и показывать нечего.
      limit: quota.limit ? Number(quota.limit) : 0,
    };
  }

  /** Папки альбома: сам корень и все `ГГГГ/ММ` под ним. */
  async function albumFolders(rootId) {
    const kids = async parents => (parents.length
      ? (await list(q([inAny(parents), `mimeType='${FOLDER_MIME}'`, 'trashed=false']),
          'files(id),nextPageToken')).map(f => f.id)
      : []);
    const years = await kids([rootId]);
    return [rootId, ...years, ...await kids(years)];
  }

  /**
   * Опись альбома. Обычный путь — запрос по метке приложения, но обязательно
   * внутри папок альбома: метку ставит наш же код, и у второго родителя
   * рядом с общей папкой обычно лежит собственный, заведённый по ошибке
   * альбом с такой же меткой на файлах. Поиск по одной метке приносил их
   * вперемешку — приложение показывало свои старые дни вместо общих и читало
   * настройки из чужого config.json, при том что новые снимки уходили уже
   * в общую папку.
   *
   * Пусто по метке при известной папке всегда стоит перепроверить обходом:
   * своя пустая папка ответит дёшево, а полная общая — покажет содержимое
   * даже там, где метки не видно.
   */
  async function listDayFiles(rootId) {
    if (!rootId) {
      return list(q([
        `appProperties has { key='${TAG}' and value='1' }`,
        'trashed=false',
      ]));
    }
    const tagged = await list(q([
      `appProperties has { key='${TAG}' and value='1' }`,
      inAny(await albumFolders(rootId)),
      'trashed=false',
    ]));
    return tagged.length ? tagged : listTree(rootId);
  }

  /**
   * Лежит ли файл в этой папке альбома. Спрашивают об этом в одном месте:
   * когда в папке не видно ни одного дня, а в кэше дни есть, — и надо решить,
   * то ли это дни отсюда и доступ к ним пропал, то ли кэш вообще от прежней
   * папки. Разница в цене ошибки: в первом случае стирать нельзя, во втором —
   * нужно, иначе человек смотрит на чужой альбом.
   */
  async function belongsToAlbum(rootId, fileId) {
    const f = await call(`${API}/files/${fileId}?fields=parents`);
    const ids = new Set(await albumFolders(rootId));
    return (f.parents || []).some(p => ids.has(p));
  }

  /**
   * Правит только метаданные, не трогая содержимое. Нужно, когда меняется
   * разметка глаз: сам снимок при этом остался прежним, и перезаливать
   * мегабайты ради тридцати байт было бы расточительно.
   */
  async function updateProps(fileId, props) {
    return call(`${API}/files/${fileId}?fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: props }),
    });
  }

  async function download(fileId) {
    const res = await call(`${API}/files/${fileId}?alt=media`, { raw: true });
    return res.blob();
  }

  /**
   * Миниатюра, которую Google уже сделал сам. Приезжает вместе со списком
   * файлов, весит килобайты вместо мегабайт и не требует качать оригинал —
   * на этом держится дешёвый календарь.
   *
   * Ссылка короткоживущая и на чужом хосте, поэтому запрос идёт с токеном и
   * без ретраев: протухла — обновим список файлов и получим новую.
   */
  async function trash(fileId) {
    return call(`${API}/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  /**
   * Достать файл обратно из корзины. Работает ровно до того, как корзину
   * очистят: Диск держит удалённое 30 дней, и всё это время удаление обратимо.
   */
  async function untrash(fileId) {
    return call(`${API}/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: false }),
    });
  }

  /** Ссылка на папку — чтобы отдать второму родителю через обычный доступ Диска. */
  async function folderLink(rootId) {
    const f = await call(`${API}/files/${rootId}?fields=webViewLink`);
    return f.webViewLink;
  }

  /**
   * Всё, что лежит прямо в папке, — по родителю, а не по метке приложения.
   *
   * Метку ставит только наш код, а config.json в общей папке мог появиться
   * иначе: его правили руками или писал другой аккаунт. Для второго родителя
   * это разница между «всё уже настроено» и «введите имя заново».
   *
   * Заодно это единственный честный ответ на вопрос «а видит ли приложение
   * вообще, что внутри»: пустой список у непустой папки означает, что доступ
   * выдан на саму папку, но не на её содержимое.
   */
  async function listChildren(rootId) {
    if (!rootId) return [];
    return list(q([`'${rootId}' in parents`, 'trashed=false']));
  }

  /**
   * Обход папки сверху вниз: корень → годы → месяцы → файлы.
   *
   * Своя опись строится одним запросом по метке приложения, но метка — вещь
   * приватная: Google показывает её только тому, кому выдан доступ к самому
   * файлу. Второму родителю доступ выдан на папку, а не на каждый снимок в
   * ней, и запрос по метке возвращает пустоту при полной папке.
   *
   * Спуск по родителям от этого не зависит: раскладка альбома всего в три
   * уровня, поэтому и запросов три — год и месяц спрашиваются пачкой.
   */
  async function listTree(rootId) {
    const dive = async parents => (parents.length
      ? list(q([inAny(parents), 'trashed=false']))
      : []);

    const out = [];
    let level = await listChildren(rootId);
    for (let depth = 0; depth < 3 && level.length; depth++) {
      out.push(...level.filter(f => f.mimeType !== FOLDER_MIME));
      const folders = level.filter(f => f.mimeType === FOLDER_MIME).map(f => f.id);
      level = await dive(folders);
    }
    return out;
  }

  /** Помечает выбранную через окно Google папку как корневую для приложения. */
  async function adoptRoot(folderId) {
    await call(`${API}/files/${folderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties: { [`${TAG}Root`]: '1' } }),
    });
    return folderId;
  }

  return {
    findRoot, listRoots, createRoot, nameRoot, adoptRoot, folderForDay, putDayFile, updateProps,
    listDayFiles, listChildren, listTree, belongsToAlbum, download, trash, untrash,
    folderLink, usage,
  };
}
