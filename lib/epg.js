'use strict';
/**
 * Программа передач (EPG, формат XMLTV) из одного или нескольких источников.
 *
 * - Источники: из настроек, из url-tvg / x-tvg-url плейлиста и запасной для iEdem.
 *   Каждый канал плейлиста берёт программу из первого источника, где он нашёлся.
 * - Файлы (обычно .xml.gz) скачиваются в data/epg-<метка>.raw (с докачкой при обрыве).
 * - Сборка (разбор XML и сопоставление каналов) идёт в отдельном потоке — сервер и видео не тормозят.
 * - Результат — компактный кэш (lib/epg-store.js): после перезапуска программа доступна за секунды.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const httpClient = require('./http-client');
const store = require('./epg-store');
const { build, searchKey } = require('./epg-build');

// Запасной источник для iEdem; MDPLAYER_FALLBACK_EPG="" отключает его, другая ссылка — заменяет.
const DEFAULT_EPG_URL = process.env.MDPLAYER_FALLBACK_EPG !== undefined
  ? process.env.MDPLAYER_FALLBACK_EPG
  : 'http://epg.it999.ru/edem.xml.gz';
const EPG_TTL = 12 * 3600 * 1000;   // как часто скачивать EPG заново
const MIN_SPEED = 10 * 1024;        // источник медленнее 10 КБ/с (в среднем за 45 с) бросаем
const WORKER_FILE = path.join(__dirname, 'epg-worker.js');

function tagOf(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 6);
}

function hostOf(url) {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url || '');
  return m ? m[1] : url;
}

/** Отпечаток входных данных: изменились каналы, выбор пользователя или источники — EPG пересобирается. */
function storeKey(channels, overrides, urls) {
  const hash = crypto.createHash('md5');
  channels.forEach((ch) => hash.update(`${ch.id}|${ch.tvgId}|${ch.tvgName}|${ch.name}|${ch.catchupDays}\n`));
  hash.update(JSON.stringify(overrides || {}));
  hash.update(urls.join('\n'));
  return hash.digest('hex');
}

/** Только то, что нужно для сопоставления — в поток уходит копия. */
function slimChannels(channels) {
  return channels.map((ch) => ({ id: ch.id, tvgId: ch.tvgId, tvgName: ch.tvgName, name: ch.name, catchupDays: ch.catchupDays }));
}

/**
 * Запускает сборку в отдельном потоке. Если потоки недоступны — в основном
 * (так было в версии 1.1: медленнее для сервера, но работает).
 */
function runBuild(job, onProgress) {
  let Worker;
  try {
    ({ Worker } = require('worker_threads'));
  } catch (e) {
    Worker = null;
  }
  if (!Worker || process.env.MDPLAYER_EPG_INLINE) return build(job, onProgress);

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_FILE, { workerData: job });
    } catch (err) {
      console.warn(`[epg] Отдельный поток недоступен (${err.message}), сборка в основном`);
      build(job, onProgress).then(resolve, reject);
      return;
    }
    let settled = false;
    let heard = false;   // поток прислал хоть одно сообщение — значит, он запустился
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err && !heard) {
        // поток не смог запуститься (бывает на урезанных сборках Node) — собираем в основном
        console.warn(`[epg] Отдельный поток не запустился (${err.message}), сборка в основном`);
        build(job, onProgress).then(resolve, reject);
      } else if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };
    worker.on('message', (msg) => {
      heard = true;
      if (msg.type === 'progress') onProgress(msg.state, msg.fraction, msg.message);
      else if (msg.type === 'done') finish(null, msg.result);
      else if (msg.type === 'error') finish(new Error(msg.message));
    });
    worker.on('error', (err) => finish(err));
    worker.on('exit', (code) => finish(new Error(`поток сборки программы завершился (код ${code})`)));
  });
}

class EpgManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.metaPath = path.join(dataDir, 'epg-sources.json');
    this.store = null;        // EpgStore — готовая программа
    this.task = null;         // текущее обновление (Promise)
    this.pending = null;      // запрос, пришедший во время обновления
    this.cacheLoad = null;    // чтение кэша при запуске (Promise)
    this.status = { state: 'empty', message: '', progress: 0, error: '' };
    store.removeLegacy(dataDir);
  }

  /** Подхватывает программу, сохранённую при прошлом запуске (асинхронно: сервер в это время отвечает). */
  loadCache() {
    if (!this.cacheLoad) this.cacheLoad = this.readCache();
    return this.cacheLoad;
  }

  async readCache() {
    this.setState('load', 'Загрузка программы передач');
    const started = Date.now();
    const loaded = await store.read(this.dataDir);
    if (loaded) {
      this.store = loaded;
      store.removeStale(this.dataDir, loaded.meta.build);
      console.log(`[epg] Кэш программы загружен за ${Date.now() - started} мс: передач ${loaded.count}`);
    }
    if (this.status.state === 'load') this.setState(loaded ? 'ready' : 'empty', '');
  }

  setState(state, message, progress) {
    this.status.state = state;
    this.status.message = message || '';
    this.status.progress = progress || 0;
  }

  isBusy() {
    return this.status.state === 'download' || this.status.state === 'parse' || this.status.state === 'load';
  }

  publicStatus() {
    const s = this.store;
    return {
      state: this.status.state,
      message: this.status.message,
      progress: this.status.progress,
      error: this.status.error,
      url: s ? s.sources.map((src) => src.url).join(', ') : '',
      updatedAt: s ? s.downloadedAt : 0,
      builtAt: s ? s.builtAt : 0,
      channels: s ? s.channelCount : 0,
      programmes: s ? s.count : 0,
      matched: s ? Object.keys(s.links).length : 0
    };
  }

  /**
   * Обновляет EPG, если нужно: скачивает заново (раз в 12 часов или force),
   * либо только пересобирает из уже скачанных файлов (изменился плейлист или выбор пользователя).
   * Никогда не отклоняется: ошибка попадает в status.
   */
  update(urls, channels, overrides, force) {
    if (this.task) {
      this.pending = { urls, channels, overrides, force: force || !!(this.pending && this.pending.force) };
      return this.task;
    }
    const key = storeKey(channels, overrides, urls);
    const s = this.store;
    if (!force && s && s.key === key && Date.now() - s.downloadedAt < EPG_TTL) return Promise.resolve();

    this.task = this.run(urls, channels, overrides || {}, key, force)
      .catch((err) => {
        this.status.error = err.message;
        this.setState(this.store ? 'ready' : 'error', `Не удалось обновить программу: ${err.message}`);
        console.error(`[epg] ${err.message}`);
      })
      .then(() => {
        this.task = null;
        const next = this.pending;
        this.pending = null;
        if (next) this.update(next.urls, next.channels, next.overrides, next.force);
      });
    return this.task;
  }

  /**
   * Источники качаются параллельно: медленный или недоступный источник не задерживает остальные
   * (в версии 1.1 один «капающий» источник оставлял приставку без программы).
   */
  async run(urls, channels, overrides, key, force) {
    // сборка не должна пересечься с чтением кэша при запуске (оно удаляет файлы чужих сборок)
    if (this.cacheLoad) await this.cacheLoad.catch(() => {});
    const meta = this.readMeta();
    const errors = [];
    const progress = urls.map(() => [0, 0]);
    const results = await Promise.all(urls.map(async (url, i) => {
      const tag = tagOf(url);
      const file = path.join(this.dataDir, `epg-${tag}.raw`);
      const info = meta[url];
      const fresh = info && Date.now() - info.downloadedAt < EPG_TTL && fs.existsSync(file);
      try {
        if (force || !fresh) {
          meta[url] = { downloadedAt: await this.download(url, file, (done, size) => {
            progress[i] = [done, size];
            this.showDownload(progress);
          }) };
          this.writeMeta(meta);
        }
        return { url, tag, file, downloadedAt: meta[url].downloadedAt };
      } catch (err) {
        errors.push(`${hostOf(url)}: ${err.message}`);
        // старая копия лучше, чем ничего
        return info && fs.existsSync(file) ? { url, tag, file, downloadedAt: info.downloadedAt } : null;
      }
    }));
    const sources = results.filter(Boolean);   // порядок источников сохраняется — он важен для привязки
    if (!sources.length) throw new Error(errors.join('; '));

    const started = Date.now();
    const result = await runBuild({
      dataDir: this.dataDir,
      sources,
      channels: slimChannels(channels),
      overrides,
      key
    }, (state, fraction, message) => this.setState(state, message, Math.floor(fraction * 100)));

    const loaded = await store.read(this.dataDir);
    if (!loaded) throw new Error('Не удалось прочитать собранную программу');
    this.store = loaded;
    store.removeStale(this.dataDir, loaded.meta.build);
    this.status.error = errors.length ? `не загрузился источник ${errors.join('; ')}` : '';
    this.setState('ready', '');
    console.log(`[epg] Готово за ${Math.round((Date.now() - started) / 1000)} с: источников ${sources.length}, ` +
      `передач ${result.count}, каналов с программой: ${result.matched} из ${channels.length}`);
  }

  readMeta() {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  writeMeta(meta) {
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify(meta));
    } catch (err) {
      console.warn(`[epg] Не удалось сохранить сведения об источниках: ${err.message}`);
    }
  }

  async download(url, file, onProgress) {
    console.log(`[epg] Загрузка ${url}`);
    if (this.status.state !== 'download') this.setState('download', 'Скачивание программы передач', 0);
    await httpClient.download(url, file, onProgress, { minSpeed: MIN_SPEED, timeout: 30000 });
    return Date.now();
  }

  /** Общий ход загрузки всех источников: «Скачивание программы передач: 12.3 МБ». */
  showDownload(progress) {
    let done = 0;
    let size = 0;
    progress.forEach(([d, s]) => {
      done += d;
      size += s || d;
    });
    this.status.progress = size ? Math.floor(done * 100 / size) : 0;
    this.status.message = `Скачивание программы передач: ${(done / 1048576).toFixed(1)} МБ`;
  }

  linkOf(ch) {
    return this.store && Object.prototype.hasOwnProperty.call(this.store.links, ch.id) ? this.store.links[ch.id] : null;
  }

  hasProgrammes(ch) {
    const k = this.linkOf(ch);
    return !!k && this.store.size(k) > 0;
  }

  /** Передачи канала, заканчивающиеся позже from, с описаниями: [[начало, конец, название, описание], ...]. */
  programmesOf(ch, from) {
    const k = this.linkOf(ch);
    return k ? this.store.programmes(k, from || 0) : Promise.resolve([]);
  }

  /** Передача, которая идёт в момент now: [начало, конец, название] или null. */
  currentOf(ch, now) {
    const k = this.linkOf(ch);
    return k ? this.store.current(k, now) : null;
  }

  iconOf(ch) {
    const icons = this.store && this.store.meta.icons;
    return (icons && icons[ch.id]) || '';
  }

  /** «Первый канал (epg.it999.ru)» — откуда взята программа канала. */
  describe(key) {
    if (!key || !this.store) return '';
    const tag = key.split(':')[0];
    const src = this.store.sources.filter((s) => s.tag === tag)[0];
    const item = this.store.catalog.filter((c) => c[0] === key)[0];
    return `${item ? item[1] : key.slice(tag.length + 1)}${src ? ` (${hostOf(src.url)})` : ''}`;
  }

  /** Поиск по всем каналам всех источников EPG — для ручного выбора. */
  search(query, limit) {
    const s = this.store;
    const needle = searchKey(query);
    if (!s || !needle) return [];
    const hosts = {};
    s.sources.forEach((src) => { hosts[src.tag] = hostOf(src.url); });
    const starts = [];
    const contains = [];
    s.catalog.forEach(([key, name]) => {
      const pos = searchKey(name).indexOf(needle);
      if (pos === -1) return;
      const item = { key, name, source: hosts[key.split(':')[0]] || '' };
      (pos === 0 ? starts : contains).push(item);
    });
    return starts.concat(contains).slice(0, limit);
  }
}

module.exports = { EpgManager, DEFAULT_EPG_URL, storeKey, tagOf };
