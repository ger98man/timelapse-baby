// Сборка таймлапса прямо в браузере: канвас → captureStream → MediaRecorder.
// Если MediaRecorder недоступен (старая iOS) — остаётся экспорт кадров в ZIP,
// из которых видео собирается чем угодно.

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* Safari бросает на некоторых строках */ }
  }
  return null;
}

export function videoSupported() {
  return pickMime() !== null;
}

const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

/**
 * Подпись в кадре: «День 47» в нижнем углу.
 *
 * Выжигается прямо в пиксели, потому что это единственный способ, которым она
 * доедет до готового файла: субтитров у mp4 из MediaRecorder нет, а
 * пересобирать видео ради текста никто не станет.
 *
 * Размеры считаются от стороны кадра, а не в пикселях: один и тот же код
 * должен одинаково выглядеть и на предпросмотре 540, и на файле 1080.
 */
export function drawCaption(ctx, text, size) {
  if (!text) return;
  const pad = Math.round(size * 0.045);
  const fontSize = Math.round(size * 0.052);
  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // Тень вместо плашки: плашка закрывает угол кадра, а тень читается и на
  // светлом, и на тёмном, ничего не пряча.
  ctx.shadowColor = 'rgba(0,0,0,.75)';
  ctx.shadowBlur = Math.round(size * 0.02);
  ctx.shadowOffsetY = Math.round(size * 0.004);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, pad, size - pad);
  ctx.restore();
}

function decode(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad frame')); };
    img.src = url;
  });
}

/**
 * Прокручивает кадры на канвасе, попутно (если задан recorder) записывая видео.
 * Кадры декодируются с опережением на один, чтобы не проседать по темпу.
 */
async function playFrames(frames, canvas, fps, { onFrame, signal } = {}) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const frameMs = 1000 / fps;
  const t0 = performance.now();

  let next = frames.length ? decode(frames[0].blob) : null;

  for (let i = 0; i < frames.length; i++) {
    if (signal && signal.aborted) return;
    let current;
    try {
      current = await next;
    } catch {
      continue;
    }
    next = i + 1 < frames.length ? decode(frames[i + 1].blob).catch(() => null) : null;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(current.img, 0, 0, size, size);
    current.release();
    drawCaption(ctx, frames[i].caption, size);

    if (onFrame) onFrame(i, frames[i]);
    await sleep(t0 + (i + 1) * frameMs - performance.now());
  }
}

/**
 * @param {Array<{date:string, blob:Blob, caption?:string}>} frames  кадры по порядку
 * @param {{fps:number,size:number,holdLast:number}} opts
 * @param {(i:number,total:number)=>void} onProgress
 * @returns {Promise<{blob:Blob, mime:string, ext:string}>}
 */
export async function buildVideo(frames, opts, onProgress) {
  const mime = pickMime();
  if (!mime) throw new Error('Браузер не умеет записывать видео. Выгрузите кадры в ZIP.');

  const { fps = 8, size = 1080 } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: opts.bitrate || 8_000_000,
  });

  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const finished = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = e => reject(e.error || new Error('Ошибка записи'));
  });

  recorder.start();
  await sleep(120); // дать рекордеру подхватить первый кадр

  await playFrames(frames, canvas, fps, {
    onFrame: i => onProgress && onProgress(i + 1, frames.length),
  });

  await sleep(Math.max(400, 1000 / fps * 4)); // подержать последний кадр
  recorder.stop();
  stream.getTracks().forEach(t => t.stop());
  await finished;

  const blob = new Blob(chunks, { type: mime });
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob, mime, ext };
}

export { playFrames };
