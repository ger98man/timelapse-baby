import { loadImage, makeCanvas, canvasToBlob } from './img.js';

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

// --- Производные кадры ------------------------------------------------------
// Выровненный кадр и миниатюра — всегда пересоздаваемые артефакты поверх
// оригинала. Хранятся ради скорости (видео и календарь не декодируют
// мегапиксельные снимки), и любой из них можно выбросить в любой момент.

export const THUMB_SIZE = 320;

/**
 * Квадратный кадр из чего угодно: из мастер-кадра, из миниатюры Диска.
 * Координаты глаз — доли от размера источника, поэтому одна и та же разметка
 * одинаково ложится и на снимок в 2560 пикселей, и на миниатюру в 400.
 */
export async function renderSquareBlob(source, { size = 1080, eyes = null,
                                                 target = DEFAULT_TARGET,
                                                 quality = 0.88 } = {}) {
  const { img, width, height, release } = await loadImage(source);
  try {
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d');
    drawAligned(ctx, img, width, height, size, eyes, target);
    return canvasToBlob(canvas, 'image/jpeg', quality);
  } finally {
    release();
  }
}

/**
 * Всё, что выводится из мастер-кадра.
 *
 * Миниатюра берётся из выровненного кадра, если глаза отмечены. Иначе в
 * календаре и на «Сегодня» человек видел бы центральный кроп, а в таймлапс
 * уезжало бы совсем другое — и разметка выглядела бы бесполезной, пока не
 * соберёшь видео.
 */
export async function deriveFrom(photo, eyes, { size = 1080, target = DEFAULT_TARGET } = {}) {
  const aligned = await renderSquareBlob(photo, { size, eyes, target, quality: 0.88 });
  const thumb = await renderSquareBlob(eyes ? aligned : photo,
    { size: THUMB_SIZE, target, quality: 0.8 });
  return { aligned, thumb };
}

/** Миниатюра из дешёвого источника — когда мастер-кадра на телефоне ещё нет. */
export function thumbFrom(source, eyes, target = DEFAULT_TARGET) {
  return renderSquareBlob(source, { size: THUMB_SIZE, eyes, target, quality: 0.8 });
}
