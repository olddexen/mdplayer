'use strict';
/**
 * Сборка программы передач из скачанных XMLTV-файлов: сопоставление каналов плейлиста
 * с каналами EPG и запись компактного кэша (lib/epg-store.js).
 *
 * Работа тяжёлая (сотни тысяч передач), поэтому обычно запускается в отдельном потоке
 * (lib/epg-worker.js): у потока своя память, и его сборка мусора не останавливает
 * сервер, через который идёт видео.
 */
const xmltv = require('./xmltv');
const store = require('./epg-store');

const FUTURE_DAYS = 2;
const DESC_MAX = 300;               // описания обрезаем — экономия места

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

/**
 * Привязывает ещё не привязанные каналы плейлиста к каналам этого источника.
 * Выбор пользователя важнее автоматики.
 * Возвращает Map: id канала EPG → с какого времени хранить передачи (глубина архива привязанных каналов).
 */
function claim(epgChannels, channels, overrides, tag, activeTags, links, now) {
  const wanted = new Map();
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
    if (!id) return;
    // как в программе канала (service.epgPayload): архив, но не меньше суток назад
    const from = now - Math.max(ch.catchupDays || 0, 1) * 86400;
    const prev = wanted.get(id);
    wanted.set(id, prev === undefined ? from : Math.min(prev, from));
    links[ch.id] = `${tag}:${id}`;
  });
  return wanted;
}

/** Убирает дубли передач с одинаковым временем начала (список уже отсортирован). */
function dedupe(list) {
  return list.filter((p, i) => i === 0 || p[0] !== list[i - 1][0]);
}

/**
 * Собирает программу и записывает кэш в dataDir.
 *   job = { dataDir, sources: [{ url, tag, file, downloadedAt }], channels, overrides, key, now? }
 *   onProgress(state, fraction, message)
 * Возвращает { count, channels, matched }.
 */
async function build(job, onProgress) {
  const report = onProgress || (() => {});
  const { sources, channels } = job;
  const overrides = job.overrides || {};
  const now = job.now || Date.now() / 1000;
  const to = now + FUTURE_DAYS * 86400;
  const activeTags = sources.map((src) => src.tag);

  const programmes = Object.create(null);
  const info = {};
  const links = {};
  const iconByKey = {};
  const catalog = [];   // все каналы всех источников — для ручного выбора

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const part = sources.length > 1 ? ` (${i + 1} из ${sources.length})` : '';
    const message = `Обработка программы передач${part}`;
    report('parse', 0, message);
    const epgChannels = new Map();
    let wanted;

    await xmltv.parseFile(src.file, {
      channel: (ch) => {
        if (ch.id) epgChannels.set(ch.id, ch);
      },
      programme: (attrs, inner) => {
        // <channel> в XMLTV идут перед передачами — к первой передаче список каналов уже известен
        if (wanted === undefined) wanted = claim(epgChannels, channels, overrides, src.tag, activeTags, links, now);
        const id = attrs.channel;
        const from = id && wanted.get(id);
        if (from === undefined) return;
        const start = xmltv.parseTime(attrs.start);
        if (isNaN(start)) return;
        let stop = xmltv.parseTime(attrs.stop);
        if (isNaN(stop) || stop <= start) stop = start + 3600;
        if (stop <= from || start > to) return;
        const k = `${src.tag}:${id}`;
        const list = programmes[k] || (programmes[k] = []);
        list.push([start, stop, xmltv.textOf(inner, 'title') || 'Без названия', xmltv.textOf(inner, 'desc', DESC_MAX)]);
      }
    }, (fraction) => report('parse', fraction, message));

    epgChannels.forEach((ch, id) => {
      const k = `${src.tag}:${id}`;
      catalog.push([k, ch.names[0] || id]);
      if (ch.icon) iconByKey[k] = ch.icon;
      if (programmes[k]) info[k] = { names: ch.names, icon: ch.icon };
    });
  }

  if (!catalog.length) throw new Error('Файл не похож на программу передач XMLTV');

  Object.keys(programmes).forEach((k) => {
    programmes[k] = dedupe(programmes[k].sort((a, b) => a[0] - b[0]));
  });
  // логотип из EPG нужен и каналам, у которых программа устарела
  const icons = {};
  Object.keys(links).forEach((chId) => {
    if (iconByKey[links[chId]]) icons[chId] = iconByKey[links[chId]];
    if (!programmes[links[chId]]) delete links[chId];   // канал нашёлся, но передач в окне нет
  });

  report('parse', 1, 'Сохранение программы передач');
  const written = store.write(job.dataDir, {
    key: job.key,
    downloadedAt: Math.min.apply(null, sources.map((src) => src.downloadedAt)),
    sources: sources.map((src) => ({ url: src.url, tag: src.tag })),
    channels: info,
    links,
    icons,
    catalog
  }, programmes);
  return { count: written.count, channels: written.channels, matched: Object.keys(links).length };
}

module.exports = { build, createMatcher, nameKeys, searchKey, claim, dedupe };
