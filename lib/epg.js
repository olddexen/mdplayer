'use strict';
/**
 * Программа передач (EPG, формат XMLTV) из одного или нескольких источников.
 *
 * - Источники: из настроек, из url-tvg / x-tvg-url плейлиста и запасной для iEdem.
 *   Каждый канал плейлиста берёт программу из первого источника, где он нашёлся.
 * - Файлы (обычно .xml.gz) скачиваются в data/epg-<метка>.raw и разбираются потоково.
 * - В память попадают только нужные плейлисту каналы и передачи в окне
 *   «глубина архива + 1 день назад … 2 дня вперёд» — бережём память телефона.
 * - Сопоставление: tvg-id, затем название (с учётом латиницы/кириллицы, HD, «канал», «TV»),
 *   а если автоматика ошиблась — выбор пользователя (config.epgMap).
 * - Результат кэшируется в data/epg.json: после перезапуска программа доступна сразу.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const httpClient = require('./http-client');
const xmltv = require('./xmltv');

// Запасной источник для iEdem; MDPLAYER_FALLBACK_EPG="" отключает его, другая ссылка — заменяет.
const DEFAULT_EPG_URL = process.env.MDPLAYER_FALLBACK_EPG !== undefined
  ? process.env.MDPLAYER_FALLBACK_EPG
  : 'http://epg.it999.ru/edem.xml.gz';
const EPG_TTL = 12 * 3600 * 1000;   // как часто скачивать EPG заново
const FUTURE_DAYS = 2;
const DESC_MAX = 300;               // описания обрезаем — экономия памяти
const CACHE_VERSION = 2;
const LEGACY_FILES = ['epg-source.raw', 'epg-source.json'];   // файлы версии 1.0

// Буквы, одинаковые на вид в кириллице и латинице: «СТС» и «CTC» должны совпасть.
const HOMOGLYPHS = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' };
const QUALITY_RE = /(hd|fhd|uhd|sd|4k|orig|original|hevc)+$/;
const STOP_WORDS = ['канал', 'телеканал', 'тв', 'tv', 'channel', 'hd', 'fhd', 'uhd', 'sd', '4k', 'orig', 'original', 'hevc'];

function toLatin(s) {
  return s.replace(/[авекмнорстух]/g, (c) => HOMOGLYPHS[c]);
}

function lowerName(name) {
  return String(name || '').toLowerCase().replace(/ё/g, 'е');
}

/**
 * Ключи названия от строгого к мягкому: точное, без пометок качества, без слов «канал», «TV», «HD».
 * Похожие буквы кириллицы заменяются латиницей, чтобы «СТС» и «CTC» совпадали.
 */
function nameKeys(name) {
  const lower = lowerName(name);
  const exact = toLatin(lower.replace(/[^0-9a-zа-я]+/g, ''));
  if (!exact) return [];
  const loose = exact.replace(QUALITY_RE, '');
  const core = toLatin(lower.split(/[^0-9a-zа-я]+/).filter((w) => w && STOP_WORDS.indexOf(w) === -1).join(''));
  return [exact, loose, core];
}

/** Ключ для поиска в каталоге каналов EPG. */
function searchKey(text) {
  return toLatin(lowerName(text).replace(/[^0-9a-zа-я]+/g, ''));
}

/**
 * Сопоставитель «канал плейлиста → id канала в EPG».
 * entries — массив пар [epgId, [display-name, ...]].
 * На самом мягком уровне (без «канал», «TV», HD) совпадение засчитывается, только если оно однозначно.
 */
function createMatcher(entries) {
  const byId = new Map();
  const levels = [new Map(), new Map(), new Map()];
  const AMBIGUOUS = '';

  entries.forEach(([id, names]) => {
    byId.set(id.toLowerCase(), id);
    const all = /^\d+$/.test(id) ? names : names.concat(id);   // числовой id — не название
    all.forEach((name) => {
      nameKeys(name).forEach((key, level) => {
        if (!key) return;
        const map = levels[level];
        const prev = map.get(key);
        if (prev === undefined) map.set(key, id);
        else if (level === 2 && prev !== id) map.set(key, AMBIGUOUS);
      });
    });
  });

  return (ch) => {
    const direct = ch.tvgId && byId.get(ch.tvgId.toLowerCase());
    if (direct) return direct;
    const keys = [ch.tvgId, ch.tvgName, ch.name].filter(Boolean).map(nameKeys);
    for (let level = 0; level < levels.length; level++) {
      for (const k of keys) {
        const id = k[level] && levels[level].get(k[level]);
        if (id) return id;   // AMBIGUOUS = '' тоже отбрасывается
      }
    }
    return null;
  };
}

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

