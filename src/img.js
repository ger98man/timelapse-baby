// Работа с картинками. Через <img>, а не createImageBitmap:
// <img> сам применяет EXIF-ориентацию во всех браузерах, включая Safari.

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({
      img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob вернул null')), type, quality);
  });
}

/**
 * Ужимает снимок до мастер-кадра: длинная сторона не больше maxDim.
 * Мастер — то, что мы храним и считаем «оригиналом» внутри приложения.
 */
export async function toMaster(blob, maxDim = 2560, quality = 0.92) {
  const { img, width, height, release } = await loadImage(blob);
  try {
    const scale = Math.min(1, maxDim / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (scale === 1 && blob.type === 'image/jpeg') {
      return { blob, w, h };
    }
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const out = await canvasToBlob(canvas, 'image/jpeg', quality);
    return { blob: out, w, h };
  } finally {
    release();
  }
}

/** Квадратная миниатюра для календаря. */
export async function makeThumb(blob, size = 320) {
  const { img, width, height, release } = await loadImage(blob);
  try {
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const side = Math.min(width, height);
    ctx.drawImage(img, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
    return canvasToBlob(canvas, 'image/jpeg', 0.8);
  } finally {
    release();
  }
}

export function formatBytes(n) {
  if (!n) return '0 МБ';
  const mb = n / 1048576;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} МБ`;
  return `${(mb / 1024).toFixed(2)} ГБ`;
}
