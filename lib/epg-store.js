'use strict';
/**
 * Компактное хранилище программы передач.
 *
 * Раньше программа лежала в epg.json (сотни МБ) и целиком жила в памяти как миллионы
 * маленьких массивов: запуск занимал десятки секунд, а сборщик мусора периодически
 * останавливал сервер (и видео через прокси). Теперь на диске три файла:
 *
 *   epg-v3.json — сведения: источники, привязки каналов, каталог, где лежит каждый канал;
 *   epg-v3-*.idx  — времена начала/конца (Uint32) и названия передач — читается в память;
 *   epg-v3-*.desc — описания передач — читаются с диска, только когда открыта программа канала
 *                 (у каждой сборки свой файл: пока собирается новая, старая читает свой).
 *
 * В памяти: по каналу два Uint32Array и одна строка с названиями (+ смещения в Uint32Array).
 * Для сборщика мусора это несколько тысяч объектов вместо миллионов.
 */
const fs = require('fs');
const path = require('path');

const FORMAT = 3;
const META_FILE = 'epg-v3.json';
const BUILD_RE = /^[0-9a-z]+$/;
const DATA_RE = /^epg-v3-([0-9a-z]+)\.(idx|desc)$/;
const LEGACY_FILES = ['epg.json', 'epg.json.tmp', 'epg-source.raw', 'epg-source.json', 'epg-v3.idx'];

/**
 * У каждой сборки свои файлы данных (epg-v3-<сборка>.idx/.desc), а epg-v3.json указывает на текущую.
 * Если запись оборвётся, сведения и данные разных сборок не перемешаются.
 */
function files(dir, build) {
  return {
    meta: path.join(dir, META_FILE),
    index: path.join(dir, `epg-v3-${build}.idx`),
    desc: path.join(dir, `epg-v3-${build}.desc`)
  };
}

function writeAtomic(file, data) {
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
}

/** Удаляет кэш старого формата (epg.json на сотни МБ). */
function removeLegacy(dir) {
  LEGACY_FILES.forEach((name) => fs.unlink(path.join(dir, name), () => {}));
}

/** Удаляет файлы данных прежних сборок, кроме сборки keep. */
function removeStale(dir, keep) {
  fs.readdir(dir, (err, names) => {
    if (err) return;
    names.forEach((name) => {
      const m = DATA_RE.exec(name);
      if (m && m[1] !== keep) fs.unlink(path.join(dir, name), () => {});
    });
  });
}

/**
 * Записывает программу на диск.
 *   info — { key, downloadedAt, sources, channels, links, catalog }
 *   programmes — { "метка:id": [[начало, конец, название, описание], ...] } (отсортировано по началу)
 * Файл сведений пишется последним: если запись оборвётся, старый кэш останется целым.
 */
function write(dir, info, programmes) {
  const builtAt = Date.now();
  const build = builtAt.toString(36);
  const f = files(dir, build);
  const keys = Object.keys(programmes);
  const blocks = {};
  let count = 0;

  // 1) Числа: на канал n начал + n концов + (n + 1) смещений названий — всё Uint32, выравнивание 4 байта
  let numbersSize = 0;
  keys.forEach((k) => { numbersSize += (programmes[k].length * 3 + 1) * 4; });
  const numbers = new Uint32Array(numbersSize / 4);
  const titleParts = [];
  const descParts = [];
  let numPos = 0;
  let titleBytes = 0;
  let descBytes = 0;

  keys.forEach((k) => {
    const list = programmes[k];
    const n = list.length;
    count += n;
    let chars = 0;
    numbers[numPos + n * 2] = 0;
    for (let i = 0; i < n; i++) {
      numbers[numPos + i] = list[i][0];
      numbers[numPos + n + i] = list[i][1];
      chars += list[i][2].length;
      numbers[numPos + n * 2 + i + 1] = chars;
    }
    const titles = Buffer.from(list.map((p) => p[2]).join(''), 'utf8');
    const descs = Buffer.from(list.map((p) => String(p[3] || '').replace(/[\r\n]+/g, ' ')).join('\n'), 'utf8');
    blocks[k] = [n, numPos * 4, titleBytes, titles.length, descBytes, descs.length];
    titleParts.push(titles);
    descParts.push(descs);
    numPos += n * 3 + 1;
    titleBytes += titles.length;
    descBytes += descs.length;
  });

  const numbersBuf = Buffer.from(numbers.buffer, numbers.byteOffset, numbers.byteLength);
  writeAtomic(f.desc, Buffer.concat(descParts));
  writeAtomic(f.index, Buffer.concat([numbersBuf].concat(titleParts)));
  const meta = Object.assign({ format: FORMAT, builtAt, build, count, numbersSize, blocks }, info);
  writeAtomic(f.meta, JSON.stringify(meta));
  return { count, channels: keys.length };
}