/** Убирает дубли передач с одинаковым временем начала (список уже отсортирован). */
function dedupe(list) {
  return list.filter((p, i) => i === 0 || p[0] !== list[i - 1][0]);
}

class EpgManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.metaPath = path.join(dataDir, 'epg-sources.json');
    this.cachePath = path.join(dataDir, 'epg.json');
    // store.programmes: { "метка:id": [[start, stop, title, desc], ...] }, отсортировано по start
    // store.links: { id канала плейлиста: "метка:id" }
    this.store = null;
    this.task = null;         // текущее обновление (Promise)
    this.pending = null;      // запрос, пришедший во время обновления
    this.status = { state: 'empty', message: '', progress: 0, error: '' };
    LEGACY_FILES.forEach((name) => fs.unlink(path.join(dataDir, name), () => {}));
  }

  /** Подхватывает программу, сохранённую при прошлом запуске. */
  loadCache() {
    try {
      const store = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (store.version === CACHE_VERSION && store.programmes && store.links) {
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
      url: s ? s.sources.map((src) => src.url).join(', ') : '',
      updatedAt: s ? s.downloadedAt : 0,
      channels: s ? Object.keys(s.programmes).length : 0,
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
      this.pending = { urls, channels, overrides };
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
        if (next) this.update(next.urls, next.channels, next.overrides, false);
      });
    return this.task;
  }

  async run(urls, channels, overrides, key, force) {
    const meta = this.readMeta();
    const sources = [];
    const errors = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const tag = tagOf(url);
      const file = path.join(this.dataDir, `epg-${tag}.raw`);
      const info = meta[url];
      const fresh = info && Date.now() - info.downloadedAt < EPG_TTL && fs.existsSync(file);
      try {
        if (force || !fresh) {
          meta[url] = { downloadedAt: await this.download(url, file, i, urls.length) };
          this.writeMeta(meta);
        }
        sources.push({ url, tag, file, downloadedAt: meta[url].downloadedAt });
      } catch (err) {
        errors.push(`${hostOf(url)}: ${err.message}`);
        // старая копия лучше, чем ничего
        if (info && fs.existsSync(file)) sources.push({ url, tag, file, downloadedAt: info.downloadedAt });
      }
    }
    if (!sources.length) throw new Error(errors.join('; '));
    await this.build(sources, channels, overrides, key);
    this.status.error = errors.length ? `не загрузился источник ${errors.join('; ')}` : '';
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

  async download(url, file, index, total) {
    const part = total > 1 ? ` (${index + 1} из ${total})` : '';
    console.log(`[epg] Загрузка ${url}`);
    this.setState('download', `Скачивание программы передач${part}`, 0);
    await httpClient.download(url, file, (done, size) => {
      this.status.progress = size ? Math.floor(done * 100 / size) : 0;
      this.status.message = `Скачивание программы передач${part}: ${(done / 1048576).toFixed(1)} МБ`;
    });
    return Date.now();
  }

  async build(sources, channels, overrides, key) {
    const now = Date.now() / 1000;
    const maxDays = channels.reduce((max, ch) => Math.max(max, ch.catchupDays), 0);
    const from = now - (maxDays + 1) * 86400;
    const to = now + FUTURE_DAYS * 86400;
    const activeTags = sources.map((src) => src.tag);

    const programmes = Object.create(null);
    const info = {};
    const links = {};
    const catalog = [];   // все каналы всех источников — для ручного выбора

    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const part = sources.length > 1 ? ` (${i + 1} из ${sources.length})` : '';
      this.setState('parse', `Обработка программы передач${part}`, 0);
      const epgChannels = new Map();
      let wanted;

      await xmltv.parseFile(src.file, {
        channel: (ch) => {
          if (ch.id) epgChannels.set(ch.id, ch);
        },
        programme: (attrs, inner) => {
          // <channel> в XMLTV идут перед передачами — к первой передаче список каналов уже известен
          if (wanted === undefined) wanted = this.claim(epgChannels, channels, overrides, src.tag, activeTags, links);
          const id = attrs.channel;
          if (!id || !wanted.has(id)) return;
          const start = xmltv.parseTime(attrs.start);
          if (isNaN(start)) return;
          let stop = xmltv.parseTime(attrs.stop);
          if (isNaN(stop) || stop <= start) stop = start + 3600;
          if (stop < from || start > to) return;
          const k = `${src.tag}:${id}`;
          const list = programmes[k] || (programmes[k] = []);
          list.push([start, stop, xmltv.textOf(inner, 'title') || 'Без названия', xmltv.textOf(inner, 'desc', DESC_MAX)]);
        }
      }, (fraction) => {
        this.status.progress = Math.floor(fraction * 100);
      });

      epgChannels.forEach((ch, id) => {
        const k = `${src.tag}:${id}`;
        catalog.push([k, ch.names[0] || id]);
        if (programmes[k]) info[k] = { names: ch.names, icon: ch.icon };
      });
    }

    if (!catalog.length) throw new Error('Файл не похож на программу передач XMLTV');

    let count = 0;
    Object.keys(programmes).forEach((k) => {
      programmes[k] = dedupe(programmes[k].sort((a, b) => a[0] - b[0]));
      count += programmes[k].length;
    });
    Object.keys(links).forEach((chId) => {
      if (!programmes[links[chId]]) delete links[chId];   // канал нашёлся, но передач в окне нет
    });

    this.store = {
      version: CACHE_VERSION,
      key,
      downloadedAt: Math.min.apply(null, sources.map((src) => src.downloadedAt)),
      builtAt: Date.now(),
      sources: sources.map((src) => ({ url: src.url, tag: src.tag })),
      count,
      channels: info,
      programmes,
      links,
      catalog
    };
    this.setState('ready', '');
    console.log(`[epg] Готово: источников ${sources.length}, передач ${count}, каналов с программой: ${Object.keys(links).length} из ${channels.length}`);

    try {
      fs.writeFileSync(`${this.cachePath}.tmp`, JSON.stringify(this.store));
      fs.renameSync(`${this.cachePath}.tmp`, this.cachePath);
    } catch (err) {
      console.warn(`[epg] Не удалось сохранить кэш программы: ${err.message}`);
    }
  }

  /**
   * Привязывает ещё не привязанные каналы плейлиста к каналам этого источника.
   * Выбор пользователя важнее автоматики. Возвращает Set id каналов EPG, чьи передачи нужно сохранить.
   */
  claim(epgChannels, channels, overrides, tag, activeTags, links) {
    const wanted = new Set();
    const match = createMatcher(Array.from(epgChannels.values(), (c) => [c.id, c.names]));
    channels.forEach((ch) => {
      if (links[ch.id]) return;
      const manual = overrides[ch.id];
      let id = null;
      if (manual && activeTags.indexOf(manual.split(':')[0]) !== -1) {
        const sep = manual.indexOf(':');
        if (manual.slice(0, sep) !== tag) return;   // выбран канал другого источника
        id = epgChannels.has(manual.slice(sep + 1)) ? manual.slice(sep + 1) : null;
      } else {
        id = match(ch);
      }
      if (id) {
        wanted.add(id);
        links[ch.id] = `${tag}:${id}`;
      }
    });
    return wanted;
  }

  linkOf(ch) {
    return this.store && Object.prototype.hasOwnProperty.call(this.store.links, ch.id) ? this.store.links[ch.id] : null;
  }

  programmesOf(ch) {
    const k = this.linkOf(ch);
    return (k && this.store.programmes[k]) || [];
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
    const k = this.linkOf(ch);
    const i = k && this.store.channels[k];
    return i ? i.icon : '';
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

module.exports = { EpgManager, DEFAULT_EPG_URL };
