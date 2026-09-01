// Минимальный ZIP без зависимостей. Пишем без сжатия (stored): jpeg уже сжат,
// а простой формат — это то, что через 18 лет откроется чем угодно.
// Читаем и stored, и deflate (через DecompressionStream, есть в Safari 16.4+).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

const enc = new TextEncoder();

/**
 * @param {Array<{name:string, data:Blob|string|Uint8Array, date?:Date}>} files
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function createZip(files, onProgress) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const { part, size, crc } = await measure(f.data);
    const nameBytes = enc.encode(f.name);
    const { time, day } = dosDateTime(f.date || new Date());

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);           // версия
    lv.setUint16(6, 0x0800, true);       // UTF-8 в имени
    lv.setUint16(8, 0, true);            // метод: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    chunks.push(local, part);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
    if (onProgress) onProgress(i + 1, files.length);
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 0)); // не морозим UI
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

/**
 * Длина и контрольная сумма файла — не поднимая его в память целиком.
 *
 * Наружу отдаётся тот же источник, каким пришёл: снимок остаётся Blob и в
 * итоговый архив попадает ссылкой. Год фотографий — несколько сотен мегабайт,
 * и разница между «браузер держит их у себя, при нужде на диске» и «мы
 * развернули их в Uint8Array» — это разница между собранным архивом и
 * закрытой вкладкой.
 */
async function measure(data) {
  if (typeof data === 'string') {
    const bytes = enc.encode(data);
    return { part: bytes, size: bytes.length, crc: crc32(bytes) };
  }
  if (data instanceof Uint8Array) {
    return { part: data, size: data.length, crc: crc32(data) };
  }
  if (typeof data.stream !== 'function') {
    const bytes = new Uint8Array(await data.arrayBuffer());
    return { part: bytes, size: bytes.length, crc: crc32(bytes) };
  }
  let crc = 0;
  const reader = data.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    crc = crc32(value, crc);
  }
  return { part: data, size: data.size, crc };
}

/**
 * Читает ZIP по центральной директории.
 *
 * Контрольная сумма каждого файла проверяется, и это не педантизм: архив
 * приезжает из мессенджера, с флешки, из чужой выгрузки — и оборванная
 * загрузка выглядит как обычный файл. Не проверить сумму значит залить в
 * общую папку испорченный снимок поверх целого дня и узнать об этом
 * через год, когда исходник уже не найти.
 *
 * @returns {Promise<Array<{name:string, blob:Blob}>>}
 */
export async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не ZIP-архив');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    let bytes = buf.subarray(start, start + compSize);

    if (method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('Архив сжат, а браузер не умеет его распаковать. Пересоздайте ZIP без сжатия.');
      }
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (method !== 0) {
      throw new Error(`Неподдерживаемый метод сжатия в «${name}»`);
    }

    // Ноль в этом поле — законное «сумма не посчитана», такое пишут потоковые
    // упаковщики. Всё остальное обязано сойтись.
    if (crc && crc32(bytes) !== crc) {
      throw new Error(`Файл «${name}» в архиве испорчен — архив прочитан не до конца ` +
        'или повреждён при передаче.');
    }

    out.push({ name, blob: new Blob([bytes]) });
  }
  return out;
}
