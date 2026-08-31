// Камера с призраком вчерашнего кадра.
//
// Главная причина, по которой кадры в таймлапсе сходятся, — не разметка глаз,
// а то, каким снят сам кадр. Разметка спасает от смещения на десятки пикселей;
// от «вчера снимал сидя, сегодня стоя» она не спасает никак: масштаб и ракурс
// уже не те, и голова всё равно прыгает.
//
// Поэтому здесь поверх живой картинки лежит вчерашний кадр, бледный, и овал
// на месте лица. Совместить голову с бледным вчера проще, чем вспомнить, как
// именно ты держал телефон сутки назад.
//
// Цена честная: getUserMedia — камера браузера, она проще системной (никакого
// HDR и ночного режима). Поэтому это отдельная кнопка, а не замена обычной
// съёмке, и об этом прямо сказано в интерфейсе.

import { drawAligned } from './align.js';

/** Ошибки getUserMedia на человеческом: их всего несколько, и все понятные. */
function cameraError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError') {
    return 'Браузер не пустил к камере. Разрешите доступ в настройках сайта ' +
           'и попробуйте снова.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'Камеру найти не удалось. Снимите обычной кнопкой «Снять».';
  }
  if (name === 'NotReadableError') {
    return 'Камера занята другим приложением. Закройте его и попробуйте снова.';
  }
  return 'Не удалось включить камеру. Снимите обычной кнопкой «Снять».';
}

/**
 * Овал на месте будущего лица.
 *
 * Считается не «на глаз», а от той же композиции кадра, по которой потом
 * выравнивается снимок: где стоят целевые точки глаз, там и должны оказаться
 * глаза ребёнка. Совпадение с овалом означает, что после выравнивания кадр
 * почти не придётся двигать — а значит, и обрезать по краям.
 */
export function drawFaceGuide(ctx, size, target) {
  const eyeY = target.ly * size;
  const eyeSpan = (target.rx - target.lx) * size;

  // Пропорции детской головы: ширина примерно два с половиной межзрачковых
  // расстояния, высота — три с небольшим, а глаза лежат чуть выше середины.
  const rx = eyeSpan * 1.18;
  const ry = eyeSpan * 1.50;
  const cx = size / 2;
  const cy = eyeY + ry * 0.18;

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = Math.max(2, size * 0.004);
  ctx.setLineDash([size * 0.022, size * 0.026]);
  ctx.shadowColor = 'rgba(0,0,0,.5)';
  ctx.shadowBlur = size * 0.012;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Линия глаз: по ней целятся точнее, чем по овалу целиком.
  ctx.setLineDash([size * 0.012, size * 0.018]);
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.72, eyeY);
  ctx.lineTo(cx + rx * 0.72, eyeY);
  ctx.stroke();
  ctx.restore();
}

/**
 * Живая камера в квадратном холсте.
 *
 * Наружу отдаёт только то, что нужно экрану: запустить, перевернуть, снять,
 * погасить. Про DOM оверлея, вчерашний кадр и настройки не знает ничего —
 * их приносит вызывающий.
 */
export function createGhostCamera({ video, guide, target }) {
  let stream = null;
  let facing = 'environment';
  let ghostImg = null;
  let ghostAlpha = 0.35;
  let ghostEyes = null;

  async function start() {
    stop();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
    video.srcObject = stream;
    // play() намеренно без await: у элемента стоят autoplay/muted/playsinline,
    // он запустится сам, а обещание умеет зависать неразрешённым — и тогда
    // повисло бы всё открытие камеры, включая призрак и подсказку.
    video.play().catch(() => { /* Safari отвечает отказом на autoplay */ });
    draw();
  }

  function stop() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
  }

  async function flip() {
    facing = facing === 'environment' ? 'user' : 'environment';
    await start();
  }

  /** Вчерашний кадр и его разметка: по ней он ляжет так же, как ляжет сегодняшний. */
  function setGhost(img, eyes) {
    ghostImg = img;
    ghostEyes = eyes || null;
    draw();
  }

  function setAlpha(a) {
    ghostAlpha = a;
    draw();
  }

  /**
   * Призрак и овал живут на отдельном холсте поверх видео: перерисовывать их
   * каждый кадр незачем — они меняются только когда их меняют.
   */
  function draw() {
    const size = guide.width;
    const ctx = guide.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    if (ghostImg && ghostAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = ghostAlpha;
      // Тем же расчётом, что и настоящий кадр: призрак показывает не «вчерашнюю
      // фотографию», а вчерашний кадр таймлапса — то, с чем сегодняшний встанет
      // рядом в видео.
      drawAligned(ctx, ghostImg, ghostImg.naturalWidth, ghostImg.naturalHeight,
        size, ghostEyes, target);
      ctx.restore();
    }
    drawFaceGuide(ctx, size, target);
  }

  /**
   * Снимок: центральный квадрат кадра камеры, в полном её разрешении.
   *
   * Квадрат берётся ровно тот, что человек видел — video стоит с object-fit:
   * cover в квадратном окне, — иначе совпадение с призраком было бы враньём.
   */
  async function shoot(quality = 0.92) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error('Камера ещё не готова');
    const side = Math.min(vw, vh);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';

    // Фронтальная камера показывает зеркальное изображение — снимаем как
    // видели, иначе человек нажимает на одно, а получает отражение.
    if (facing === 'user') {
      ctx.translate(side, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, side, side);

    return new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Кадр не получился')),
        'image/jpeg', quality);
    });
  }

  return { start, stop, flip, shoot, setGhost, setAlpha };
}

export { cameraError };
