'use strict';
/**
 * Настройки приложения: config.json в корне проекта.
 * Файл создаётся при первом сохранении настроек из веб-интерфейса.
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const DEFAULTS = {
  playlistSource: 'url',   // 'url' — ссылка, 'file' — загруженный файл
  playlistUrl: '',
  playlistFileName: '',    // имя загруженного файла (только для показа)
  epgUrl: '',              // свои ссылки на XMLTV через запятую; к ним добавляются url-tvg плейлиста и запасная
  epgMap: {},              // ручная привязка: { id канала: "метка:id канала в EPG" }
  proxy: true,             // пропускать потоки через сервер (обход CORS для hls.js)
  host: '127.0.0.1',       // '0.0.0.0' — доступ с других устройств в сети
  port: 8080,
  allowedHosts: [],        // доп. доменные имена сервера (защита от DNS rebinding)
  userAgent: ''            // свой User-Agent для запросов к провайдеру (пусто — стандартный)
};

function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] config.json не читается (${err.message}), используются настройки по умолчанию`);
      try {
        fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bad`);
      } catch (e) {
        // копия испорченного файла не обязательна
      }
    }
  }
  return Object.assign({}, DEFAULTS, saved);
}

/** Запись через временный файл: обрыв питания не оставит полузаписанный config.json. */
function save(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, CONFIG_PATH);
}

module.exports = { load, save, ROOT_DIR, DATA_DIR, PUBLIC_DIR, CONFIG_PATH };
