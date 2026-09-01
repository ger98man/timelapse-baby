// Общая обвязка проверочных страниц.
//
// Тесты здесь — обычные страницы, которые открывают в браузере: ни сборки, ни
// зависимостей, ни отдельного окружения. Проверять их нечем, кроме глаз,
// поэтому вывод одинаковый на всех страницах — список утверждений и итог
// внизу, зелёный или красный.

let box = null;
let failures = 0;
let checks = 0;

const out = () => document.getElementById('out');

/** Новый раздел проверок. */
export function caseOf(title) {
  box = document.createElement('div');
  box.className = 'case';
  box.innerHTML = `<h2>${title}</h2>`;
  out().appendChild(box);
}

/** Одно утверждение. Подробность показывается только когда она что-то объясняет. */
export function check(label, condition, detail = '') {
  const row = document.createElement('div');
  row.className = 'row ' + (condition ? 'ok' : 'bad');
  row.textContent = label + (detail ? ` — ${detail}` : '');
  (box || out()).appendChild(row);
  checks++;
  if (!condition) failures++;
}

/** Итог внизу страницы. */
export function finish() {
  const s = document.getElementById('summary');
  s.className = failures ? 'fail' : 'pass';
  s.textContent = failures
    ? `Провалено проверок: ${failures} из ${checks}`
    : `Все проверки прошли (${checks})`;
}

/**
 * Прогон целиком. Упавший тест — это тоже результат, и он должен быть виден
 * на странице, а не только в консоли, куда на телефоне не заглянуть.
 */
export function run(body) {
  Promise.resolve().then(body).then(finish).catch(e => {
    const s = document.getElementById('summary');
    s.className = 'fail';
    s.textContent = 'Тест упал: ' + (e && e.message ? e.message : e);
    console.error(e);
  });
}

/** Правдоподобный снимок: цветной квадрат и два тёмных пятна на месте глаз. */
export function jpeg(tint, size = 200) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = tint; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  ctx.fillRect(size * 0.25, size * 0.35, size * 0.09, size * 0.09);
  ctx.fillRect(size * 0.66, size * 0.35, size * 0.09, size * 0.09);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
}
