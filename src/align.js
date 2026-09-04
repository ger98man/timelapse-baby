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


// --- Уточнение разметки -----------------------------------------------------
//
// Точки ставят пальцем по снимку на экране телефона, и промах в три-четыре
// пикселя — это норма, а не небрежность. На отдельном кадре его не видно
// вовсе; видно его в готовом видео, где каждый день промахнулись по-своему, и
// голова мелко дрожит — хотя в самих снимках никакой дрожи нет.
//
// Лечится это тем, что точку ставит не палец, а изображение: вчера, сохраняя
// разметку, приложение запомнило два кусочка кадра вокруг глаз, а сегодня
// ищет их на новом снимке. Обычная арифметика по пикселям на устройстве —
// никакого распознавания лиц, ни своего, ни тем более облачного: приложению
// неоткуда и незачем знать, что на снимке лицо.
//
// Сравнение идёт не на самих снимках, а на выровненных кадрах, и это главное.
// Вчера снимали ближе, сегодня дальше; вчера ровно, сегодня с наклоном — на
// снимках кусочки не совпали бы ничем. Выравнивание как раз и убирает масштаб
// с поворотом, так что в выровненном кадре остаётся ровно то небольшое
// смещение, которое мы ищем.
//
// Побочная выгода важнее прямой. Каждый день цепляется за предыдущий, а не за
// палец, поэтому случайный промах не наследуется: ряд дней держится вместе, и
// дрожь в видео пропадает не потому, что её сгладили после, а потому, что она
// не появилась.

/** Размер выровненного кадра, в котором идёт поиск, и его окрестности. */
export const PATCH = {
  size: 320,       // сторона кадра сравнения — не картинка, а рабочая сетка
  radius: 12,      // половина стороны кусочка: 25×25
  search: 64,      // насколько далеко от догадки ищем — почти во весь глаз
  minScore: 0.45,  // ниже этого сходство — не сходство
};

/** Точка снимка → точка выровненного кадра. */
export function projectPoint(t, size, x, y) {
  const dx = x - t.cx, dy = y - t.cy;
  const c = Math.cos(t.angle), s = Math.sin(t.angle);
  return { x: size / 2 + t.scale * (c * dx - s * dy),
           y: size / 2 + t.scale * (s * dx + c * dy) };
}

/** Точка выровненного кадра → точка снимка. */
export function unprojectPoint(t, size, x, y) {
  const ux = (x - size / 2) / t.scale, uy = (y - size / 2) / t.scale;
  const c = Math.cos(-t.angle), s = Math.sin(-t.angle);
  return { x: t.cx + (c * ux - s * uy), y: t.cy + (s * ux + c * uy) };
}

/**
 * Лёгкое размытие 1-4-6-4-1, по строкам и по столбцам.
 *
 * Не ради красоты: сравниваются кадры, собранные из разных снимков и потому
 * по-разному зашумлённые и по-разному пожатые. Одинаково размытые, они
 * сравниваются по форме, а не по шуму, и вершина сходства становится гладкой —
 * без этого дробную долю пикселя не по чему было бы считать.
 */
function blur(src, size) {
  const K = [1, 4, 6, 4, 1], SUM = 16;
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const edge = v => Math.min(size - 1, Math.max(0, v));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -2; k <= 2; k++) acc += K[k + 2] * src[y * size + edge(x + k)];
      tmp[y * size + x] = acc / SUM;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = -2; k <= 2; k++) acc += K[k + 2] * tmp[edge(y + k) * size + x];
      out[y * size + x] = acc / SUM;
    }
  }
  return out;
}

/**
 * Выровненный кадр в оттенках серого — то, по чему идёт поиск.
 * @returns {?Float32Array} null — холст прочитать не дали (чужая картинка).
 */
function grayFrame(source, w, h, size, eyes, target) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  drawAligned(ctx, source, w, h, size, eyes, target);
  let px;
  try {
    px = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null;     // миниатюра Google холст пачкает — читать его нельзя
  }
  const g = new Float32Array(size * size);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  }
  return blur(g, size);
}

/** Вырезает квадрат стороной 2r+1 с центром в (cx, cy). */
function cut(frame, size, cx, cy, r) {
  const side = r * 2 + 1;
  const out = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      out[y * side + x] = frame[(cy - r + y) * size + (cx - r + x)];
    }
  }
  return out;
}

