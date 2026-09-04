// Общее на все экраны: что приложение про себя знает прямо сейчас и как оно
// достаёт папку.
//
// Раньше это лежало вперемешку с экранами в app.js, и любой вынесенный экран
// утаскивал бы за собой половину файла. Здесь ровно то, что нужно всем и не
// принадлежит никому: состояние, ленивый Диск и два вопроса про сеть.

import { configured } from '../config.js';
import * as G from './google.js';
import { createDrive } from './drive.js';
import { toast } from './ui.js';

export const state = {
  cfg: null,
  calYear: 0,
  calMonth: 0,
  align: null,       // контекст оверлея разметки глаз
  ghost: null,       // живая камера, пока открыт её оверлей
  conn: { status: 'unknown', email: '', note: '' },   // связь с Google
  connAt: 0,         // когда её проверяли в последний раз
  syncing: false,    // читаем папку прямо сейчас — видно во второй строке
  screen: null,      // какой экран открыт — чтобы знать, с какого уходим
  marked: 0,         // размеченных дней в альбоме — от этого зависит уточнение
};

/** Диск создаётся лениво: без интернета и без токена он и не нужен. */
export function drive() {
  return createDrive({ getToken: opts => G.getAccessToken({ interactive: false, ...opts }) });
}

/** Есть ли откуда качать: папка подключена и сеть на месте. */
export function canPull() {
  return Boolean(configured() && state.cfg.driveEmail && navigator.onLine);
}

/**
 * Любая правка уезжает прямо в общую папку, поэтому без сети её делать нельзя:
 * иначе два телефона расходятся, и потом непонятно, чья версия настоящая.
 * Пока Диск не подключён, приложение работает локально и это правило не нужно.
 */
export function online() {
  return !state.cfg.driveEmail || navigator.onLine;
}

export function requireOnline() {
  if (online()) return true;
  toast('Нет сети. Снимите обычной камерой и добавьте кадр из галереи позже', 4200);
  return false;
}
