// Тонкая обёртка над Google Drive REST v3 — ровно те вызовы, что нужны.
//
// Приложение просит скоуп drive.file: оно видит только то, что само создало,
// и то, что человек явно выбрал через окно Google. Остальной Диск для него
// не существует — так и должно быть.
//
// getToken передаётся снаружи, а fetch можно подменить: на этом держатся тесты.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Метка, по которой приложение находит свои файлы одним запросом. */
export const TAG = 'everyday';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createDrive({ getToken, fetchImpl = fetch.bind(globalThis) }) {
  const folderCache = new Map();   // 'rootId/2026/09' -> folderId

  async function call(url, { method = 'GET', body, headers = {}, raw = false } = {}) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await getToken();
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
      let detail = '';
      try { detail = (await res.json()).error.message; } catch { /* пустой ответ */ }
      throw new Error(`Google Диск: ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    throw lastError;
  }

  function q(parts) {
    return parts.filter(Boolean).join(' and ');
  }

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
    return call(`${API}/files?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
  }

  /** Папка приложения. Ищем свою по метке, иначе создаём. */
  async function ensureRoot(folderName, knownId) {
    if (knownId) {
      try {
        const f = await call(`${API}/files/${knownId}?fields=id,name,trashed`);
        if (!f.trashed) return f.id;
      } catch { /* удалили или отобрали доступ — заведём заново */ }
    }
    const found = await list(q([
      `appProperties has { key='${TAG}Root' and value='1' }`,
      `mimeType='${FOLDER_MIME}'`,
      'trashed=false',
    ]));
    if (found.length) return found[0].id;
    const created = await createFolder(folderName, null, { [`${TAG}Root`]: '1' });
    return created.id;
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

  /** Все файлы приложения одним запросом — папки обходить не нужно. */
  async function listDayFiles() {
    return list(q([
      `appProperties has { key='${TAG}' and value='1' }`,
      'trashed=false',
    ]));
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
  async function downloadThumb(link, size = 400) {
    if (!link) return null;
    // ...=s220 в конце — запрошенный размер; просим свой
    const url = /=s\d+/.test(link) ? link.replace(/=s\d+.*$/, `=s${size}`) : `${link}=s${size}`;
    const token = await getToken();
    const res = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error(`Миниатюра: ${res.status}`);
    return res.blob();
  }

  /** Свежая ссылка на миниатюру одного файла — когда список уже протух. */
  async function thumbLink(fileId) {
    const f = await call(`${API}/files/${fileId}?fields=thumbnailLink`);
    return f.thumbnailLink || null;
  }

  async function trash(fileId) {
    return call(`${API}/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }

  /** Ссылка на папку — чтобы отдать второму родителю через обычный доступ Диска. */
  async function folderLink(rootId) {
    const f = await call(`${API}/files/${rootId}?fields=webViewLink`);
    return f.webViewLink;
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
    ensureRoot, adoptRoot, folderForDay, putDayFile, updateProps,
    listDayFiles, download, downloadThumb, thumbLink, trash, folderLink,
  };
}