/**
 * Два кусочка вокруг глаз — то, что завтра будем искать на новом снимке.
 *
 * Хранится это в кэше на телефоне и стоит пять килобайт на день. Пропал —
 * ничего не сломалось: разметка просто вернётся к тому, чем была всегда, к
 * вчерашним точкам под пальцем.
 *
 * @returns {?{size:number, radius:number, target:Object, eyes:Object,
 *             l:Float32Array, r:Float32Array}}
 */
export function eyePatches(source, w, h, eyes, { target = DEFAULT_TARGET,
                                                 size = PATCH.size,
                                                 radius = PATCH.radius } = {}) {
  if (!eyes) return null;
  const t = fitTransform(w, h, size, eyes, target);
  if (!t) return null;
  const frame = grayFrame(source, w, h, size, eyes, target);
  if (!frame) return null;

  const pack = { size, radius, target, eyes };
  const edge = radius + 1;
  for (const side of ['l', 'r']) {
    const p = projectPoint(t, size, eyes[side + 'x'] * w, eyes[side + 'y'] * h);
    const cx = Math.round(p.x), cy = Math.round(p.y);
    // Глаз у самого края кадра — вырезать вокруг него нечего. Так бывает,
    // когда кадру не хватило снимка и попаданием пришлось пожертвовать.
    if (cx < edge || cy < edge || cx >= size - edge || cy >= size - edge) return null;
    pack[side] = cut(frame, size, cx, cy, radius);
  }
  return pack;
}

/** То же самое, но от снимка в файле: путь из store.js, где кадры — блобы. */
export async function eyePatchesFromBlob(blob, eyes, opts = {}) {
  const { img, width, height, release } = await loadImage(blob);
  try {
    return eyePatches(img, width, height, eyes, opts);
  } finally {
    release();
  }
}

/** Вершина параболы по трём точкам — та самая дробная доля пикселя. */
function subPixel(a, b, c) {
  const d = a - 2 * b + c;
  if (!d) return 0;
  const shift = 0.5 * (a - c) / d;
  return Math.abs(shift) <= 1 ? shift : 0;
}

/**
 * Ищет кусочек `patch` на кадре `frame` вокруг точки (ax, ay).
 *
 * Мера — нормированная взаимная корреляция: она сравнивает форму, а не
 * яркость, поэтому кадр, снятый у окна, и кадр, снятый под лампой, для неё
 * одинаковы. Единица — совпало точно, ноль — не совпало ничем.
 *
 * @returns {{dx:number, dy:number, score:number, edge:boolean}}
 *          edge — вершина пришлась на край области поиска: настоящая, скорее
 *          всего, лежит дальше, и найденному верить нельзя.
 */
function matchPatch(patch, frame, size, ax, ay, radius, search) {
  const side = radius * 2 + 1;
  const area = side * side;

  const ref = new Float32Array(patch);
  let mean = 0;
  for (let i = 0; i < area; i++) mean += ref[i];
  mean /= area;
  let refNorm = 0;
  for (let i = 0; i < area; i++) { ref[i] -= mean; refNorm += ref[i] * ref[i]; }
  refNorm = Math.sqrt(refNorm);
  if (!(refNorm > 1e-6)) return { dx: 0, dy: 0, score: 0, edge: false };

  /** Сходство образца с окном кадра, сдвинутым на (ox, oy). */
  const at = (ox, oy) => {
    let sum = 0, sq = 0, cross = 0;
    for (let y = 0; y < side; y++) {
      const row = (ay + oy - radius + y) * size + ax + ox - radius;
      const prow = y * side;
      for (let x = 0; x < side; x++) {
        const v = frame[row + x];
        sum += v;
        sq += v * v;
        cross += v * ref[prow + x];
      }
    }
    // Образец уже без среднего, поэтому среднее окна уходит из произведения
    // само: Σ(v−v̄)(p−p̄) = Σv·(p−p̄).
    const varr = sq - sum * sum / area;
    return varr > 1e-6 ? cross / (Math.sqrt(varr) * refNorm) : 0;
  };

  // Ищем в два прохода: сперва широко и через клетку, потом вплотную вокруг
  // найденного. Кадры размыты, вершина сходства пологая — между соседними
  // клетками ей спрятаться негде, — зато обойти вчетверо меньше точек.
  let best = -2, bx = 0, by = 0;
  for (let oy = -search; oy <= search; oy += 2) {
    for (let ox = -search; ox <= search; ox += 2) {
      const score = at(ox, oy);
      if (score > best) { best = score; bx = ox; by = oy; }
    }
  }
  // Вершина у самого края поиска: настоящая, скорее всего, лежит дальше, и
  // найденному верить нельзя.
  if (Math.abs(bx) > search - 2 || Math.abs(by) > search - 2) {
    return { dx: bx, dy: by, score: best, edge: true };
  }

  const FINE = 3;
  const span = FINE * 2 + 1;
  const grid = new Float32Array(span * span);
  let fx = bx, fy = by;
  best = -2;
  for (let oy = -FINE; oy <= FINE; oy++) {
    for (let ox = -FINE; ox <= FINE; ox++) {
      const score = at(bx + ox, by + oy);
      grid[(oy + FINE) * span + (ox + FINE)] = score;
      if (score > best) { best = score; fx = bx + ox; fy = by + oy; }
    }
  }

  let dx = fx, dy = fy;
  const gx = fx - bx, gy = fy - by;
  if (Math.abs(gx) < FINE && Math.abs(gy) < FINE) {
    const g = (x, y) => grid[(y + FINE) * span + (x + FINE)];
    dx += subPixel(g(gx - 1, gy), best, g(gx + 1, gy));
    dy += subPixel(g(gx, gy - 1), best, g(gx, gy + 1));
  }
  return { dx, dy, score: best, edge: false };
}

