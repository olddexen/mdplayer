'use strict';
/**
 * Источник плейлиста: ссылка (с резервной копией на случай обрыва связи)
 * или файл, загруженный через веб-интерфейс.
 */
const fs = require('fs');
const path = require('path');
const httpClient = require('./http-client');
const m3u = require('./m3u');

function formatDate(ms) {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? `0${n}` : String(n));
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

class PlaylistManager {
  constructor(dataDir) {
    this.uploadPath = path.join(dataDir, 'playlist-upload.m3u8');
    this.cachePath = path.join(dataDir, 'playlist-cache.json');
    this.channels = [];
    this.groups = [];
    this.epgUrls = [];
    this.byId = new Map();
    this.version = 0;          // растёт при каждой загрузке — так клиент узнаёт, что список изменился
    this.loadedAt = 0;
    this.fromCache = false;    // загружена резервная копия: попробовать скачать снова пораньше
    this.status = { state: 'empty', message: '' };
  }

  hasUpload() {
    return fs.existsSync(this.uploadPath);
  }

  /** Проверяет файл от пользователя и сохраняет его в data/. */
  saveUpload(content) {
    m3u.parse(content);
    fs.writeFileSync(this.uploadPath, content);
  }

  async load(cfg) {
    if (!this.channels.length) this.status = { state: 'loading', message: '' };
    let parsed;
    let warning = '';

    if (cfg.playlistSource === 'file') {
      let text;
      try {
        text = fs.readFileSync(this.uploadPath, 'utf8');
      } catch (err) {
        throw new Error('Файл плейлиста не найден — загрузите его заново в настройках');
      }
      parsed = m3u.parse(text);
    } else {
      if (!cfg.playlistUrl) throw new Error('Не указана ссылка на плейлист');
      try {
        const { text } = await httpClient.fetchText(cfg.playlistUrl, { timeout: 30000 });
        parsed = m3u.parse(text);
        this.saveCache(cfg.playlistUrl, text);
      } catch (err) {
        const cached = this.readCache(cfg.playlistUrl);
        if (!cached) throw new Error(`Не удалось загрузить плейлист: ${err.message}`);
        parsed = m3u.parse(cached.text);
        warning = `Сервер плейлиста недоступен (${err.message}). Используется копия от ${formatDate(cached.savedAt)}`;
      }
    }

    this.channels = parsed.channels;
    this.groups = parsed.groups;
    this.epgUrls = parsed.epgUrls;
    this.byId = new Map(parsed.channels.map((ch) => [ch.id, ch]));
    this.version += 1;
    this.loadedAt = Date.now();
    this.fromCache = !!warning;
    this.status = { state: 'ready', message: warning };
  }

  saveCache(url, text) {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify({ url, savedAt: Date.now(), text }));
    } catch (err) {
      console.warn(`[playlist] Не удалось сохранить резервную копию: ${err.message}`);
    }
  }

  readCache(url) {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      return cached.url === url ? cached : null;
    } catch (e) {
      return null;
    }
  }

  publicStatus() {
    return {
      state: this.status.state,
      message: this.status.message,
      count: this.channels.length,
      groups: this.groups.length,
      updatedAt: this.loadedAt,
      version: this.version,
      epgUrls: this.epgUrls
    };
  }
}

module.exports = PlaylistManager;
