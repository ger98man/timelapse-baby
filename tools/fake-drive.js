// Поддельная папка Google Диска: та же горстка вызовов, что у настоящего
// `drive.js`, только в памяти.
//
// Держать её отдельно стоит ради одного свойства: тесты хранилища и тесты
// архива обязаны видеть одну и ту же папку. Иначе легко проверить экспорт
// против заглушки, которая ведёт себя не так, как та, против которой
// проверяли запись, — и не заметить расхождения.
//
// Корзина настоящая: удаление помечает файл, а не стирает его, — иначе
// «Вернуть» нечем проверить.

/**
 * @param {{latency?:number}} opts latency — задержка каждой загрузки в
 *        миллисекундах: с ней видно, качаются файлы по одному или пачкой.
 */
export function fakeDrive({ latency = 0 } = {}) {
  const files = new Map();
  // Папки заглушка держит отдельно от файлов и ровно в той же раскладке, что
  // и Диск: дом → альбомы → годы. Тесту, который про дни, они не мешают —
  // пока папок не завели, всё лежит в одной, как раньше.
  const folders = new Map();
  const downloads = [];      // что и сколько раз качали — главное в этих тестах
  let drive;
  let seq = 0, sums = 0;
  let clock = Date.now() - 3600000;
  const tick = () => new Date(clock += 60000).toISOString();

  // Сколько загрузок шло одновременно: столько же и параллельность в коде.
  let inFlight = 0, maxInFlight = 0;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // Пока папок не заводили, у файлов нет и родителя — такой файл виден
  // отовсюду, иначе тесты про дни пришлось бы переписывать все разом.
  const inRoot = (f, rootId) => !rootId || f.root === undefined || f.root === rootId;

  drive = {
    files,
    downloads,
    latency,
    folders,
    async findRoot(known) {
      if (known && folders.has(known)) return folders.get(known);
      const own = [...folders.values()].filter(f => f.kind === 'album');
      if (own.length) return own[0];
      // Папок не заводили — значит, тест про дни, и папка ровно одна.
      return { id: known || 'root', name: 'Альбом', ownedByMe: true,
               appProperties: { everydayNamed: '1' } };
    },
    async findHome(known) {
      if (known && folders.has(known)) return folders.get(known);
      return [...folders.values()].find(f => f.kind === 'home') || null;
    },
    async createHome(name) {
      const id = 'h' + (++seq);
      const home = { id, name, kind: 'home', parent: null, ownedByMe: true,
                     appProperties: { everydayHome: '1', everydayNamed: '1' } };
      folders.set(id, home);
      return home;
    },
    async createRoot(name, parent = null) {
      const id = 'a' + (++seq);
      const album = { id, name, kind: 'album', parent, ownedByMe: true,
                      appProperties: { everydayRoot: '1' } };
      folders.set(id, album);
      return album;
    },
    async listRoots() {
      return [...folders.values()].filter(f => f.kind === 'album');
    },
    async listHomes() {
      return [...folders.values()].filter(f => f.kind === 'home');
    },
    async listProjects(homeId) {
      return [...folders.values()].filter(f => f.kind === 'album' && f.parent === homeId);
    },
    async rename(id, name) {
      const f = folders.get(id);
      if (f) f.name = name;
      return name;
    },
    async folderKind(id) {
      const f = folders.get(id);
      return f ? f.kind : 'album';
    },
    async nameHome(home) { return home.name; },
    async adoptRoot(id) { return id; },
    async adoptHome(id) { return id; },
    async putDayFile({ rootId, dateKey, name, blob, kind, fileId, props }) {
      const id = fileId || 'f' + (++seq);
      const prev = files.get(id);
      // В какой папке лежит файл — то же, что parents в Диске. Без этого
      // общий config.json дома и детский были бы неразличимы.
      const root = rootId || (prev ? prev.root : undefined);
      const appProperties = {
        ...(prev ? prev.appProperties : {}),
        everyday: '1', kind, ...(props || {}),
      };
      if (dateKey) appProperties.day = dateKey;
      const modifiedTime = tick();
      // Диск считает контрольную сумму содержимого; правка метаданных её не меняет
      const md5Checksum = 'md5-' + (++sums);
      files.set(id, { id, name, blob, root, modifiedTime, md5Checksum, appProperties });
      return { id, modifiedTime, md5Checksum };
    },
    async updateProps(id, props) {
      const f = files.get(id);
      f.appProperties = { ...f.appProperties, ...props };
      f.modifiedTime = tick();
      return { id, modifiedTime: f.modifiedTime };
    },
    // Содержимое папки: приложение так добирается до config.json, когда на нём
    // нет метки — например, в общей папке второго родителя.
    async listChildren(rootId) {
      return [...files.values()].filter(f => !f.trashed && inRoot(f, rootId));
    },
    listCalls: 0,
    async listDayFiles(rootId) {
      drive.listCalls++;
      return [...files.values()].filter(f => !f.trashed && inRoot(f, rootId)).map(f => ({
        ...f,
        appProperties: { ...f.appProperties },
        // Google отдаёт ссылку на готовую миниатюру прямо в описи
        thumbnailLink: f.appProperties.kind === 'photo' ? `thumb:${f.id}=s220` : undefined,
      }));
    },
    async download(id) {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        if (drive.latency) await wait(drive.latency);
        const f = files.get(id);
        if (!f || f.trashed) throw new Error('файл не найден: ' + id);
        downloads.push(f.appProperties.kind || 'photo');
        return f.blob;
      } finally {
        inFlight--;
      }
    },
    async thumbLink(id) { return `thumb:${id}=s220`; },
    async downloadThumb(link) {
      const id = String(link).split(':')[1].split('=')[0];
      downloads.push('thumb');
      return files.get(id).blob;      // как будто Google уже уменьшил
    },
    // Диск не стирает файл, а помечает его как удалённый и держит 30 дней.
    // Заглушка обязана делать так же, иначе «Вернуть» нечем проверить.
    async trash(id) { files.get(id).trashed = true; },
    async untrash(id) { files.get(id).trashed = false; },
    pulled(kind) { return downloads.filter(k => k === kind).length; },
    count(kind) {
      return [...files.values()]
        .filter(f => !f.trashed && f.appProperties.kind === kind).length;
    },
    inTrash() { return [...files.values()].filter(f => f.trashed).length; },
    dayFile(day, kind = 'photo') {
      return [...files.values()].find(f =>
        !f.trashed && f.appProperties.day === day && f.appProperties.kind === kind);
    },
    /** Наибольшее число одновременных загрузок с прошлого сброса. */
    peak() { return maxInFlight; },
    resetPeak() { maxInFlight = 0; inFlight = 0; },
  };
  return drive;
}
