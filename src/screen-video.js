// Экран «Видео»: предпросмотр, сборка файла и выгрузка кадров.
//
// Самый самостоятельный из экранов — и единственный, которому нужна вся
// история сразу. Поэтому он и вынесен первым: здесь свой проигрыватель со
// своей памятью, и держать его посреди остальных экранов значило бы держать
// открытыми и его внутренности.

import { entries, blobs } from './db.js';
import * as D from './dates.js';
import { formatBytes } from './img.js';
import { drawAligned } from './align.js';
import { buildVideo, videoSupported, pickMime, drawCaption } from './video.js';
import { createZip } from './zip.js';
import * as store from './store.js';
import { $, url, toast, ask, progressOpen, progressSet, progressClose,
         saveBlob } from './ui.js';
import { state, drive, canPull } from './session.js';

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linejoin="round"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
  '<path d="M7.6 7.6h8.8v8.8h-8.8z" fill="currentColor" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linejoin="round"/></svg>';


/** Дни выбранного промежутка, у которых в папке есть снимок. */
async function videoDays() {
  const from = $('video-from').value || '0000-01-01';
  const to = $('video-to').value || '9999-12-31';
  const rows = await entries.range(from, to);
  return rows.filter(r => r.fileId).map(r => r.date);
}

/** Все дни альбома, у которых есть снимок. */
export async function allDays() {
  const rows = await entries.range('0000-01-01', '9999-12-31');
  return rows.filter(r => r.fileId).map(r => r.date);
}

/**
 * Кадры для сборки. Здесь и только здесь качается вся история целиком: видео
 * иначе не собрать. Зато человек платит за это осознанно — нажав кнопку, а не
 * открыв приложение.
 *
 * Кадры ложатся на верстак, а не в память вкладки: год оригиналов вместе с
 * год выровненных кадров телефон не удержит. Верстак стирается при уходе с
 * экрана — store.clearBench().
 */
export async function framesForBuild(days) {
  if (!days) days = await videoDays();
  if (!days.length) return [];

  const puller = canPull() ? drive() : null;
  const pending = await store.pendingFrames(days);
  if (pending && !puller) {
    toast(`Без сети собираю из ${days.length - pending} загруженных кадров`, 3600);
  }
  if (pending && puller) progressOpen('Готовлю кадры');

  const { frames, missing } = await store.buildFrames(puller, days,
    { onProgress: (d, t, label) => progressSet(d, t, label) });
  progressClose();

  if (state.cfg.videoCaption) {
    for (const frame of frames) frame.caption = captionFor(frame.date);
  }

  if (missing && puller) {
    toast(`Не удалось загрузить ${missing} ${D.plural(missing, 'кадр', 'кадра', 'кадров')}`);
  }
  return frames;
}

/**
 * Что выжигать в кадр. Тот же счётчик, что и в заголовке «Сегодня»: «День 47»
 * после родов, «За 30 дней до встречи» до них. Без даты рождения счётчика нет
 * — тогда и подписывать нечем, и чекбокс не показывается.
 */
export function captionFor(date) {
  return D.dayLabel(date, state.cfg).label;
}

export async function refreshVideoInfo() {
  const days = await videoDays();
  const fps = Number($('video-fps').value);
  const secs = days.length / fps;
  $('video-info').textContent = days.length
    ? `${days.length} ${D.plural(days.length, 'кадр', 'кадра', 'кадров')} · примерно ${secs.toFixed(1)} с`
    : 'В этом промежутке ещё нет кадров.';
  $('btn-render').disabled = !days.length;
  $('btn-preview').disabled = !days.length;

  // Обещать сборку там, где браузер её не умеет, нечестно: кнопка всё равно
  // ответила бы отказом. Убираем её и объясняем, чем собрать вместо неё.
  const canRecord = videoSupported();
  $('btn-render').classList.toggle('hidden', !canRecord);
  $('video-unsupported').classList.toggle('hidden', canRecord);
}

/** @param {boolean} playing Идёт ли показ: от этого вся разница в кнопке. */
function setPlayButton(playing) {
  const b = $('btn-preview');
  b.innerHTML = playing ? ICON_STOP : ICON_PLAY;
  b.setAttribute('aria-label', playing ? 'Остановить' : 'Посмотреть');
}

/**
 * Проигрыватель предпросмотра.
 *
 * Кадры — миниатюры из Диска, поэтому весь ряд помещается в памяти и можно
 * не «проигрывать поток», а просто рисовать нужный кадр: отсюда и пауза, и
 * перемотка в любое место, чего у прежнего показа не было.
 */
// Декодированный кадр 540×540 — это больше мегабайта сверх самой миниатюры.
// Год таких в памяти не держат, поэтому вокруг текущего места оставляем окно,
// а остальное отпускаем: пролистнули назад — декодируется заново, это дёшево.
const PLAYER_WINDOW = 24;

