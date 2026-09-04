// Экран как таковой: то, что рисует и спрашивает, ничего не зная про альбом.
//
// Сюда вынесено ровно то, у чего нет своего состояния и своих знаний о
// приложении: показать полоску, спросить «точно?», отдать файл. Модуль не
// импортирует ни хранилище, ни Диск, ни настройки — и не должен: как только
// он о них узнает, экраны перестанут импортироваться по отдельности.

export const $ = id => document.getElementById(id);

// --- объектные URL ----------------------------------------------------------
//
// Каждый показанный снимок — это URL, который держит блоб в памяти, пока его
// не отпустят. Экран сменился — отпускаем все разом: следить за каждым по
// отдельности пришлось бы в десятке мест, и один забытый течёт молча.

let urls = [];

export function freeUrls() {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
}
export function url(blob) {
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}

let toastTimer;

/**
 * @param {string} text
 * @param {number} ms сколько висеть
 * @param {?{label:string, run:Function}} action кнопка справа — для «Вернуть»
 */
export function toast(text, ms = 2600, action = null) {
  const el = $('toast');
  const btn = $('toast-action');
  $('toast-text').textContent = text;
  btn.classList.toggle('hidden', !action);
  btn.textContent = action ? action.label : '';
  btn.onclick = action
    ? () => { el.classList.add('hidden'); clearTimeout(toastTimer); action.run(); }
    : null;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/**
 * Свой диалог подтверждения вместо системного confirm().
 *
 * Системный ненадёжен: встроенные панели браузеров гасят его молча, а Chrome
 * после «блокировать диалоги на этой странице» навсегда возвращает «нет» —
 * и кнопка выглядит сломанной, хотя код отработал.
 *
 * @param {{inputs?:Array<{key:string,label:string,type?:string,value?:string}>}} opts
 *        inputs — диалог не подтверждает, а спрашивает: тогда «да» приносит
 *        объект с ответами, а не true. Отмена всегда false, чтобы у зовущего
 *        была одна проверка на оба случая.
 */
export function ask({ title, text = '', items = [], inputs = [],
               yes = 'Удалить', no = 'Отмена', danger = true }) {
  return new Promise(resolve => {
    const box = $('ask');
    $('ask-title').textContent = title;
    $('ask-text').textContent = text;
    $('ask-text').classList.toggle('hidden', !text);
    // Список фактов о том, что сейчас произойдёт: собираем узлами, а не
    // разметкой строкой — в значения попадают имя ребёнка и имя файла.
    const list = $('ask-list');
    list.textContent = '';
    for (const [label, value] of items) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = label;
      span.append(b, ' — ' + value);
      li.append(span);
      list.append(li);
    }
    list.classList.toggle('hidden', !items.length);

    const fields = $('ask-fields');
    fields.textContent = '';
    const boxes = new Map();
    for (const f of inputs) {
      const label = document.createElement('label');
      label.className = 'field';
      const span = document.createElement('span');
      span.textContent = f.label;
      const input = document.createElement('input');
      input.type = f.type || 'text';
      input.value = f.value || '';
      label.append(span, input);
      fields.append(label);
      boxes.set(f.key, input);
    }
    fields.classList.toggle('hidden', !inputs.length);

    $('ask-yes').textContent = yes;
    $('ask-yes').classList.toggle('btn-danger', danger);
    $('ask-yes').classList.toggle('btn-primary', !danger);
    $('ask-no').textContent = no;
    box.classList.remove('hidden');

    const close = answer => {
      box.classList.add('hidden');
      $('ask-yes').onclick = $('ask-no').onclick = box.onclick = null;
      resolve(answer);
    };
    const answers = () => {
      const out = {};
      for (const [key, input] of boxes) out[key] = input.value.trim();
      return out;
    };
    $('ask-yes').onclick = () => close(inputs.length ? answers() : true);
    $('ask-no').onclick = () => close(false);
    box.onclick = e => { if (e.target === box) close(false); };
    if (inputs.length) boxes.values().next().value.focus();
  });
}

export function progressOpen(label) {
  $('progress-label').textContent = label;
  $('progress-fill').style.width = '0%';
  $('progress-count').textContent = '';
  $('progress').classList.remove('hidden');
}
export function progressSet(done, total, label) {
  if (label) $('progress-label').textContent = label;
  const pct = total ? Math.round(done / total * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  $('progress-count').textContent = total ? `${done} из ${total}` : '';
}
export function progressClose() { $('progress').classList.add('hidden'); }

export async function saveBlob(blob, filename, title = filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
  return 'downloaded';
}
