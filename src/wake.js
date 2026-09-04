// Экран не должен гаснуть, пока идёт долгая работа.
//
// Сборка видео пишется в реальном времени: год при 8 кадрах в секунду — это
// сорок пять секунд, в течение которых человек только смотрит на экран и не
// касается его. Айфон за это время гасит подсветку, канвас перестают
// перерисовывать, и MediaRecorder записывает вместо таймлапса замерший кадр.
// То же самое у выгрузки архива, которая может качать минутами.
//
// Wake Lock отпускается системой сам, стоит вкладке уйти в фон. Поэтому мало
// один раз попросить — надо просить заново при каждом возвращении, пока работа
// не кончилась.
//
// Замок есть не везде (Safari с 16.4, но не в старых iOS и не в приватных
// режимах некоторых браузеров). Его отсутствие ничего не ломает: работа идёт
// как шла, просто экран может погаснуть, как гас до сих пор.

/**
 * Держит экран включённым, пока не вызовут возвращённую функцию.
 *
 * Никогда не бросает и ничего не обещает: вызывающему коду нечего делать с
 * отказом системы, кроме как продолжать работу.
 *
 * @returns {() => void} отпустить замок
 */
export function keepAwake() {
  if (!navigator.wakeLock || !navigator.wakeLock.request) return () => {};

  let lock = null;
  let done = false;

  const grab = () => {
    if (done || document.visibilityState !== 'visible' || lock) return;
    navigator.wakeLock.request('screen').then(got => {
      if (done) { got.release().catch(() => {}); return; }
      lock = got;
      // Система отпустила сама — забываем, чтобы попросить заново.
      got.addEventListener('release', () => { if (lock === got) lock = null; });
    }).catch(() => {});
  };

  const onVisible = () => grab();
  document.addEventListener('visibilitychange', onVisible);
  grab();

  return () => {
    if (done) return;
    done = true;
    document.removeEventListener('visibilitychange', onVisible);
    if (lock) { lock.release().catch(() => {}); lock = null; }
  };
}
