'use strict';
/**
 * Программа передач (EPG, формат XMLTV).
 *
 * - Ссылка: из настроек или из url-tvg / x-tvg-url в заголовке плейлиста.
 * - Файл (обычно .xml.gz) скачивается в data/epg-source.raw и разбирается потоково.
 * - В память попадают только каналы из плейлиста и только передачи в окне
 *   «глубина архива + 1 день назад … 2 дня вперёд» — бережём память телефона.
 * - Результат сохраняется в data/epg.json: после перезапуска сервера программа
 *   доступна сразу, без повторной загрузки.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const httpClient = require('./http-client');
const xmltv = require('./xmltv');

const DEFAULT_EPG_URL = 'http://epg.it999.ru/edem.xml.gz';
const EPG_TTL = 12 * 3600 * 1000;   // как часто скачивать EPG заново
const FUTURE_DAYS = 2;
const DESC_MAX = 300;               // описания обрезаем — экономия памяти
const CACHE_VERSION = 1;

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, '');
}

/** «первыйhd» → «первый»: пометки качества мешают сопоставлению по названию. */
function looseName(key) {
  return key.replace(/(hd|fhd|uhd|4k|orig)$/, '');
}

/**
 * Сопоставитель «канал плейлиста → id канала в EPG».
 * Порядок: tvg-id; затем tvg-name / название точно; затем без пометок HD/4K.
 * entries — массив пар [epgId, [display-name, ...]].
 */
function createMatcher(entries) {
  const byId = new Map();
  const byName = new Map();
  const byLoose = new Map();
  const remember = (map, key, id) => {
    if (key && !map.has(key)) map.set(key, id);
  };

  entries.forEach(([id, names]) => {
    byId.set(id.toLowerCase(), id);
    const all = /^\d+$/.test(id) ? names : names.concat(id);   // числовой id — не название
    all.forEach((name) => {
      const key = normalizeName(name);
      remember(byName, key, id);
      remember(byLoose, looseName(key), id);
    });
  });

  return (ch) => {
    const byTvgId = ch.tvgId && byId.get(ch.tvgId.toLowerCase());
    if (byTvgId) return byTvgId;
    const keys = [ch.tvgId, ch.tvgName, ch.name].map(normalizeName).filter(Boolean);
    for (const key of keys) {
      if (byName.has(key)) return byName.get(key);
    }
    for (const key of keys) {
      const loose = looseName(key);
      if (loose && byLoose.has(loose)) return byLoose.get(loose);
    }
    return null;
  };
}

/** Отпечаток плейлиста: если каналы изменились, EPG надо пересобрать. */
function playlistKey(channels) {
  const hash = crypto.createHash('md5');
  channels.forEach((ch) => hash.update(`${ch.tvgId}|${ch.tvgName}|${ch.name}|${ch.catchupDays}\n`));
  return hash.digest('hex');
}

/** Убирает дубли передач с одинаковым временем начала (список уже отсортирован). */
function dedupe(list) {
  return list.filter((p, i) => i === 0 || p[0] !== list[i - 1][0]);
}

class EpgManager {
  constructor(dataDir) {
    this.rawPath = path.join(dataDir, 'epg-source.raw');
    this.metaPath = path.join(dataDir, 'epg-source.json');
    this.cachePath = path.join(dataDir, 'epg.json');
    // store.programmes: { epgId: [[start, stop, title, desc], ...] }, отсортировано по start
    this.store = null;
    this.links = new Map();   // id канала плейлиста → id канала в EPG
    this.task = null;         // текущее обновление (Promise)
    this.pending = null;      // запрос, пришедший во время обновления
    this.status = { state: 'empty', message: '', progress: 0, error: '' };
  }

