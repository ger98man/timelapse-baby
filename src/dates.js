// Даты. Всё в локальном времени пользователя, ключ — 'YYYY-MM-DD'.

export const MS_DAY = 86400000;

export function toKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return toKey(new Date());
}

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

/** Разница в календарных днях: b - a. */
export function diffDays(aKey, bKey) {
  const a = fromKey(aKey), b = fromKey(bKey);
  return Math.round((b - a) / MS_DAY);
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function formatLong(key) {
  const d = fromKey(key);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatMonth(year, month0) {
  return `${MONTHS_NOM[month0]} ${year}`;
}

/** Понедельник = 0. */
export function weekdayMon0(d) {
  return (d.getDay() + 6) % 7;
}

export function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/**
 * Подпись дня: «День 47» после рождения, «До встречи 12 дней» / неделя
 * беременности — до. Возвращает { label, sub, dayNumber|null }.
 */
export function dayLabel(key, { birthDate, dueDate }) {
  if (!birthDate) {
    return { label: formatLong(key), sub: '', dayNumber: null };
  }
  const n = diffDays(birthDate, key);
  if (n >= 0) {
    const day = n + 1; // день рождения — «День 1»
    const sub = n >= 30 ? ageText(n) : '';
    return { label: `День ${day}`, sub, dayNumber: day };
  }
  const left = -n;
  const sub = dueDate ? gestationText(key, dueDate) : '';
  return {
    label: `За ${left} ${plural(left, 'день', 'дня', 'дней')} до встречи`,
    sub,
    dayNumber: null,
  };
}

/** Возраст словами: «3 месяца 4 дня». */
export function ageText(daysSinceBirth) {
  const months = Math.floor(daysSinceBirth / 30.4375);
  const rest = Math.round(daysSinceBirth - months * 30.4375);
  if (months < 1) return '';
  if (months < 24) {
    const m = `${months} ${plural(months, 'месяц', 'месяца', 'месяцев')}`;
    return rest > 0 ? `${m} ${rest} ${plural(rest, 'день', 'дня', 'дней')}` : m;
  }
  const years = Math.floor(daysSinceBirth / 365.25);
  return `${years} ${plural(years, 'год', 'года', 'лет')}`;
}

/** Акушерская неделя от ПДР (беременность = 280 дней). */
export function gestationText(key, dueDate) {
  const left = diffDays(key, dueDate);
  const gestDays = 280 - left;
  if (gestDays < 0 || gestDays > 320) return '';
  const w = Math.floor(gestDays / 7);
  const d = gestDays % 7;
  return `${w} ${plural(w, 'неделя', 'недели', 'недель')} ${d} ${plural(d, 'день', 'дня', 'дней')}`;
}
