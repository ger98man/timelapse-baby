// Оформление известно до первой отрисовки. Настоящее значение лежит в базе,
// рядом с остальными настройками, но база отвечает не сразу, а красить надо
// сейчас — поэтому app.js держит в localStorage слепок имени темы.
// Скрипт стоит в <head> после таблицы стилей намеренно: браузер её уже
// дождался, и цвета темы можно не повторять руками, а спросить у самой темы.
//
// Отдельным файлом, а не прямо в разметке, — из-за Content-Security-Policy:
// она запрещает встроенные скрипты, и это главное, что она даёт.
(function () {
  var name;
  try { name = localStorage.getItem('theme'); } catch (e) { /* приватный режим */ }
  // «default» — имя убранного тёмного оформления: у тех, кто сидел на нём,
  // в localStorage оно ещё лежит.
  document.documentElement.dataset.theme =
    (name === 'girl' || name === 'boy') ? name : 'girl';
  var css = getComputedStyle(document.documentElement);
  var meta = function (which, value) {
    var el = document.querySelector('meta[name="' + which + '"]');
    if (el && value) el.content = value.trim();
  };
  meta('theme-color', css.getPropertyValue('--bg'));
  meta('apple-mobile-web-app-status-bar-style', css.getPropertyValue('--status-bar'));
})();