  /** Подхватывает программу, сохранённую при прошлом запуске. */
  loadCache() {
    try {
      const store = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (store.version === CACHE_VERSION && store.programmes) {
        this.store = store;
        this.setState('ready', '');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[epg] Кэш программы повреждён и будет пересоздан: ${err.message}`);
    }
  }

  setState(state, message, progress) {
    this.status.state = state;
    this.status.message = message || '';
    this.status.progress = progress || 0;
  }

  isBusy() {
    return this.status.state === 'download' || this.status.state === 'parse';
  }

  publicStatus() {
    const s = this.store;
    return {
      state: this.status.state,
      message: this.status.message,
      progress: this.status.progress,
      error: this.status.error,
      url: s ? s.url : '',
      updatedAt: s ? s.downloadedAt : 0,
      channels: s ? Object.keys(s.programmes).length : 0,
      programmes: s ? s.count : 0,
      matched: this.links.size
    };
  }

  /**
   * Обновляет EPG, если нужно: скачивает заново (раз в 12 часов или force),
   * либо только пересобирает из уже скачанного файла (если изменился плейлист).
   * Никогда не отклоняется: ошибка попадает в status.
   */
  update(urls, channels, force) {
    if (this.task) {
      this.pending = { urls, channels };
      return this.task;
    }
    const key = playlistKey(channels);
    const s = this.store;
    const fresh = s && urls.indexOf(s.url) !== -1 && s.playlistKey === key && Date.now() - s.downloadedAt < EPG_TTL;
    if (fresh && !force) return Promise.resolve();

    this.task = this.run(urls, channels, key, force)
      .then(() => {
        this.status.error = '';
      }, (err) => {
        this.status.error = err.message;
        this.setState(this.store ? 'ready' : 'error', `Не удалось обновить программу: ${err.message}`);
        console.error(`[epg] ${err.message}`);
      })
      .then(() => {
        this.task = null;
        const next = this.pending;
        this.pending = null;
        if (next) this.update(next.urls, next.channels, false);
      });
    return this.task;
  }

  async run(urls, channels, key, force) {
    const errors = [];
    for (const url of urls) {
      try {
        const meta = this.readMeta();
        const haveRaw = meta && meta.url === url && Date.now() - meta.downloadedAt < EPG_TTL && fs.existsSync(this.rawPath);
        const downloadedAt = force || !haveRaw ? await this.download(url) : meta.downloadedAt;
        await this.build(url, downloadedAt, channels, key);
        return;
      } catch (err) {
        errors.push(urls.length > 1 ? `${url}: ${err.message}` : err.message);
      }
    }
    throw new Error(errors.join('; '));
  }

  readMeta() {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  async download(url) {
    console.log(`[epg] Загрузка ${url}`);
    this.setState('download', 'Скачивание программы передач', 0);
    await httpClient.download(url, this.rawPath, (done, total) => {
      this.status.progress = total ? Math.floor(done * 100 / total) : 0;
      this.status.message = `Скачивание программы передач: ${(done / 1048576).toFixed(1)} МБ`;
    });
    const downloadedAt = Date.now();
    fs.writeFileSync(this.metaPath, JSON.stringify({ url, downloadedAt }));
    return downloadedAt;
  }

  async build(url, downloadedAt, channels, key) {
    this.setState('parse', 'Обработка программы передач', 0);
    const now = Date.now() / 1000;
    const maxDays = channels.reduce((max, ch) => Math.max(max, ch.catchupDays), 0);
    const from = now - (maxDays + 1) * 86400;
    const to = now + FUTURE_DAYS * 86400;

    const epgChannels = new Map();             // все <channel> из файла
    const programmes = Object.create(null);
    let wanted;                                // id каналов EPG, нужных плейлисту (null — брать все)

    await xmltv.parseFile(this.rawPath, {
      channel: (ch) => {
        if (ch.id) epgChannels.set(ch.id, ch);
      },
      programme: (attrs, inner) => {
        // <channel> в XMLTV идут перед передачами — к первой передаче список каналов уже известен
        if (wanted === undefined) wanted = epgChannels.size ? this.wantedIds(epgChannels, channels) : null;
        const id = attrs.channel;
        if (!id || (wanted && !wanted.has(id))) return;
        const start = xmltv.parseTime(attrs.start);
        if (isNaN(start)) return;
        let stop = xmltv.parseTime(attrs.stop);
        if (isNaN(stop) || stop <= start) stop = start + 3600;
        if (stop < from || start > to) return;
        const list = programmes[id] || (programmes[id] = []);
        list.push([start, stop, xmltv.textOf(inner, 'title') || 'Без названия', xmltv.textOf(inner, 'desc', DESC_MAX)]);
      }
    }, (fraction) => {
      this.status.progress = Math.floor(fraction * 100);
    });

    const ids = Object.keys(programmes);
    if (!epgChannels.size && !ids.length) throw new Error('Файл не похож на программу передач XMLTV');

    const storeChannels = {};
    let count = 0;
    ids.forEach((id) => {
      programmes[id] = dedupe(programmes[id].sort((a, b) => a[0] - b[0]));
      count += programmes[id].length;
      const info = epgChannels.get(id);
      storeChannels[id] = { names: info ? info.names : [], icon: info ? info.icon : '' };
    });

    this.store = {
      version: CACHE_VERSION, url, downloadedAt, builtAt: Date.now(), playlistKey: key,
      count, channels: storeChannels, programmes
    };
    this.bind(channels);
    this.setState('ready', '');
    console.log(`[epg] Готово: ${ids.length} каналов, ${count} передач, сопоставлено с плейлистом: ${this.links.size}`);

    try {
      fs.writeFileSync(`${this.cachePath}.tmp`, JSON.stringify(this.store));
      fs.renameSync(`${this.cachePath}.tmp`, this.cachePath);
    } catch (err) {
      console.warn(`[epg] Не удалось сохранить кэш программы: ${err.message}`);
    }
  }

  wantedIds(epgChannels, channels) {
    const match = createMatcher(Array.from(epgChannels.values(), (c) => [c.id, c.names]));
    const ids = new Set();
    channels.forEach((ch) => {
      const id = match(ch);
      if (id) ids.add(id);
    });
    return ids;
  }

  /** Привязывает каналы плейлиста к каналам EPG. */
  bind(channels) {
    this.links = new Map();
    const s = this.store;
    if (!s) return;
    const match = createMatcher(Object.keys(s.programmes).map((id) => [id, s.channels[id] ? s.channels[id].names : []]));
    channels.forEach((ch) => {
      const id = match(ch);
      if (id) this.links.set(ch.id, id);
    });
  }

  programmesOf(ch) {
    const id = this.links.get(ch.id);
    return id ? this.store.programmes[id] : [];
  }

  /** Передача, которая идёт в момент now (бинарный поиск по отсортированному списку). */
  currentOf(ch, now) {
    const list = this.programmesOf(ch);
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][0] <= now) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found !== -1 && list[found][1] > now ? list[found] : null;
  }

  iconOf(ch) {
    const id = this.links.get(ch.id);
    return id && this.store.channels[id] ? this.store.channels[id].icon : '';
  }
}

module.exports = { EpgManager, DEFAULT_EPG_URL };
