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
import { createDrive, rootName } from './drive.js';
import { pickFolder } from './picker.js';
import { fetchProfile, pushProfile, countRemoteDays, PROFILE_KEYS } from './profile.js';
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
      remoteProfile: false,
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

    // Подсказку под папкой некоторые случаи переписывают под себя. Держим
    // исходную, иначе разовое предупреждение остаётся висеть навсегда.
    const folderHint = $('wiz-folder-hint').textContent;

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

    // label = null — шага, на котором «Дальше» ничего не значит, кнопка не
    // должна изображать. Серая кнопка обещает действие, которого нет.
    function setNext(label, enabled = true) {
      const b = $('wiz-next');
      b.classList.toggle('hidden', !label);
      if (!label) return;
      b.textContent = label;
      b.disabled = !enabled;
    }

    /**
     * Папки нет — спрашиваем, кто пришёл. Заводить её молча нельзя: у второго
     * родителя от этого появляется собственный пустой альбом рядом с общим,
     * и дальше он снимает не туда, ничего не подозревая.
     */
    function askWhoYouAre() {
      $('wiz-folder-text').textContent =
        'Папки пока нет. Если альбом заводите вы — создайте её. Если снимать ' +
        'уже начал второй родитель — подключитесь к его папке.';
      $('wiz-folder-choice').classList.remove('hidden');
      $('wiz-pick-folder').classList.toggle('hidden', !pickerReady());
      setNext(null);
    }

    /**
     * Папка есть: показать, запомнить и забрать из неё настройки.
     *
     * @param {boolean} found найдена сама, а не заведена и не выбрана руками.
     *        Разница важна: найденная своя пустая папка — ровно та ловушка,
     *        из-за которой второй родитель начинает снимать в отдельный альбом.
     */
    async function useFolder(root, { found = false } = {}) {
      const email = await settings.get('driveEmail');
      const name = await drive.nameRoot(root, email);

      state.folderId = root.id;
      state.folderName = name;
      await settings.merge({ driveFolderId: root.id, driveFolderName: name });

      $('wiz-folder-choice').classList.add('hidden');
      $('wiz-folder-hint').textContent = folderHint;
      $('wiz-folder-text').textContent =
        'Готово. Всё, что вы снимете, будет складываться сюда.';
      $('wiz-folder-name').textContent = name;
      $('wiz-folder-ok').classList.remove('hidden');
      // Выход есть всегда, а не только когда папку не нашли: приложение могло
      // наткнуться на старую свою папку, а человек пришёл в общую — или
      // наоборот, подключился к чужой, а хочет собственный альбом.
      $('wiz-folder-other').classList.toggle('hidden', !pickerReady());
      resetNewFolder();
      setNext('Дальше', true);

      // В этой же папке лежат и настройки, и вся история. Если они там
      // есть — спрашивать имя и дату не нужно, а дни подтянутся сами.
      const files = await drive.listDayFiles(root.id);
      state.remoteDays = countRemoteDays(files);
      const remote = await fetchProfile(drive, files);
      state.remoteProfile = Boolean(remote && remote.birthDate);
      if (remote && remote.birthDate) {
        const patch = {};
        for (const key of PROFILE_KEYS) {
          if (remote[key] !== undefined && remote[key] !== null) patch[key] = remote[key];
        }
        await settings.merge(patch);
      }

      // Спрашивать «про кого снимаем» есть смысл, только если ответа нет
      // нигде. Дата могла приехать из папки, а могла остаться с прошлого
      // захода на этом же телефоне — переспрашивать записанное незачем.
      const known = await settings.all();
      if (known.birthDate) {
        dropStep('baby');
        renderChrome();
      }

      if (remote && remote.birthDate) {
        const who = remote.babyName ? `снимаем ${remote.babyName}` : 'настройки уже есть';
        $('wiz-folder-text').textContent = state.remoteDays
          ? `Папка не пустая: ${who}, накоплено дней — ${state.remoteDays}. ` +
            'Они появятся в приложении, вводить ничего не нужно.'
          : `Нашёл в папке настройки: ${who}. Вводить ничего не нужно.`;
        return;
      }

      // Настроек нет — а причин у этого две, и лечатся они по-разному: файла
      // в папке правда нет, или Google выдал доступ к самой папке, но не к
      // тому, что внутри. Отличить их можно только заглянув внутрь, поэтому
      // заглядываем и говорим, что увидели. Иначе человек, у которого папка
      // полна снимков, видит пустой вопрос про имя и считает это поломкой.
      let seen = null;
      try { seen = (await drive.listChildren(root.id)).length; } catch { /* не пустили */ }

      if (!root.ownedByMe && !seen) {
        $('wiz-folder-text').textContent =
          'Папка подключена, но внутрь неё приложение не видит: Google выдал ' +
          'доступ к самой папке, а не к её содержимому.';
        $('wiz-folder-hint').textContent =
          'Выберите её заново кнопкой ниже — в окне Google не заходите внутрь ' +
          'папки, а нажмите на неё один раз и сразу «Select». И проверьте, что ' +
          'первый родитель дал вам права редактора, а не просмотра.';
      } else if (state.remoteDays) {
        $('wiz-folder-text').textContent =
          `Папка не пустая: в ней уже ${state.remoteDays} дней. Они появятся в приложении. ` +
          'Настроек (config.json) в ней нет — спрошу имя и дату и положу их туда.';
      } else if (!root.ownedByMe) {
        $('wiz-folder-text').textContent =
          `Готово. Внутри папки приложение видит файлов: ${seen}, но настроек ` +
          'среди них нет — спрошу имя и дату и запишу их в неё.';
      } else if (found && root.ownedByMe) {
        // Своя, пустая и найденная сама — чаще всего след прошлого захода. Если
        // человек пришёл вторым, «Готово» здесь означало бы, что он начнёт
        // снимать в собственный альбом рядом с общим и не заметит этого.
        $('wiz-folder-text').textContent =
          'Нашлась ваша собственная папка, и она пустая. Так и должно быть, ' +
          'если альбом заводите вы.';
        $('wiz-folder-hint').textContent =
          'А если снимать уже начал второй родитель — подключитесь к его папке, ' +
          'иначе вы будете снимать в разные альбомы. Папки подписаны почтой ' +
          'владельца, так что свою и общую легко различить.';
      }
    }

    /** Возвращает кнопку «завести свою» в исходное, неподтверждённое состояние. */
    function resetNewFolder() {
      const b = $('wiz-folder-new');
      delete b.dataset.sure;
      b.textContent = 'Завести свою папку';
    }

    /**
     * Заведение собственной папки. Одно и то же и для «я первый», и для «эта
     * папка не та, хочу свою», поэтому живёт одной функцией.
     */
    async function createOwnFolder(button) {
      const err = $('wiz-folder-error');
      err.textContent = '';
      button.disabled = true;
      try {
        const email = await settings.get('driveEmail');
        const root = await drive.createRoot(rootName(GOOGLE.folderName, email));
        await useFolder(root);
        onToast(`Папка «${root.name}» создана`);
      } catch (e) {
        err.textContent = e.message || 'Не удалось создать папку';
      } finally {
        button.disabled = false;
      }
    }

    /**
     * Подключение к чужой папке. Одно и то же и для «я второй», и для «это не
     * та папка», поэтому живёт одной функцией.
     */
    async function connectToShared() {
      const err = $('wiz-folder-error');
      err.textContent = '';
      try {
        const token = await G.getAccessToken({ interactive: true });
        const folder = await pickFolder(token);
        if (!folder) return;
        // В окне Google можно провалиться внутрь альбома и выбрать папку года —
        // тогда «альбомом» стала бы она, а настройки и все прошлые годы
        // остались бы снаружи. Имена там всегда числовые, это и ловим.
        if (/^\d{1,4}$/.test(folder.name.trim())) {
          err.textContent =
            'Это папка года внутри альбома, а нужна папка альбома целиком — ' +
            'та, что подписана почтой. В окне выбора вернитесь на шаг назад.';
          return;
        }
        // Выбранная папка чужая, поэтому nameRoot её не тронет — подпись
        // на ней уже стоит, от владельца.
        await drive.adoptRoot(folder.id);
        await useFolder({ id: folder.id, name: folder.name, ownedByMe: false });
        onToast(`Папка «${folder.name}» подключена`);
      } catch (e) {
        err.textContent = e.message || 'Не удалось выбрать папку';
      }
    }

    // --- что происходит при входе в каждый шаг ---------------------------
    const enter = {
      async welcome() {
        // Ключ приложения не заполнен — это недоделанная выкладка, а не задача
        // пользователя. Говорим прямо, вместо того чтобы вести его в тупик.
        const ready = configured();
        $('wiz-not-configured').classList.toggle('hidden', ready);
        setNext(ready ? 'Начать' : 'Приложение не настроено', ready);
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
        // Вход сам перебрасывает на следующий шаг, так что вперёд отсюда
        // ведёт только он. «Дальше» нужно единственному, кто сюда вернулся
        // кнопкой «назад», уже войдя.
        setNext(has ? 'Дальше' : null);
      },

      async folder() {
        const err = $('wiz-folder-error');
        err.textContent = '';
        setNext(null);
        $('wiz-folder-ok').classList.add('hidden');
        $('wiz-folder-choice').classList.add('hidden');
        $('wiz-folder-text').textContent = 'Ищу папку в вашем Диске…';

        try {
          const root = await drive.findRoot(state.folderId);
          if (root) return await useFolder(root, { found: true });
          askWhoYouAre();
        } catch (e) {
          // Папку не нашли из-за сети — предлагать «завести» тут нельзя:
          // именно так рядом со старым альбомом и появляется второй.
          // Единственное честное действие — повторить попытку.
          $('wiz-folder-text').textContent = 'Не удалось заглянуть в Диск.';
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
      },

      async install() {
        $('wiz-install-ios').classList.toggle('hidden', !isIOS());
        $('wiz-install-other').classList.toggle('hidden', isIOS());
        // «Готово» и «Позже» вели в одно и то же место: установку на домашний
        // экран делает браузер, приложение о ней не знает и знать не может.
        // Две кнопки изображали выбор, которого нет.
        setNext('Дальше');
      },

      async invite() {
        $('wiz-invite-folder').href = state.folderId
          ? `https://drive.google.com/drive/folders/${state.folderId}`
          : 'https://drive.google.com';
        setNext('Дальше');
      },

      async done() {
        const c = await settings.all();
        const who = c.babyName ? c.babyName : 'ребёнка';
        $('wiz-done-text').textContent = state.remoteDays
          ? `В папке ${state.remoteDays} дней — сейчас прочитаю опись, и они ` +
            'появятся в календаре. Сами снимки подтянутся по одному, когда ' +
            'откроете день или соберётесь делать таймлапс.'
          : `Осталось снять первый кадр. Дальше — по одному фото ${who} в день; ` +
            'приложение само посчитает дни и соберёт таймлапс, когда захотите.';
        setNext(state.remoteDays ? 'Открыть календарь' : 'Снять первое фото');
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

    $('wiz-signin').onclick = async () => {
      const err = $('wiz-signin-error');
      err.textContent = '';
      $('wiz-signin').disabled = true;
      try {
        const { accessToken } = await G.requestToken({ interactive: true, chooseAccount: true });
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

    $('wiz-folder-create').onclick = () => createOwnFolder($('wiz-folder-create'));

    // Завести свою поверх уже подключённой можно, но одним касанием — только
    // пока переключать нечего. Если в текущей папке уже лежат дни, они в ней
    // и останутся, и человек должен это увидеть до того, как нажмёт.
    $('wiz-folder-new').onclick = () => {
      const b = $('wiz-folder-new');
      if (state.remoteDays && !b.dataset.sure) {
        b.dataset.sure = '1';
        b.textContent = 'Всё равно завести новую';
        $('wiz-folder-error').textContent =
          `В текущей папке ${state.remoteDays} дней — они останутся в ней.`;
        return;
      }
      resetNewFolder();
      return createOwnFolder(b);
    };

    $('wiz-pick-folder').onclick = connectToShared;
    $('wiz-folder-other').onclick = connectToShared;

    $('wiz-invite-share').onclick = async () => {
      const text = 'Ставь себе — сюда складываем по фото в день. ' +
        'Открой в Safari и добавь на домашний экран.';
      try {
        if (navigator.share) {
          await navigator.share({ title: 'TimelapseBaby', text, url: location.href });
        } else if (await copy(location.href)) {
          onToast('Ссылка скопирована');
        }
      } catch { /* закрыли окно «Поделиться» */ }
    };

    async function finish() {
      await settings.set('onboardingDone', true);

      // Имя и дату второй родитель читает из config.json в папке — значит, тот,
      // кто завёл альбом, должен его туда положить. Раньше файл появлялся
      // только после первого захода в настройки, и до тех пор подключившийся
      // к общей папке видел пустой экран «Про кого снимаем».
      const c = await settings.all();
      if (!state.remoteProfile && c.driveFolderId && c.birthDate) {
        try {
          await pushProfile(drive);
        } catch { /* нет сети — уедет при первой правке настроек */ }
      }

      $('wizard').classList.add('hidden');
      resolve();
    }

    $('wizard').classList.remove('hidden');
    await show(0);
  });
}
