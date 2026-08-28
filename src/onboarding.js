// Онбординг: от «открыл ссылку» до «снял первое фото».
//
// Всё начинается со входа в Google, и дальше приложение читает из папки на
// Диске не только фотографии, но и настройки. Поэтому вводить руками почти
// нечего: на новом телефоне достаточно войти, а второй родитель, подключившись
// к общей папке, сразу получает имя и дату рождения — шаг «Про кого снимаем»
// у него просто не появится.

import { settings } from './db.js';
import { GOOGLE, configured, pickerReady } from '../config.js';
import * as G from './google.js';
import { createDrive } from './drive.js';
import { pickFolder } from './picker.js';
import { fetchProfile, countRemoteDays, PROFILE_KEYS } from './profile.js';
import * as D from './dates.js';

const $ = id => document.getElementById(id);

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Safari без разрешения на буфер — выделяем, дальше человек сам
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* не вышло */ }
    ta.remove();
    return ok;
  }
}

/**
 * Показывает мастер и разрешается, когда пользователь дошёл до конца.
 * @param {{onToast?:(s:string)=>void}} opts
 */
export function runOnboarding({ onToast = () => {} } = {}) {
  return new Promise(async resolve => {
    const cfg = await settings.all();
    const state = {
      signedIn: Boolean(cfg.driveEmail),
      folderId: cfg.driveFolderId,
      folderName: cfg.driveFolderName || GOOGLE.folderName,
      remoteDays: 0,
    };

    // В мастере токен просим интерактивно: человек прямо сейчас у экрана и
    // готов подтвердить, а молча упереться в «нужно переподключить» — тупик.
    const drive = createDrive({
      getToken: () => G.getAccessToken({ interactive: true }),
    });

    // Набор шагов подстраивается на ходу: «Про кого снимаем» отпадает, если
    // настройки уже приехали из папки, а «На домашний экран» — если приложение
    // и так запущено с него.
    const steps = ['welcome', 'signin', 'folder', 'baby'];
    if (!standalone()) steps.push('install');
    steps.push('invite', 'done');

    function dropStep(name) {
      const i = steps.indexOf(name);
      if (i > at) steps.splice(i, 1);
    }

    let at = 0;

    const pane = name => document.querySelector(`.step[data-step="${name}"]`);

    function renderChrome() {
      const dots = $('wiz-dots');
      dots.innerHTML = '';
      steps.forEach((_, i) => {
        const d = document.createElement('i');
        d.className = 'dot' + (i === at ? ' now' : i < at ? ' past' : '');
        dots.appendChild(d);
      });
      $('wiz-count').textContent = `${at + 1}/${steps.length}`;
      $('wiz-back').style.visibility = at === 0 ? 'hidden' : 'visible';
    }

    async function show(i) {
      at = Math.max(0, Math.min(steps.length - 1, i));
      for (const s of document.querySelectorAll('.step')) s.classList.add('hidden');
      pane(steps[at]).classList.remove('hidden');
      renderChrome();
      $('wiz-body-scroll') && $('wiz-body-scroll').scrollTo(0, 0);
      document.querySelector('.wiz-body').scrollTop = 0;
      await enter[steps[at]]();
    }

    const next = () => show(at + 1);

    function setNext(label, enabled = true) {
      const b = $('wiz-next');
      b.textContent = label;
      b.disabled = !enabled;
    }
    function setSkip(label) {
      const b = $('wiz-skip');
      b.classList.toggle('hidden', !label);
      if (label) b.textContent = label;
    }

    // --- что происходит при входе в каждый шаг ---------------------------
    const enter = {
      async welcome() {
        // Ключ приложения не заполнен — это недоделанная выкладка, а не задача
        // пользователя. Говорим прямо, вместо того чтобы вести его в тупик.
        const ready = configured();
        $('wiz-not-configured').classList.toggle('hidden', ready);
        setNext(ready ? 'Начать' : 'Приложение не настроено', ready);
        setSkip(null);
      },

      async signin() {
        const has = Boolean(state.signedIn);
        $('wiz-signin').classList.toggle('hidden', has);
        $('wiz-signout').classList.toggle('hidden', !has);
        $('wiz-account').classList.toggle('hidden', !has);
        if (has) {
          $('wiz-email').textContent = (await settings.get('driveEmail')) || '';
          $('wiz-name').textContent = 'Аккаунт подключён';
          $('wiz-avatar').style.display = 'none';
        }
        $('wiz-signin-error').textContent = '';
        setNext('Дальше', has);
        setSkip(null);
      },

      async folder() {
        const err = $('wiz-folder-error');
        err.textContent = '';
        $('wiz-folder-join').classList.toggle('hidden', !pickerReady());
        setSkip(null);
        setNext('Дальше', false);

        $('wiz-folder-text').textContent = state.folderId
          ? 'Папка уже подключена.'
          : 'Создаю папку в вашем Диске…';
        $('wiz-folder-ok').classList.toggle('hidden', !state.folderId);

        try {
          const id = await drive.ensureRoot(state.folderName, state.folderId);
          state.folderId = id;
          await settings.set('driveFolderId', id);
          $('wiz-folder-text').textContent =
            'Готово. Всё, что вы снимете, будет складываться сюда.';
          $('wiz-folder-name').textContent = state.folderName;
          $('wiz-folder-link').href = `https://drive.google.com/drive/folders/${id}`;
          $('wiz-folder-ok').classList.remove('hidden');

          // В этой же папке лежат и настройки, и вся история. Если они там
          // есть — спрашивать имя и дату не нужно, а дни подтянутся сами.
          const files = await drive.listDayFiles();
          state.remoteDays = countRemoteDays(files);
          const remote = await fetchProfile(drive, files);
          if (remote && remote.birthDate) {
            const patch = {};
            for (const key of PROFILE_KEYS) {
              if (remote[key] !== undefined && remote[key] !== null) patch[key] = remote[key];
            }
            await settings.merge(patch);
            dropStep('baby');
            const who = remote.babyName ? `снимаем ${remote.babyName}` : 'настройки уже есть';
            $('wiz-folder-text').textContent = state.remoteDays
              ? `Папка не пустая: ${who}, накоплено дней — ${state.remoteDays}. ` +
                'Они появятся в приложении, вводить ничего не нужно.'
              : `Нашёл в папке настройки: ${who}. Вводить ничего не нужно.`;
            renderChrome();
          } else if (state.remoteDays) {
            $('wiz-folder-text').textContent =
              `Папка не пустая: в ней уже ${state.remoteDays} дней. Они появятся в приложении.`;
          }
          setNext('Дальше', true);
        } catch (e) {
          $('wiz-folder-text').textContent = 'Папку создать не получилось.';
          err.textContent = e.message || 'Google Диск не ответил';
          setNext('Попробовать снова', true);
        }
      },

      async baby() {
        const c = await settings.all();
        $('wiz-name').value = c.babyName || '';
        $('wiz-birth').value = c.birthDate || D.todayKey();
        $('wiz-baby-error').textContent = '';
        setNext('Дальше');
        setSkip(null);
      },

      async install() {
        $('wiz-install-ios').classList.toggle('hidden', !isIOS());
        $('wiz-install-other').classList.toggle('hidden', isIOS());
        setNext('Готово');
        setSkip('Позже');
      },

      async invite() {
        $('wiz-invite-folder').href = state.folderId
          ? `https://drive.google.com/drive/folders/${state.folderId}`
          : 'https://drive.google.com';
        setNext('Дальше');
        setSkip('Снимаю один');
      },

      async done() {
        const c = await settings.all();
        const who = c.babyName ? c.babyName : 'ребёнка';
        $('wiz-done-text').textContent = state.remoteDays
          ? `Загружаю ${state.remoteDays} дней из папки — календарь и таймлапс ` +
            'будут доступны сразу, как они приедут.'
          : `Осталось снять первый кадр. Дальше — по одному фото ${who} в день; ` +
            'приложение само посчитает дни и соберёт таймлапс, когда захотите.';
        setNext(state.remoteDays ? 'Загрузить снимки' : 'Снять первое фото');
        setSkip(null);
      },
    };

    // --- переход вперёд: у некоторых шагов есть условия -------------------
    const leave = {
      async folder() {
        return Boolean(state.folderId);
      },

      async baby() {
        const birth = $('wiz-birth').value;
        if (!birth) {
          $('wiz-baby-error').textContent = 'Поставьте дату — от неё считаются дни';
          return false;
        }
        const future = D.diffDays(D.todayKey(), birth) > 0;
        await settings.merge({
          babyName: $('wiz-name').value.trim(),
          birthDate: birth,
          dueDate: future ? birth : null,
        });
        return true;
      },
    };

    // --- обработчики -----------------------------------------------------
    $('wiz-back').onclick = () => show(at - 1);

    $('wiz-next').onclick = async () => {
      const step = steps[at];
      if (leave[step] && !(await leave[step]())) return;
      if (step === 'done') return finish();
      if (step === 'folder' && !state.folderId) return enter.folder();
      next();
    };

    $('wiz-skip').onclick = () => next();

    $('wiz-signin').onclick = async () => {
      const err = $('wiz-signin-error');
      err.textContent = '';
      $('wiz-signin').disabled = true;
      try {
        const { accessToken } = await G.requestToken({ interactive: true });
        const me = await G.fetchUserInfo(accessToken);
        if (!G.emailAllowed(me.email)) {
          G.forget();
          err.textContent = 'Этот аккаунт не в списке разрешённых';
          return;
        }
        await settings.set('driveEmail', me.email);
        state.signedIn = true;
        next();
      } catch (e) {
        err.textContent = e.message || 'Не получилось войти';
      } finally {
        $('wiz-signin').disabled = false;
      }
    };

    $('wiz-signout').onclick = async () => {
      await G.revoke();
      await settings.set('driveEmail', null);
      state.signedIn = false;
      await enter.signin();
    };

    $('wiz-pick-folder').onclick = async () => {
      const err = $('wiz-folder-error');
      err.textContent = '';
      try {
        const token = await G.getAccessToken({ interactive: true });
        const folder = await pickFolder(token);
        if (!folder) return;
        await drive.adoptRoot(folder.id);
        state.folderId = folder.id;
        state.folderName = folder.name;
        await settings.merge({ driveFolderId: folder.id, driveFolderName: folder.name });
        await enter.folder();
        onToast(`Папка «${folder.name}» подключена`);
      } catch (e) {
        err.textContent = e.message || 'Не удалось выбрать папку';
      }
    };

    $('wiz-invite-share').onclick = async () => {
      const text = 'Ставь себе — сюда складываем по фото в день. ' +
        'Открой в Safari и добавь на домашний экран.';
      try {
        if (navigator.share) {
          await navigator.share({ title: 'Каждый день', text, url: location.href });
        } else if (await copy(location.href)) {
          onToast('Ссылка скопирована');
        }
      } catch { /* закрыли окно «Поделиться» */ }
    };

    async function finish() {
      await settings.set('onboardingDone', true);
      $('wizard').classList.add('hidden');
      resolve();
    }

    $('wizard').classList.remove('hidden');
    await show(0);
  });
}