/** Uint32Array поверх Buffer: если смещение не кратно 4, данные копируются. */
function uint32View(buf, byteOffset, length) {
  const abs = buf.byteOffset + byteOffset;
  if (abs % 4 === 0) return new Uint32Array(buf.buffer, abs, length);
  const copy = new Uint8Array(length * 4);
  copy.set(buf.subarray(byteOffset, byteOffset + length * 4));
  return new Uint32Array(copy.buffer);
}

/** Индекс первой передачи с началом > ts (бинарный поиск). */
function upperBound(starts, ts) {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class EpgStore {
  constructor(dir, meta, index) {
    this.descPath = files(dir, meta.build).desc;
    this.meta = meta;
    this.entries = new Map();
    const titlesBase = meta.numbersSize;
    Object.keys(meta.blocks).forEach((k) => {
      const [n, numOff, tOff, tLen, dOff, dLen] = meta.blocks[k];
      this.entries.set(k, {
        n,
        starts: uint32View(index, numOff, n),
        stops: uint32View(index, numOff + n * 4, n),
        offsets: uint32View(index, numOff + n * 8, n + 1),
        titles: index.toString('utf8', titlesBase + tOff, titlesBase + tOff + tLen),
        descOff: dOff,
        descLen: dLen
      });
    });
  }

  get key() { return this.meta.key; }
  get downloadedAt() { return this.meta.downloadedAt; }
  get builtAt() { return this.meta.builtAt; }
  get sources() { return this.meta.sources; }
  get links() { return this.meta.links; }
  get channels() { return this.meta.channels; }
  get catalog() { return this.meta.catalog; }
  get count() { return this.meta.count; }
  get channelCount() { return this.entries.size; }

  size(k) {
    const e = this.entries.get(k);
    return e ? e.n : 0;
  }

  title(e, i) {
    return e.titles.slice(e.offsets[i], e.offsets[i + 1]);
  }

  /** Передача, идущая в момент now: [начало, конец, название] или null. */
  current(k, now) {
    const e = this.entries.get(k);
    if (!e) return null;
    const i = upperBound(e.starts, now) - 1;
    return i >= 0 && e.stops[i] > now ? [e.starts[i], e.stops[i], this.title(e, i)] : null;
  }

  /** Передачи, которые заканчиваются позже from: [[начало, конец, название], ...] и индекс первой. */
  range(k, from) {
    const e = this.entries.get(k);
    if (!e) return { first: 0, items: [] };
    let first = 0;
    while (first < e.n && e.stops[first] <= from) first++;
    const items = [];
    for (let i = first; i < e.n; i++) items.push([e.starts[i], e.stops[i], this.title(e, i)]);
    return { first, items };
  }

  /** Описания передач канала (с диска). */
  async descriptions(k) {
    const e = this.entries.get(k);
    if (!e || !e.descLen) return [];
    const handle = await fs.promises.open(this.descPath, 'r');
    try {
      const buf = Buffer.alloc(e.descLen);
      await handle.read(buf, 0, e.descLen, e.descOff);
      return buf.toString('utf8').split('\n');
    } finally {
      await handle.close();
    }
  }

  /** Передачи с описаниями: [[начало, конец, название, описание], ...]. */
  async programmes(k, from) {
    const { first, items } = this.range(k, from);
    if (!items.length) return items;
    let descs = [];
    try {
      descs = await this.descriptions(k);
    } catch (err) {
      // без описаний программа всё равно полезна
    }
    return items.map((p, i) => p.concat(descs[first + i] || ''));
  }
}

/** Читает кэш программы (асинхронно — сервер в это время отвечает). null — кэша нет или он повреждён. */
async function read(dir) {
  let meta;
  try {
    meta = JSON.parse(await fs.promises.readFile(path.join(dir, META_FILE), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[epg] Кэш программы повреждён и будет пересоздан: ${err.message}`);
    return null;
  }
  if (!meta || meta.format !== FORMAT || !meta.blocks || !BUILD_RE.test(meta.build || '')) return null;
  const f = files(dir, meta.build);
  try {
    const index = await fs.promises.readFile(f.index);
    const desc = await fs.promises.stat(f.desc);
    if (!desc.isFile()) return null;
    return new EpgStore(dir, meta, index);
  } catch (err) {
    console.warn(`[epg] Кэш программы не читается и будет пересоздан: ${err.message}`);
    return null;
  }
}

module.exports = { write, read, removeLegacy, removeStale, EpgStore, FORMAT };