/**
 * Уточняет точки нового снимка по кусочкам, снятым с прошлого размеченного дня.
 *
 * @param {Object} pack  что вернул eyePatches для прошлого дня
 * @param {{src:CanvasImageSource, w:number, h:number, eyes:Object}} now
 *        сегодняшний снимок и точки-догадка, от которых пляшет поиск
 * @returns {?{lx:number, ly:number, rx:number, ry:number,
 *             score:number, shift:number}}
 *          null — искать не по чему или найденному нельзя верить; тогда
 *          остаются те точки, что были. Молча сдвинуть разметку неизвестно
 *          куда хуже, чем не сдвинуть вовсе: второе человек поправит сам,
 *          первого он не заметит.
 */
export function refineEyes(pack, now, { search = PATCH.search,
                                        minScore = PATCH.minScore } = {}) {
  if (!pack || !pack.l || !pack.r || !now || !now.eyes) return null;
  const { size, radius, target } = pack;
  // Композицией кадра здесь можно не интересоваться: она нужна только чтобы
  // построить ту же сетку, в которой лежали кусочки, а наружу возвращаются
  // доли самого снимка — они одни и те же при любой композиции.
  if (pack.l.length !== (radius * 2 + 1) ** 2) return null;

  const t = fitTransform(now.w, now.h, size, now.eyes, target);
  if (!t) return null;
  const frame = grayFrame(now.src, now.w, now.h, size, now.eyes, target);
  if (!frame) return null;

  const edge = radius + search + 1;
  const out = {};
  let worst = 1, shift = 0;

  for (const side of ['l', 'r']) {
    // Куда встала бы точка-догадка. Обычно это ровно цель, но когда кадру не
    // хватает снимка, fitTransform жертвует попаданием ради целого кадра — и
    // тогда искать надо там, где точка оказалась, а не там, где её хотели.
    const p = projectPoint(t, size, now.eyes[side + 'x'] * now.w,
                                    now.eyes[side + 'y'] * now.h);
    const ax = Math.round(p.x), ay = Math.round(p.y);
    if (ax < edge || ay < edge || ax >= size - edge || ay >= size - edge) return null;

    const got = matchPatch(pack[side], frame, size, ax, ay, radius, search);
    if (got.edge || got.score < minScore) return null;

    const src = unprojectPoint(t, size, ax + got.dx, ay + got.dy);
    out[side + 'x'] = src.x / now.w;
    out[side + 'y'] = src.y / now.h;
    worst = Math.min(worst, got.score);
    shift = Math.max(shift, Math.hypot(ax + got.dx - p.x, ay + got.dy - p.y));
  }

  // Точки, наехавшие друг на друга или разъехавшиеся вдвое, — это не уточнение,
  // а находка не того места: так выглядит поиск, попавший в ухо или в блик.
  const before = Math.hypot(now.eyes.rx - now.eyes.lx, now.eyes.ry - now.eyes.ly);
  const after = Math.hypot(out.rx - out.lx, out.ry - out.ly);
  if (!(after > before * 0.6 && after < before * 1.6)) return null;

  return { ...out, score: worst, shift };
}