export const player = {
  frames: [],        // [{date, url, eyes}] по порядку
  images: new Map(),  // date -> HTMLImageElement, декодируем по требованию
  i: 0,
  playing: false,
  timer: null,
  key: '',           // какой промежуток загружен: сменился — перезагружаем
};

export function playerStop() {
  player.playing = false;
  clearTimeout(player.timer);
  player.timer = null;
  setPlayButton(false);
  setOverlay('play');
}

/**
 * Значок поверх кадра. Во время показа над видео не должно быть ничего:
 * таймлапс идёт секунды, и кружок посреди лица успевает только помешать.
 * @param {?string} kind 'play' — приглашение нажать; null — чистый кадр
 */
function setOverlay(kind) {
  $('video-overlay').className = 'video-overlay' + (kind ? ' ' + kind : ' hidden');
}

/**
 * Миниатюру грузим обычной картинкой: скачать её запросом нельзя — сервер
 * картинок Google не отдаёт заголовок CORS. Рисовать это на холсте можно,
 * читать холст обратно — нет, но предпросмотру и не нужно: файл собирается
 * из оригиналов, а не отсюда.
 */
function imageFor(frame) {
  let img = player.images.get(frame.date);
  if (img) return img;
  img = new Image();
  img.src = frame.url;
  player.images.set(frame.date, img);
  return img;
}

