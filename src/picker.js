// Окно выбора папки Google. Нужно ровно в одном сценарии: второй родитель
// подключается к папке, которую завёл первый.
//
// Приложение не выбирает за человека, в какой альбом он пришёл: своя папка и
// общая называются почти одинаково, отличаясь только почтой в конце. Один тап
// один раз — дальше id папки лежит в настройках и всё работает само.
//
// Вкладка «Доступные мне» обязательна: чужая папка лежит именно там, а не
// в «Моём Диске», и без неё второй родитель её попросту не найдёт.

import { GOOGLE, appId } from '../config.js';

const API_SRC = 'https://apis.google.com/js/api.js';

let loaded = null;

function loadPicker() {
  if (loaded) return loaded;
  loaded = new Promise((resolve, reject) => {
    const done = () => window.gapi.load('picker', {
      callback: () => resolve(window.google.picker),
      onerror: () => reject(new Error('Не удалось загрузить окно выбора')),
    });
    if (window.gapi) return done();
    const s = document.createElement('script');
    s.src = API_SRC;
    s.async = true;
    s.onload = done;
    s.onerror = () => reject(new Error('Не удалось загрузить окно выбора — проверьте интернет'));
    document.head.appendChild(s);
  });
  return loaded;
}

/**
 * Показывает выбор папки.
 * @returns {Promise<?{id:string,name:string}>} null, если закрыли без выбора
 */
export async function pickFolder(accessToken) {
  if (!GOOGLE.apiKey) {
    throw new Error('Для выбора папки нужен apiKey в config.js');
  }
  const picker = await loadPicker();

  const folders = label => new picker.DocsView(picker.ViewId.FOLDERS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true)
    .setMimeTypes('application/vnd.google-apps.folder')
    .setLabel(label);

  return new Promise(resolve => {
    new picker.PickerBuilder()
      .addView(folders('Доступные мне').setOwnedByMe(false))
      .addView(folders('Мой Диск').setOwnedByMe(true))
      .setAppId(appId())
      .setOAuthToken(accessToken)
      .setDeveloperKey(GOOGLE.apiKey)
      .setTitle('Выберите общую папку')
      .setCallback(data => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({ id: doc.id, name: doc.name });
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}
