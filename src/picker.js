// Окно выбора папки Google. Нужно ровно в одном сценарии: второй родитель
// подключается к папке, которую завёл первый.
//
// Со скоупом drive.file приложение не может само найти чужую папку — и это
// правильно. Человек выбирает её руками, и только тогда Google выдаёт доступ
// именно к ней. Один тап один раз, дальше всё работает само.

import { GOOGLE } from '../config.js';

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

  return new Promise(resolve => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder');

    new picker.PickerBuilder()
      .addView(view)
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
