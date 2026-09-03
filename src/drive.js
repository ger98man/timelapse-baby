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
 * Две метки на папках, потому что уровня теперь два.
 *
 *   HOME — дом: одна папка на человека, внутри неё лежат все альбомы и общий
 *          config.json с оформлением и настройками видео;
 *   ROOT — альбом: папка одного ребёнка, внутри неё свой config.json и годы.
 *
 * Всё, что ниже альбома, разметки не имеет: годы и месяцы — обычные папки,
 * их находят по имени и по родителю.
 */
const HOME = `${TAG}Home`;
const ROOT = `${TAG}Root`;

/**
 * Имя дома подписываем почтой владельца. Без этого у второго родителя в окне
 * выбора оказываются две строчки «Timelapse» — своя и общая, — и понять,
 * какую подключать, нельзя. Почта же видна и в Диске, и в списке доступов.
 *
 * Альбомы внутри дома так не подписывают: их имя — имя ребёнка, и почта в нём
 * только мешала бы.
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

  // owners нужен списку альбомов: у общей папки надо показать, чья она.
  // Имя владельца в самой папке не спрашивают — оно там только приписка,
  // и у папок, заведённых до всего этого, его нет вовсе.
  const FOLDER_FIELDS =
    'files(id,name,ownedByMe,parents,appProperties,owners(emailAddress)),nextPageToken';

  /**
   * Папка альбома, если она есть. Ничего не создаёт — и это главное: альбом
   * заводит человек, а не побочный эффект запуска. Папка, созданная молча, —
   * это второй альбом у того, кто хотел подключиться к общему, и вторая
   * одинаковая строчка в окне выбора у второго родителя.
   */
  async function findRoot(knownId) {
    return findMarked(knownId, listRoots);
  }

  /** Дом со всеми альбомами. Как и альбом, сам собой не заводится. */
  async function findHome(knownId) {
    return findMarked(knownId, listHomes);
  }

  async function findMarked(knownId, listAll) {
    const fields = 'id,name,trashed,ownedByMe,parents,appProperties';
    if (knownId) {
      try {
        const f = await call(`${API}/files/${knownId}?fields=${fields}`);
        if (!f.trashed) return f;
      } catch { /* удалили или отобрали доступ — поищем по метке */ }
    }
    const found = await listAll();
    return found[0] || null;
  }

  /**
   * Все папки альбомов, помеченные приложением: и свои, лежащие в доме, и
   * чужие, к которым подключились. Это и есть список, из которого человек
   * выбирает, кого он сейчас снимает.
   */
  async function listRoots() {
    const found = await list(q([
      `appProperties has { key='${ROOT}' and value='1' }`,
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
    ]), FOLDER_FIELDS);
    // Дом в списке альбомов — это предложение снимать в папку, где лежат
    // папки детей. Метки теперь взаимоисключающие, но у тех, кто подключался
    // прежними версиями, на доме могла остаться и метка альбома.
    return found.filter(f => !(f.appProperties && f.appProperties[HOME]));
  }

  /** Дома, помеченные приложением. Свой должен быть один. */
  async function listHomes() {
    return list(q([
      `appProperties has { key='${HOME}' and value='1' }`,
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
    ]), FOLDER_FIELDS);
  }

  /**
   * Корень самого Диска. Спрашиваем один раз за сессию: он нужен ровно чтобы
   * не принять «Мой диск» за дом, когда альбом лежит прямо в нём.
   */
  let myDriveId = null;
  async function driveRoot() {
    if (!myDriveId) myDriveId = (await call(`${API}/files/root?fields=id`)).id;
    return myDriveId;
  }

  /**
   * Папка, в которой лежит альбом, — если в неё можно класть новые.
   *
   * Отсюда берётся дом для второго ребёнка: человек, переключившийся в общую
   * папку, заводит его рядом с первым, а не отдельно у себя в Диске. Права
   * спрашиваем у самого Диска (`canAddChildren`), а не гадаем по владельцу:
   * общую папку могли дать и на просмотр.
   *
   * @returns {Promise<?{id:string,name:string}>} null — родителя не видно,
   *          писать в него нельзя или это «Мой диск», а не дом.
   */
  async function parentHome(albumId) {
    if (!albumId) return null;
    try {
      const album = await call(`${API}/files/${albumId}?fields=parents`);
      const parentId = (album.parents || [])[0];
      if (!parentId || parentId === await driveRoot()) return null;
      const p = await call(`${API}/files/${parentId}` +
        '?fields=id,name,ownedByMe,appProperties,capabilities(canAddChildren)');
      if (!p.capabilities || !p.capabilities.canAddChildren) return null;
      return p;
    } catch {
      return null;      // чужой корень, отозванный доступ, нет сети
    }
  }

  /** Одна папка по id. null — удалили, отобрали доступ, не ответил Диск. */
  async function getFolder(folderId) {
    if (!folderId) return null;
    try {
      const f = await call(`${API}/files/${folderId}` +
        '?fields=id,name,trashed,ownedByMe,parents,appProperties,owners(emailAddress)');
      return f.trashed ? null : f;
    } catch {
      return null;
    }
  }

  /** Год или месяц — обычная папка внутри альбома, а не альбом. */
  const isNumbered = name => /^\d{1,4}$/.test((name || '').trim());

  /** Папки внутри папки — один запрос, без файлов. */
  async function subFolders(parentId) {
    if (!parentId) return [];
    return list(q([
      `'${parentId}' in parents`,
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
    ]), FOLDER_FIELDS);
  }

  /**
   * Альбомы внутри дома.
   *
   * Метка — вещь приватная: свою Google показывает только тому, кто её
   * поставил. В чужом доме, к которому дали доступ, помеченных папок не видно
   * ни одной, и запрос по метке вернул бы «детей нет» при полном доме.
   * Поэтому метка — только предпочтение, а не условие: нет помеченных —
   * берём все папки, кроме годов.
   */
  async function listProjects(homeId) {
    const inside = await subFolders(homeId);
    const marked = inside.filter(f => f.appProperties && f.appProperties[ROOT]);
    return marked.length ? marked : inside.filter(f => !isNumbered(f.name));
  }

  /**
   * Альбомы, между которыми человек выбирает: те, что лежат в выбранной
   * главной папке. Плюс тот, в который он снимает прямо сейчас, если лежит он
   * не там, — так бывает у второго родителя, которому дали доступ на папку
   * одного ребёнка. Прятать её нельзя: список отвечает на вопрос «кого
   * снимаем», и ответ обязан быть в нём виден.
   *
   * Всё остальное, что помечено меткой альбома в Диске, сюда не попадает:
   * чужая папка, к которой подключались когда-то, — не ребёнок в этом доме.
   */
  async function albumsFor(homeId, activeId) {
    const inside = await listProjects(homeId);
    if (!activeId || inside.some(f => f.id === activeId)) return inside;
    const active = await getFolder(activeId);
    return active ? [...inside, active] : inside;
  }

  /** Заводит дом. Вызывается только по явному решению человека. */
  async function createHome(name) {
    return createFolder(name, null, { [HOME]: '1', [`${TAG}Named`]: '1' });
  }

  /** Заводит альбом внутри дома. Тоже только по явному решению человека. */
  async function createRoot(name, homeId) {
    return createFolder(name, homeId || null, { [ROOT]: '1' });
  }

  /**
   * Дописывает почту к имени своего дома. Только своего: чужой, заведённый
   * первым родителем, переименовывать нельзя — он у него на виду.
   *
   * Отметка в метаданных нужна, чтобы сделать это ровно один раз. Иначе
   * человек, переименовавший папку по-своему, спорил бы с приложением
   * при каждой синхронизации.
   */
  async function nameHome(home, email) {
    if (!email || !home.ownedByMe) return home.name;
    if (home.appProperties && home.appProperties[`${TAG}Named`]) return home.name;
    const name = rootName(home.name, email);
    await rename(home.id, name, { [`${TAG}Named`]: '1' });
    return name;
  }

  /**
   * Переименование папки. Нужно альбому: его имя — имя ребёнка, а имя правят
   * в настройках, и папка в Диске должна поехать следом. Чужие папки не
   * трогаем — они на виду у владельца, и переименовывать их не наше дело.
   */
  async function rename(fileId, name, appProperties) {
    const body = appProperties ? { name, appProperties } : { name };
    const f = await call(`${API}/files/${fileId}?fields=id,name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return f.name;
  }

  /**
   * Что за папку выбрали в окне Google: дом со всеми альбомами или альбом
   * одного ребёнка. Спрашивают об этом ровно один раз — когда второй родитель
   * подключается к общей папке, и от ответа зависит, покажем ли мы ему список
   * детей или сразу один альбом.
   *
   * Сначала смотрим метки, потом — что лежит внутри: у первого родителя метки
   * стоят, но Google показывает их только тому, кому выдан доступ к самой
   * папке, а не к её содержимому. Годы внутри — верный признак альбома,
   * помеченные папки внутри — верный признак дома.
   */
  async function folderKind(folderId) {
    let props = {};
    try {
      const f = await call(`${API}/files/${folderId}?fields=appProperties`);
      props = f.appProperties || {};
    } catch { /* метаданные не показали — решим по содержимому */ }
    if (props[HOME]) return 'home';

    // Метку альбома проверяем не первой, а последней: её могла поставить
    // прежняя версия, которая про дома ещё не знала, — и тогда она врёт.
    // Содержимое не врёт никогда.
    const inside = await subFolders(folderId);
    if (inside.some(f => f.appProperties && f.appProperties[ROOT])) return 'home';
    if (inside.some(f => isNumbered(f.name))) return 'album';
    if (props[ROOT]) return 'album';
    if (!inside.length) return 'album';

    // Меток не видно, годов внутри тоже нет — значит, это либо дом с детьми,
    // либо ещё пустой альбом. Различить их можно на этаж ниже: годы у ребёнка
    // и означают дом. Ошибка здесь дорогая — приняв дом за альбом, приложение
    // сложило бы снимки прямо в него, рядом с папками детей.
    const deeper = await list(q([
      inAny(inside.map(f => f.id)),
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
    ]), FOLDER_FIELDS);
    return deeper.some(f => isNumbered(f.name)) ? 'home' : 'album';
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

  /**
   * Помечает выбранную через окно Google папку.
   *
   * Метку ставим и на чужую: она приватная, видит её только тот, кто её
   * поставил, — владельцу папки от этого ни холодно ни жарко, а нам по ней
   * потом собирать список альбомов.
   */
  async function mark(folderId, props) {
    try {
      await call(`${API}/files/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties: props }),
      });
    } catch (e) {
      // Доступ на чтение — пометить нельзя, но смотреть можно. Падать тут
      // нельзя: человек выбрал папку, и она обязана открыться.
      if (!/^Google Диск: 40[34]/.test(e.message || '')) throw e;
    }
    return folderId;
  }

  // Метки взаимоисключающие: папка — либо дом, либо альбом. Снимаем чужую
  // явно (null у Google значит «удалить свойство»), иначе папка, однажды
  // помеченная старой версией не тем, так и осталась бы в обоих списках.
  const adoptRoot = folderId => mark(folderId, { [ROOT]: '1', [HOME]: null });
  const adoptHome = folderId => mark(folderId, { [HOME]: '1', [ROOT]: null });

  return {
    findRoot, findHome, parentHome, getFolder, listRoots, listHomes, listProjects, albumsFor,
    createRoot, createHome, nameHome, rename, folderKind, adoptRoot, adoptHome,
    folderForDay, putDayFile, updateProps,
    listDayFiles, listChildren, listTree, belongsToAlbum, download, trash, untrash,
    folderLink, usage,
  };
}
