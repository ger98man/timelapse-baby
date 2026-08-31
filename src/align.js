import { loadImage, makeCanvas, canvasToBlob } from './img.js';

// Выравнивание по глазам — то, что отличает таймлапс от дёргающегося слайдшоу.
// Считаем similarity-трансформацию (поворот + масштаб + сдвиг), которая ставит
// два отмеченных глаза в фиксированные точки кадра.

export const DEFAULT_TARGET = { lx: 0.375, ly: 0.42, rx: 0.625, ry: 0.42 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Подбирает поворот, масштаб и центр так, чтобы глаза встали на свои места,
 * а кадр при этом целиком лежал внутри снимка.
 *
 * Голову на фотографии редко держат ровно, поэтому кадр почти всегда повёрнут
 * относительно снимка. Если просто выполнить требуемое преобразование, углы
 * повёрнутого кадра вылезают за край снимка — и в них остаётся фон канваса.
 * Отсюда и берутся снимки, «срезанные» по диагонали. Поэтому масштаб и центр
 * зажимаем: точное попадание глаз в цель — пожелание, полный кадр — условие.
 *
 * @returns {{angle:number, scale:number, cx:number, cy:number}|null}
 *          null — разметки нет, выравнивать нечего.
 */
export function fitTransform(iw, ih, size, eyes, target = DEFAULT_TARGET) {
  if (!eyes) return null;

  const sl = { x: eyes.lx * iw, y: eyes.ly * ih };
  const sr = { x: eyes.rx * iw, y: eyes.ry * ih };
  const srcDist = Math.hypot(sr.x - sl.x, sr.y - sl.y);
  if (!(srcDist >= 1)) return null;

  const tl = { x: target.lx * size, y: target.ly * size };
  const tr = { x: target.rx * size, y: target.ry * size };
  const dstDist = Math.hypot(tr.x - tl.x, tr.y - tl.y);

  const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x)
              - Math.atan2(sr.y - sl.y, sr.x - sl.x);

  // Повёрнутый квадрат кадра, положенный обратно на снимок, занимает по обеим
  // осям span/scale пикселей. Ниже этого масштаб опускать нельзя: кадру просто
  // не хватит снимка, чем его ни двигай.
  const span = size * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
  const scale = Math.max(dstDist / srcDist, span / Math.min(iw, ih));

  // Центр кадра на снимке: ведём его от середины глаз — она должна попасть
  // в середину целевых точек.
  const ca = Math.cos(-angle);
  const sa = Math.sin(-angle);
  const dx = size / 2 - (tl.x + tr.x) / 2;
  const dy = size / 2 - (tl.y + tr.y) / 2;
  const half = span / (2 * scale);

  return {
    angle,
    scale,
    cx: clamp((sl.x + sr.x) / 2 + (ca * dx - sa * dy) / scale, half, iw - half),
    cy: clamp((sl.y + sr.y) / 2 + (sa * dx + ca * dy) / scale, half, ih - half),
  };
}

/**
 * Рисует кадр размером size×size с выровненным лицом.
 * @param ctx    контекст канваса size×size
 * @param img    HTMLImageElement (мастер-кадр)
 * @param iw,ih  размеры мастер-кадра
 * @param eyes   {lx,ly,rx,ry} в долях 0..1 от мастер-кадра, либо null
 * @param target {lx,ly,rx,ry} в долях 0..1 от выходного кадра
 */
export function drawAligned(ctx, img, iw, ih, size, eyes, target = DEFAULT_TARGET) {
  const t = fitTransform(iw, ih, size, eyes, target);

  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  if (t) {
    // p_out = Translate(центр кадра) · Rotate · Scale · Translate(-центр на снимке)
    ctx.translate(size / 2, size / 2);
    ctx.rotate(t.angle);
    ctx.scale(t.scale, t.scale);
    ctx.translate(-t.cx, -t.cy);
    ctx.drawImage(img, 0, 0, iw, ih);
  } else {
    drawCover(ctx, img, iw, ih, size);
  }
  ctx.restore();
}

/** Кадр без разметки глаз — просто квадратный кроп по центру. */
export function drawCover(ctx, img, iw, ih, size) {
  const side = Math.min(iw, ih);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, size, size);
}

// --- Производные кадры ------------------------------------------------------
// Выровненный кадр — всегда пересоздаваемый артефакт поверх оригинала.
// Хранится ради скорости (видео не декодирует мегапиксельные снимки) и может
// быть выброшен в любой момент.

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