export async function drawFrame(i) {
  const frame = player.frames[i];
  if (!frame) return;
  player.i = i;
  const canvas = $('video-canvas');
  const ctx = canvas.getContext('2d');
  const img = imageFor(frame);
  if (!img.complete) {
    await new Promise(res => { img.onload = res; img.onerror = res; });
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (img.naturalWidth) {
    // Тот же расчёт, что и у настоящего кадра: глаза встают на своё место,
    // поэтому предпросмотр показывает именно то, что окажется в файле.
    drawAligned(ctx, img, img.naturalWidth, img.naturalHeight,
      canvas.width, frame.eyes, state.cfg.eyeTarget);
    if (state.cfg.videoCaption) {
      drawCaption(ctx, captionFor(frame.date), canvas.width);
    }
  }
  $('video-seek').value = String(i);
  $('video-pos').textContent = D.formatLong(frame.date).replace(/ \d{4}$/, '');
  // Следующий кадр начинаем грузить заранее: иначе на первом показе темп плывёт.
  if (player.frames[i + 1]) imageFor(player.frames[i + 1]);
  trimImages(i);
}

/** Отпускает кадры за пределами окна — иначе год показа съедает всю память. */
function trimImages(i) {
  if (player.images.size <= PLAYER_WINDOW * 2 + 2) return;
  const keep = new Set();
  for (let k = i - PLAYER_WINDOW; k <= i + PLAYER_WINDOW; k++) {
    const frame = player.frames[k];
    if (frame) keep.add(frame.date);
  }
  for (const date of [...player.images.keys()]) {
    if (!keep.has(date)) player.images.delete(date);
  }
}

function playerPlay() {
  if (!player.frames.length) return;
  // Досмотрели до конца — следующий пуск начинает сначала.
  if (player.i >= player.frames.length - 1) player.i = 0;
  player.playing = true;
  setPlayButton(true);
  setOverlay(null);
  const step = async () => {
    if (!player.playing) return;
    await drawFrame(player.i);
    if (player.i >= player.frames.length - 1) { playerStop(); return; }
    player.timer = setTimeout(() => { player.i++; step(); },
      1000 / Number($('video-fps').value));
  };
  step();
}

export function playerToggle() {
  if (!player.frames.length) return previewVideo();
  if (player.playing) playerStop(); else playerPlay();
}

/**
 * Предпросмотр идёт по миниатюрам Google: посмотреть год так стоит мегабайта
 * вместо сотни. Оригиналы качаются только за настоящим файлом — там качество
 * решает, здесь достаточно узнать лицо в квадрате 400×400.
 */
async function previewVideo() {
  const days = await videoDays();
  if (!days.length) return;
  if (!canPull()) { toast('Нет сети — предпросмотр не из чего собрать'); return; }

  const key = days.join(',');
  if (key !== player.key) {
    let frames = [];
    try {
      frames = await store.previewFrames(drive(), days);
    } catch (e) {
      toast(e.message || 'Не удалось получить кадры для предпросмотра');
    }
    if (!frames.length) { toast('Кадры для предпросмотра не приехали'); return; }
    player.frames = frames;
    player.images.clear();
    player.key = key;
    player.i = 0;
  }

  $('video-result').classList.add('hidden');
  $('video-canvas').classList.remove('hidden');
  $('video-track').classList.remove('hidden');
  $('video-seek').max = String(player.frames.length - 1);
  await drawFrame(player.i);
  playerPlay();
}

/** Промежуток или скорость поменялись — показанное больше не про них. */
export function resetPlayer() {
  playerStop();
  player.frames = [];
  player.images.clear();
  player.key = '';
  player.i = 0;
  $('video-track').classList.add('hidden');
  $('video-overlay').classList.add('hidden');
  const canvas = $('video-canvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Что будет, если нажать «Скачать». Сборка идёт в реальном времени и на
 * телефоне, файл выходит увесистый — человеку честнее знать это до того, как
 * экран на полминуты займёт полоска прогресса.
 *
 * Числа приблизительные и такими названы: длительность считается точно, а
 * размер зависит от того, насколько кодек сожмёт конкретные кадры.
 * @returns {Promise<boolean>} согласился ли человек
 */
async function confirmRender(days) {
  const pending = await store.pendingFrames(days);
  const fps = Number($('video-fps').value);
  // Столько же, сколько добавляет buildVideo: разгон рекордера и удержание
  // последнего кадра, иначе таймлапс обрывается на полуслове.
  const hold = Math.max(0.4, 4 / fps);
  const secs = days.length / fps + hold + 0.12;
  const ext = (pickMime() || '').startsWith('video/mp4') ? 'mp4' : 'webm';
  const name = `${state.cfg.babyName || 'timelapse'}-${D.todayKey()}.${ext}`;
  // Тот же битрейт, с которым пишет buildVideo: 8 Мбит/с ≈ 1 МБ на секунду.
  const bytes = 8_000_000 / 8 * secs;
  const shares = Boolean(navigator.canShare && navigator.canShare({
    files: [new File([new Blob()], name, { type: `video/${ext}` })],
  }));

  return ask({
    title: 'Собрать и скачать видео',
    text: 'В отличие от предпросмотра, файл собирается из настоящих ' +
      'фотографий: они скачаются из папки, проиграются по одной и запишутся ' +
      'в видео. На телефоне ничего из этого не останется.',
    items: [
      ['Кадров', `${days.length} · видео примерно на ${secs.toFixed(1)} с` +
        (pending ? ` · скачаю ${pending} из папки` : '')],
      ['Файл', `${name}, примерно ${formatBytes(bytes)}`],
      ['Куда', shares
        ? 'телефон спросит сам — можно сохранить или сразу отправить'
        : 'в папку «Загрузки»'],
      ['Сколько ждать', `примерно ${Math.ceil(secs + 1)} с — ` +
        'приложение должно оставаться открытым'],
    ],
    yes: 'Скачать',
    no: 'Не сейчас',
    danger: false,
  });
}

export async function renderVideo() {
  const days = await videoDays();
  if (!days.length) return;
  if (!videoSupported()) {
    toast('Этот браузер не умеет записывать видео — выгрузите кадры в ZIP');
    return;
  }
  if (!await confirmRender(days)) return;

  const frames = await framesForBuild();
  if (!frames.length) return;
  progressOpen('Собираю видео');
  try {
    const fps = Number($('video-fps').value);
    const { blob, ext } = await buildVideo(frames, { fps, size: state.cfg.videoSize },
      (d, t) => progressSet(d, t, 'Собираю видео'));
    const v = $('video-result');
    v.src = url(blob);
    v.classList.remove('hidden');
    $('video-canvas').classList.add('hidden');
    // Кнопка обещала «скачать», а не «подождите вторую кнопку»: окно прогресса
    // закрываем и сразу отдаём файл — иначе поверх него откроется «Поделиться».
    progressClose();
    const name = `${state.cfg.babyName || 'timelapse'}-${D.todayKey()}.${ext}`;
    if (await saveBlob(blob, name) === 'downloaded') toast('Файл сохранён в «Загрузки»');
    // Оригиналы качались только ради этого файла — держать в памяти
    // мегабайты после того, как он готов, незачем.
    await blobs.clear();
  } catch (e) {
    toast(e.message || 'Не удалось собрать видео');
  } finally {
    progressClose();
  }
}

/**
 * @param {string[]} [days] Дни для выгрузки. Без них — выбранный на «Видео»
 *   промежуток; из «Настроек» приходит весь альбом целиком.
 */
export async function framesToZip(days) {
  const frames = await framesForBuild(days);
  if (!frames.length) { toast('Пока нет ни одного кадра'); return; }
  progressOpen('Пакую кадры');
  const files = frames.map((f, i) => ({
    name: `frames/${String(i + 1).padStart(4, '0')}_${f.date}.jpg`,
    data: f.blob,
  }));
  // Скорость в команде — та, что выставлена ползунком: иначе собранное по
  // подсказке видео шло бы не в том темпе, который человек только что выбрал.
  const fps = Number($('video-fps').value);
  files.push({
    name: 'frames/КАК-СОБРАТЬ.txt',
    data: 'Кадры уже выровнены по глазам и пронумерованы по порядку.\n\n' +
          'Собрать видео из них можно одной командой:\n\n' +
          `  ffmpeg -framerate ${fps} -pattern_type glob -i "*.jpg" ` +
          '-c:v libx264 -pix_fmt yuv420p timelapse.mp4\n',
  });
  const zip = await createZip(files, (d, t) => progressSet(d, t));
  progressClose();
  await saveBlob(zip, `kadry-${D.todayKey()}.zip`);
}
