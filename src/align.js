import { loadImage, makeCanvas, canvasToBlob, makeThumb } from './img.js';

// Выравнивание по глазам — то, что отличает таймлапс от дёргающегося слайдшоу.
// Считаем similarity-трансформацию (поворот + масштаб + сдвиг), которая ставит
// два отмеченных глаза в фиксированные точки кадра.

export const DEFAULT_TARGET = { lx: 0.375, ly: 0.42, rx: 0.625, ry: 0.42 };

/**
 * Рисует кадр размером size×size с выровненным лицом.
 * @param ctx    контекст канваса size×size
 * @param img    HTMLImageElement (мастер-кадр)
 * @param iw,ih  размеры мастер-кадра
 * @param eyes   {lx,ly,rx,ry} в долях 0..1 от мастер-кадра, либо null
 * @param target {lx,ly,rx,ry} в долях 0..1 от выходного кадра
 */
export function drawAligned(ctx, img, iw, ih, size, eyes, target = DEFAULT_TARGET) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  if (!eyes) {
    drawCover(ctx, img, iw, ih, size);
    ctx.restore();
    return;
  }

  const sl = { x: eyes.lx * iw, y: eyes.ly * ih };
  const sr = { x: eyes.rx * iw, y: eyes.ry * ih };
  const tl = { x: target.lx * size, y: target.ly * size };
  const tr = { x: target.rx * size, y: target.ry * size };

  const srcAngle = Math.atan2(sr.y - sl.y, sr.x - sl.x);
  const dstAngle = Math.atan2(tr.y - tl.y, tr.x - tl.x);
  const srcDist = Math.hypot(sr.x - sl.x, sr.y - sl.y);
  const dstDist = Math.hypot(tr.x - tl.x, tr.y - tl.y);

  if (srcDist < 1) {
    drawCover(ctx, img, iw, ih, size);
    ctx.restore();
    return;
  }

  const angle = dstAngle - srcAngle;
  const scale = dstDist / srcDist;

  // p_out = Translate(tl) · Rotate(angle) · Scale(scale) · Translate(-sl) · p_in
  ctx.translate(tl.x, tl.y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.translate(-sl.x, -sl.y);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, iw, ih);
  ctx.restore();
}

/** Кадр без разметки глаз — просто квадратный кроп по центру. */
export function drawCover(ctx, img, iw, ih, size) {
  const side = Math.min(iw, ih);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, size, size);
}

// --- Кэш выровненных кадров -------------------------------------------------
// Выровненный кадр — всегда пересоздаваемый артефакт поверх мастер-кадра.
// Хранится ради скорости (видео и превью не декодируют мегапиксельные снимки),
// и его можно выбросить целиком в любой момент.

export async function renderAlignedBlob(entry, { size = 1080, target = DEFAULT_TARGET } = {}) {
  const { img, width, height, release } = await loadImage(entry.photo);
  try {
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d');
    drawAligned(ctx, img, width, height, size, entry.eyes, target);
    return canvasToBlob(canvas, 'image/jpeg', 0.88);
  } finally {
    release();
  }
}

/**
 * Пересоздаёт всё, что выводится из мастер-кадра: выровненный кадр и миниатюру.
 *
 * Миниатюра берётся из выровненного кадра, если глаза отмечены. Иначе в
 * календаре и на «Сегодня» человек видел бы центральный кроп, а в таймлапс
 * уезжало бы совсем другое — и разметка выглядела бы бесполезной, пока не
 * соберёшь видео.
 */
export async function buildDerived(entry, { size = 1080, target = DEFAULT_TARGET } = {}) {
  if (!entry.photo) {
    entry.aligned = null;
    entry.thumb = null;
    return entry;
  }
  entry.aligned = await renderAlignedBlob(entry, { size, target });
  entry.thumb = await makeThumb(entry.eyes ? entry.aligned : entry.photo);
  return entry;
}
