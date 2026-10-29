'use strict';
/**
 * Связующий слой: настройки + плейлист + EPG + ссылки на эфир и архив.
 * Методы *Payload готовят ответы для REST API (lib/api.js).
 */
const config = require('./config');
const httpClient = require('./http-client');
const PlaylistManager = require('./playlist');
const { EpgManager, DEFAULT_EPG_URL } = require('./epg');
const catchup = require('./catchup');
const proxy = require('./proxy');

const PLAYLIST_TTL = 6 * 3600 * 1000;      // плейлист по ссылке перечитывается раз в 6 часов
const CHECK_INTERVAL = 30 * 60 * 1000;     // проверка «не пора ли обновить» — раз в 30 минут

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

class TvService {
  constructor() {
    this.config = config.load();
    httpClient.setUserAgent(this.config.userAgent);
    this.playlist = new PlaylistManager(config.DATA_DIR);
    this.epg = new EpgManager(config.DATA_DIR);
  }

  isConfigured() {
    return this.config.playlistSource === 'file' ? this.playlist.hasUpload() : !!this.config.playlistUrl;
  }

  async start() {
    this.epg.loadCache();
    setInterval(() => this.periodic(), CHECK_INTERVAL);
    if (!this.isConfigured()) {
      console.log('Плейлист ещё не указан — откройте страницу в браузере и задайте его в настройках');
      return;
    }
    try {
      await this.reloadPlaylist();
    } catch (err) {
      console.error(`[playlist] ${err.message}`);
    }
  }

  periodic() {
    if (!this.isConfigured()) return;
    const pl = this.playlist;
    const stale = this.config.playlistSource === 'url' && (pl.fromCache || Date.now() - pl.loadedAt > PLAYLIST_TTL);
    if (stale) this.reloadPlaylist().catch((err) => console.error(`[playlist] ${err.message}`));
    else this.refreshEpg(false);
  }

  async reloadPlaylist() {
    try {
      await this.playlist.load(this.config);
    } catch (err) {
      this.playlist.status = this.playlist.channels.length
        ? { state: 'ready', message: `Не удалось обновить плейлист: ${err.message}` }
        : { state: 'error', message: err.message };
      throw err;
    }
    this.afterPlaylistLoad();
  }

  afterPlaylistLoad() {
    const pl = this.playlist;
    console.log(`[playlist] Каналов: ${pl.channels.length}, категорий: ${pl.groups.length}`);
    if (pl.status.message) console.warn(`[playlist] ${pl.status.message}`);
    this.epg.bind(pl.channels);
    this.refreshEpg(false);
  }

  epgUrls() {
    if (this.config.epgUrl) return [this.config.epgUrl];
    return this.playlist.epgUrls.length ? this.playlist.epgUrls : [DEFAULT_EPG_URL];
  }

  /** Обновление EPG идёт в фоне; ход виден в /api/state. */
  refreshEpg(force) {
    if (!this.playlist.channels.length) return Promise.resolve();
    return this.epg.update(this.epgUrls(), this.playlist.channels, force);
  }

  /** Сохраняет настройки из веб-интерфейса. Новый плейлист проверяется до записи config.json. */
  async saveConfig(body) {
    const prev = this.config;
    const next = Object.assign({}, prev);
    if (typeof body.epgUrl === 'string') next.epgUrl = body.epgUrl.trim();
    if (typeof body.proxy === 'boolean') next.proxy = body.proxy;
    const notReady = this.playlist.status.state !== 'ready';
    let reload = false;

    try {
      if (body.playlistSource === 'file') {
        next.playlistSource = 'file';
        if (typeof body.playlistContent === 'string' && body.playlistContent) {
          this.playlist.saveUpload(body.playlistContent);
          next.playlistFileName = String(body.playlistFileName || 'playlist.m3u8').slice(0, 200);
          reload = true;
        } else if (!this.playlist.hasUpload()) {
          throw new Error('Выберите файл плейлиста');
        } else {
          reload = prev.playlistSource !== 'file' || notReady;
        }
      } else if (body.playlistSource === 'url') {
        const url = String(body.playlistUrl || '').trim();
        if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Укажите ссылку на плейлист, начинающуюся с http:// или https://');
        next.playlistSource = 'url';
        next.playlistUrl = url;
        reload = url !== prev.playlistUrl || prev.playlistSource !== 'url' || notReady;
      }
      if (reload) await this.playlist.load(next);
    } catch (err) {
      throw httpError(400, err.message);
    }

    const epgChanged = next.epgUrl !== prev.epgUrl;
    config.save(next);
    this.config = next;
    if (reload) this.afterPlaylistLoad();
    else if (epgChanged) this.refreshEpg(true);
    return this.state();
  }

  async refresh(what) {
    if (what === 'epg') {
      if (!this.playlist.channels.length) throw httpError(400, 'Сначала загрузите плейлист');
      this.refreshEpg(true);
      return this.state();
    }
    if (!this.isConfigured()) throw httpError(400, 'Сначала укажите плейлист в настройках');
    try {
      await this.reloadPlaylist();
    } catch (err) {
      throw httpError(502, err.message);
    }
    return this.state();
  }

  state() {
    const c = this.config;
    return {
      configured: this.isConfigured(),
      config: {
        playlistSource: c.playlistSource,
        playlistUrl: c.playlistUrl,
        playlistFileName: c.playlistFileName,
        epgUrl: c.epgUrl,
        proxy: c.proxy
      },
      playlist: this.playlist.publicStatus(),
      epg: Object.assign(this.epg.publicStatus(), { sources: this.epgUrls() })
    };
  }

  channel(id) {
    const ch = this.playlist.byId.get(String(id || ''));
    if (!ch) throw httpError(404, 'Канал не найден — возможно, плейлист обновился');
    return ch;
  }

  /** Ссылка для плеера в браузере: через прокси (обход CORS) или напрямую. */
  playable(url) {
    return this.config.proxy ? proxy.proxify(url) : url;
  }

  channelsPayload() {
    return {
      version: this.playlist.version,
      groups: this.playlist.groups,
      channels: this.playlist.channels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        group: ch.group,
        logo: ch.logo || this.epg.iconOf(ch),
        archive: ch.catchupDays
      }))
    };
  }

  /** Что идёт сейчас на каждом канале: { id: [название, начало, конец] }. */
  nowPayload() {
    const now = nowSec();
    const items = {};
    this.playlist.channels.forEach((ch) => {
      const p = this.epg.currentOf(ch, now);
      if (p) items[ch.id] = [p[2], p[0], p[1]];
    });
    return { now, items };
  }

  epgPayload(id) {
    const ch = this.channel(id);
    const now = nowSec();
    const from = now - Math.max(ch.catchupDays, 1) * 86400;   // раньше архива смотреть нечего
    return {
      id: ch.id,
      now,
      archiveDays: ch.catchupDays,
      programmes: this.epg.programmesOf(ch).filter((p) => p[1] > from),
      epg: this.epg.publicStatus()
    };
  }

  streamPayload(id) {
    const ch = this.channel(id);
    return { url: this.playable(ch.url), direct: ch.url };
  }

  /** Ссылка на передачу из архива: сервер добавляет к адресу потока параметры времени. */
  archivePayload(id, start, stop) {
    const ch = this.channel(id);
    const from = parseInt(start, 10);
    const to = parseInt(stop, 10) || 0;
    if (!from) throw httpError(400, 'Не указано время начала передачи');
    const direct = catchup.buildArchiveUrl(ch, from, to);
    return { url: this.playable(direct), direct, start: from, stop: to };
  }
}

module.exports = TvService;
