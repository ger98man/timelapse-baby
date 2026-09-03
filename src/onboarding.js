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
import { forgetAlbum, renameProject } from './store.js';
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
      folderName: cfg.driveFolderName,
      remoteDays: 0,
      remoteProfile: false,
      reauth: false,
      // Главная папка: одна на человека, внутри неё альбомы детей. Пусто —
      // законно: второму родителю дают доступ на папку ребёнка, а не на весь
      // дом первого.
      homeId: cfg.homeFolderId,
      homeName: cfg.homeFolderId ? cfg.homeFolderName : '',
      albums: [],
      creating: false,      // «Про кого снимаем» открыт ради нового альбома
    };

    // В мастере токен просим интерактивно: человек прямо сейчас у экрана и
    // готов подтвердить, а молча упереться в «нужно переподключить» — тупик.
    const drive = createDrive({
      getToken: opts => G.getAccessToken({ interactive: true, ...opts }),
    });

    // Набор шагов подстраивается на ходу: «Про кого снимаем» отпадает, если
    // настройки уже приехали из папки, а «На домашний экран» — если приложение
    // и так запущено с него.
    const steps = ['welcome', 'signin', 'home', 'album', 'baby'];
    if (!standalone()) steps.push('install');
    steps.push('invite', 'done');

    function dropStep(name) {
      const i = steps.indexOf(name);
      if (i > at) steps.splice(i, 1);
    }

    /** Вернуть выброшенный шаг: «Про кого снимаем» нужен снова, когда завели
     *  новый альбом — там ещё никто не спрашивал ни имени, ни даты. */
    function addStep(name, after) {
      if (steps.includes(name)) return;
      const i = steps.indexOf(after);
      steps.splice(i < 0 ? steps.length : i + 1, 0, name);
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

    /**
     * Крутилка вместо содержимого, пока Диск отвечает.
     *
     * Без неё шаг выглядит доделанным — а через секунду под руками сам собой
     * появляется список и кнопка, которых только что не было. Показать, что
     * идёт ожидание, дешевле, чем потом объяснять этот прыжок.
     *
     * @param {string} id блок с крутилкой
     * @param {?string} text что ждём; null — дождались, крутилку убрать
     */
    function waiting(id, text) {
      const box = $(id);
      if (text) box.querySelector('span').textContent = text;
      box.classList.toggle('hidden', !text);
    }

    /** Плавное появление того, что дождались. */
    function appear(el) {
      el.classList.remove('hidden', 'appear');
      void el.offsetWidth;                 // перезапуск анимации
      el.classList.add('appear');
    }

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
     * Главной папки нет — спрашиваем, кто пришёл. Заводить её молча нельзя:
     * у второго родителя от этого появляется собственный пустой альбом рядом
     * с общим, и дальше он снимает не туда, ничего не подозревая.
     */
    function askWhoYouAre(why = null) {
      $('wiz-home-text').textContent = why ||
        'Папки пока нет. Если снимать начинаете вы — заведу её в вашем Диске. ' +
        'Если начал второй родитель — подключитесь к его папке.';
      waiting('wiz-home-wait', null);
      $('wiz-home-ok').classList.add('hidden');
      appear($('wiz-home-choice'));
      $('wiz-home-pick').classList.toggle('hidden', !pickerReady());
      setNext(null);
    }

    /**
     * Главная папка известна: показать и запомнить.
     *
     * Её может не быть и законно: второму родителю дают доступ на папку одного
     * ребёнка, а не на весь дом первого. Тогда в карточке стоит сам альбом, и
     * это честнее, чем показывать пустое место.
     */
    function showHome() {
      const home = state.homeName;
      waiting('wiz-home-wait', null);
      $('wiz-home-choice').classList.add('hidden');
      appear($('wiz-home-ok'));
      // Корневая папка обязана быть: без неё некуда класть следующего ребёнка
      // и не из чего выбирать. Нет — значит вопрос не закрыт, и вместо
      // карточки снова стоят кнопки «завести» и «выбрать».
      if (!home) {
        const album = String(state.folderName || '').split(' — ')[0].trim();
        askWhoYouAre(album
          ? `Папка «${album}» подключена — снимать в неё уже можно. Но корневой ` +
            'над ней не видно, а она нужна: в ней лежат ваши альбомы.'
          : null);
        return;
      }
      $('wiz-home-name').textContent = home;
      $('wiz-home-sub').textContent = 'Здесь лежат альбомы всех детей';
      $('wiz-home-text').textContent = 'Всё, что вы снимете, будет складываться сюда.';
      $('wiz-home-other').classList.toggle('hidden', !pickerReady());
      setNext('Дальше', true);
    }

    /** Запоминает главную папку — и в мастере, и в настройках. */
    async function useHome(home, name) {
      state.homeId = home.id;
      state.homeName = name;
      await settings.merge({ homeFolderId: home.id, homeFolderName: name });
    }

    /**
     * Заведение главной папки. Альбом внутри неё заведут на следующем шаге:
     * два вопроса на одном экране не помещаются, а порядок «где» → «кто»
     * человеку понятнее обратного.
     */
    async function createHome(button) {
      const err = $('wiz-home-error');
      err.textContent = '';
      button.disabled = true;
      try {
        const email = await settings.get('driveEmail');
        const home = await drive.createHome(rootName(GOOGLE.folderName, email));
        await useHome(home, home.name);
        showHome();
        onToast(`Папка «${home.name}» создана`);
      } catch (e) {
        err.textContent = e.message || 'Не удалось создать папку';
      } finally {
        button.disabled = false;
      }
    }

    /**
     * Подключение к чужой папке. Что именно выбрали — главную папку со всеми
     * детьми или папку одного ребёнка, — решает содержимое: первому родителю
     * проще поделиться домом целиком, но чаще делятся одним ребёнком.
     */
    async function connectToShared() {
      const err = $('wiz-home-error');
      err.textContent = '';
      try {
        const token = await G.getAccessToken({ interactive: true });
        const folder = await pickFolder(token);
        if (!folder) {
          // Окно могли закрыть, а могли и не увидеть: свои ошибки Google
          // показывает внутри окна и наружу не отдаёт. Самая частая из них
          // чинится в консоли за минуту, но догадаться про это нельзя.
          err.textContent =
            'Папку не выбрали. Если вместо списка папок Google показал ' +
            '«The API developer key is invalid» — в проекте не включён ' +
            'Google Picker API или ключ ограничен по сайту.';
          return;
        }
        // В окне Google можно провалиться внутрь альбома и выбрать папку года —
        // тогда «альбомом» стала бы она, а настройки и все прошлые годы
        // остались бы снаружи. Имена там всегда числовые, это и ловим.
        if (/^\d{1,4}$/.test(folder.name.trim())) {
          err.textContent =
            'Это папка года внутри альбома, а нужна папка целиком — та, что ' +
            'подписана именем ребёнка или почтой. Вернитесь на шаг назад.';
          return;
        }

        const kind = await drive.folderKind(folder.id);
        // Дни прежней папки к новой не относятся — кэш пересоберётся из неё.
        await forgetAlbum();
        if (kind === 'home') {
          await drive.adoptHome(folder.id);
          await useHome(folder, folder.name);
          state.folderId = null;
          state.folderName = '';
          await settings.merge({ driveFolderId: null, driveFolderName: '' });
        } else {
          // Папка чужая, подпись на ней уже стоит — от владельца. Корневая
          // может найтись сама: если доступ дали и на папку выше, это она и
          // есть. Не видно — корневой у нас нет, и это законно: доступ дали
          // на одного ребёнка, а не на всех.
          await drive.adoptRoot(folder.id);
          const above = await drive.parentHome(folder.id);
          if (above) await drive.adoptHome(above.id);
          state.homeId = above ? above.id : null;
          state.homeName = above ? above.name : '';
          await settings.merge({
            homeFolderId: state.homeId,
            homeFolderName: state.homeName,
          });
          await chooseAlbum({ id: folder.id, name: folder.name, ownedByMe: false });
        }
        showHome();
        onToast(`Папка «${folder.name}» подключена`);
      } catch (e) {
        err.textContent = e.message || 'Не удалось выбрать папку';
      }
    }

    // --- шаг «Кого снимаем» ----------------------------------------------

    const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.6 4.5L19 7.5" ' +
      'fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" ' +
      'stroke-linejoin="round"/></svg>';

    /**
     * Список альбомов — по строчке на ребёнка. Ровно те папки, что лежат
     * внутри выбранной главной: она выбрана на прошлом шаге, и показывать
     * рядом чужие папки из других мест Диска значит предлагать снимать не
     * туда, куда человек только что решил.
     *
     * Собирается из Диска, а не из памяти телефона: альбом мог завестись на
     * другом телефоне, и предлагать завести его второй раз нельзя.
     */
    async function renderAlbums() {
      const list = $('wiz-albums');
      const err = $('wiz-album-error');
      const add = $('wiz-album-new');
      err.textContent = '';
      list.textContent = '';
      $('wiz-album-text').textContent = '';
      // Кнопку прячем вместе со списком: пока неизвестно, есть ли альбомы,
      // неизвестно и что предлагать — выбрать или завести первого.
      add.classList.add('hidden');
      waiting('wiz-album-wait', 'Смотрю, какие альбомы есть…');
      setNext(null);

      let albums = [];
      try {
        albums = await drive.albumsFor(state.homeId, state.folderId);
      } catch (e) {
        waiting('wiz-album-wait', null);
        err.textContent = e.message || 'Диск не ответил — список не пришёл';
        return;
      }
      state.albums = albums;
      // Крутилку гасим не сразу: если следом сами выберем первого, она просто
      // сменит надпись и будет крутиться дальше. Погасить и через мгновение
      // зажечь снова — то самое мигание, ради которого её и заводили.
      const autopick = !state.folderId && albums.length > 0;
      if (!autopick) waiting('wiz-album-wait', null);
      if (state.homeId) appear(add);

      if (!albums.length) {
        $('wiz-album-text').textContent =
          'Ни одного альбома пока нет. Заведите первый — это папка ребёнка.';
        return;
      }

      $('wiz-album-text').textContent = albums.length > 1
        ? 'Выберите, кого снимаете. Переключаться между детьми можно и потом.'
        : 'Вот кто уже заведён. Можно снимать его или завести ещё одного.';

      for (const album of albums) {
        const on = album.id === state.folderId;
        const row = document.createElement('button');
        row.className = 'album' + (on ? ' now' : '');
        row.type = 'button';
        row.setAttribute('aria-pressed', String(on));
        row.title = album.name;

        const text = document.createElement('span');
        text.className = 'album-text';
        const name = document.createElement('b');
        name.textContent = String(album.name || '').split(' — ')[0].trim();
        text.append(name);
        if (!album.ownedByMe) {
          const owner = (album.owners || [])[0];
          const sub = document.createElement('span');
          sub.className = 'album-sub';
          sub.textContent = owner && owner.emailAddress
            ? `общая папка ${owner.emailAddress}`
            : 'общая папка';
          text.append(sub);
        }
        row.append(text);

        const tick = document.createElement('span');
        tick.className = 'album-tick';
        tick.innerHTML = on ? TICK : '';
        row.append(tick);

        row.onclick = () => pickAlbum(album, row);
        list.append(row);
      }

      // Ничего не выбрано — выбираем первого сами. Экран с единственным
      // ребёнком и погашенной кнопкой «Дальше» выглядит как поломка: выбор
      // вроде бы сделан, а идти дальше нельзя. Тап по строчке всё равно
      // остаётся — переключиться на другого можно тут же.
      if (autopick) {
        await pickAlbum(albums[0], list.firstElementChild);
        return;
      }

      // Альбом мог быть выбран и раньше — на этом телефоне или на другом.
      // Тогда переспрашивать про ребёнка тоже незачем.
      await syncBabyStep();
      setNext('Дальше', true);
    }

    /** Тап по строчке: переключаемся и забираем из папки её настройки. */
    async function pickAlbum(album, row) {
      const err = $('wiz-album-error');
      err.textContent = '';
      if (album.id === state.folderId) return;
      for (const b of $('wiz-albums').querySelectorAll('.album')) {
        b.classList.remove('now');
        b.setAttribute('aria-pressed', 'false');
        b.querySelector('.album-tick').innerHTML = '';
      }
      row.classList.add('now');
      row.setAttribute('aria-pressed', 'true');
      row.querySelector('.album-tick').innerHTML = TICK;

      // Настройки альбома лежат в его папке, и за ними идёт ещё один запрос.
      // Пока он идёт, список занят: второй тап уехал бы в тот же запрос.
      $('wiz-albums').classList.add('busy');
      waiting('wiz-album-wait', 'Читаю настройки альбома…');
      try {
        // Дни прежнего альбома к этому не относятся — кэш соберётся заново.
        await forgetAlbum();
        await chooseAlbum(album);
        setNext('Дальше', true);
      } catch (e) {
        err.textContent = e.message || 'Не удалось открыть альбом';
      } finally {
        $('wiz-albums').classList.remove('busy');
        waiting('wiz-album-wait', null);
      }
    }

    /**
     * Альбом выбран: запомнить и забрать из его папки настройки. Если имя и
     * дата там уже лежат, шаг «Про кого снимаем» отпадает — второй родитель
     * получает всё готовым и не вводит ничего.
     */
    async function chooseAlbum(album) {
      state.folderId = album.id;
      state.folderName = album.name;
      await settings.merge({
        driveFolderId: album.id,
        driveFolderName: album.name,
        babyName: '', birthDate: null, dueDate: null,
      });

      const files = await drive.listDayFiles(album.id);
      state.remoteDays = countRemoteDays(files);
      const remote = await fetchProfile(drive, files);
      state.remoteProfile = Boolean(remote && remote.birthDate);
      if (remote) {
        const patch = {};
        for (const key of PROFILE_KEYS) {
          if (remote[key] !== undefined && remote[key] !== null) patch[key] = remote[key];
        }
        await settings.merge(patch);
      }
      // Настроек в папке нет — имя всё равно есть: так она и называется.
      // Спрашивать имя ребёнка, стоя в папке с его именем, незачем.
      if (!remote || !remote.babyName) {
        await settings.set('babyName', String(album.name || '').split(' — ')[0].trim());
      }
      state.creating = false;
      await syncBabyStep();
    }

    /**
     * «Про кого снимаем» нужен ровно там, где даты рождения ещё нет: от неё
     * считаются дни, без неё приложение не умеет ничего. Всё остальное —
     * повтор вопроса, на который человек уже ответил: выбрав альбом, он
     * выбрал и ребёнка вместе с его настройками.
     */
    async function syncBabyStep() {
      if (await settings.get('birthDate')) dropStep('baby');
      else addStep('baby', 'album');
      renderChrome();
    }

    /** «Создать новый альбом» — тот же вопрос про ребёнка, только папки ещё нет. */
    function startNewAlbum() {
      state.creating = true;
      addStep('baby', 'album');
      renderChrome();
      next();
    }

    /**
     * Заводит папку ребёнка. Зовётся с шага «Про кого снимаем»: имя и дата
     * уже введены, и папка получает имя сразу — «Малыш», который потом
     * переименуют, человек всё равно успел бы увидеть в Диске.
     */
    async function createAlbum(name) {
      const home = state.homeId
        || (await drive.findHome(await settings.get('homeFolderId')) || {}).id;
      if (!home) throw new Error('Главная папка не найдена — вернитесь на шаг назад');
      const root = await drive.createRoot(name, home);
      state.folderId = root.id;
      state.folderName = root.name;
      state.remoteDays = 0;
      state.remoteProfile = false;
      state.creating = false;
      await settings.merge({ driveFolderId: root.id, driveFolderName: root.name });
      return root;
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
          $('wiz-account-name').textContent = 'Аккаунт подключён';
          $('wiz-avatar').style.display = 'none';
        }
        $('wiz-signin-error').textContent = '';
        // Вход сам перебрасывает на следующий шаг, так что вперёд отсюда
        // ведёт только он. «Дальше» нужно единственному, кто сюда вернулся
        // кнопкой «назад», уже войдя.
        setNext(has ? 'Дальше' : null);
      },

      async home() {
        const err = $('wiz-home-error');
        err.textContent = '';
        state.reauth = false;
        setNext(null);
        $('wiz-home-ok').classList.add('hidden');
        $('wiz-home-choice').classList.add('hidden');
        $('wiz-home-text').textContent = '';
        waiting('wiz-home-wait', 'Ищу папку в вашем Диске…');

        try {
          const cfg2 = await settings.all();
          const home = await drive.findHome(cfg2.homeFolderId);
          if (home) {
            await useHome(home, await drive.nameHome(home, cfg2.driveEmail));
            return showHome();
          }
          askWhoYouAre();
        } catch (e) {
          // Папку не нашли из-за сети — предлагать «завести» тут нельзя:
          // именно так рядом со старым альбомом и появляется второй.
          // Единственное честное действие — повторить попытку.
          waiting('wiz-home-wait', null);
          $('wiz-home-text').textContent = 'Не удалось заглянуть в Диск.';
          err.textContent = e.message || 'Google Диск не ответил';
          // Вход не приняли — «попробовать снова» упрётся в то же самое.
          // Окно Google открывается только по нажатию, поэтому возвращаем
          // человека на шаг входа: там кнопка, а значит и разрешённый тап.
          state.reauth = e && e.code === 'auth';
          setNext(state.reauth ? 'Войти заново' : 'Попробовать снова', true);
        }
      },

      async album() {
        // Вернулись сюда кнопкой «назад» — значит, заводить передумали.
        // Иначе «Дальше» с выбранным альбомом завело бы ещё один, такой же.
        state.creating = false;
        await renderAlbums();
      },

      async baby() {
        const c = await settings.all();
        const made = state.creating;
        $('wiz-baby-title').textContent = made ? 'Новый альбом' : 'Про кого снимаем';
        $('wiz-baby-text').textContent = made
          ? `Папка с этим именем появится внутри «${state.homeName}».`
          : '';
        $('wiz-baby-text').classList.toggle('hidden', !made);
        $('wiz-name').value = made ? '' : (c.babyName || '');
        $('wiz-birth').value = made ? D.todayKey() : (c.birthDate || D.todayKey());
        $('wiz-baby-error').textContent = '';
        setNext(made ? 'Создать альбом' : 'Дальше');
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
      async home() {
        // Без корневой папки дальше нельзя: следующий шаг — выбор ребёнка
        // внутри неё, и выбирать было бы не из чего.
        return Boolean(state.homeId);
      },

      async album() {
        return Boolean(state.folderId);
      },

      async baby() {
        const err = $('wiz-baby-error');
        const birth = $('wiz-birth').value;
        const name = $('wiz-name').value.trim();
        if (!name) {
          err.textContent = 'Имя нужно — им же называется папка';
          return false;
        }
        if (!birth) {
          err.textContent = 'Поставьте дату — от неё считаются дни';
          return false;
        }

        // Заводим папку прямо отсюда: имя и дата уже введены, и «Малыш»,
        // которого потом переименуют, человек всё равно успел бы увидеть
        // в Диске.
        if (state.creating) {
          err.textContent = '';
          setNext('Создаю альбом…', false);
          try {
            const root = await createAlbum(name);
            onToast(`Альбом «${root.name}» создан`);
          } catch (e) {
            err.textContent = e.message || 'Не удалось создать альбом';
            setNext('Создать альбом', true);
            return false;
          }
        }

        const future = D.diffDays(D.todayKey(), birth) > 0;
        await settings.merge({
          babyName: name,
          birthDate: birth,
          dueDate: future ? birth : null,
        });
        // Имя ребёнка — оно же имя папки. Не вышло (нет сети, папка чужая) —
        // не беда: переименовать её можно и руками в Диске.
        try {
          const got = await renameProject(drive, name);
          if (got) state.folderName = got;
        } catch { /* Диск не ответил — папка останется как есть */ }

        // Кладём config.json в папку сразу, а не в конце мастера. Иначе
        // альбом, заведённый в мастере, до самого финиша ничего о себе не
        // знает — и человек, вернувшийся выбрать его заново, слышит те же
        // вопросы во второй раз.
        try {
          await pushProfile(drive);
          state.remoteProfile = true;
        } catch { /* нет сети — уедет из finish или при первой правке */ }
        return true;
      },
    };

    // --- обработчики -----------------------------------------------------
    $('wiz-back').onclick = () => show(at - 1);

    $('wiz-next').onclick = async () => {
      const step = steps[at];
      if (leave[step] && !(await leave[step]())) return;
      if (step === 'done') return finish();
      // На шаге главной папки «Дальше» подменяется на «Войти заново» и
      // «Попробовать снова»: вперёд оттуда идти не с чем.
      if (step === 'home' && state.reauth) {
        state.reauth = false;
        state.signedIn = false;
        return show(steps.indexOf('signin'));
      }
      if (step === 'home' && !state.homeId) return enter.home();
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

    $('wiz-home-create').onclick = () => createHome($('wiz-home-create'));
    $('wiz-home-pick').onclick = connectToShared;
    $('wiz-home-other').onclick = connectToShared;
    $('wiz-album-new').onclick = startNewAlbum;

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
