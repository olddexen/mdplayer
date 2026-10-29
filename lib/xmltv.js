'use strict';
/**
 * Потоковый парсер XMLTV без внешних библиотек.
 *
 * Программа передач может весить сотни мегабайт, поэтому файл не читается
 * в память целиком: текст подаётся кусками в feed(), а наружу отдаются
 * только готовые блоки <channel> и <programme>.
 */
const fs = require('fs');
const zlib = require('zlib');

const MAX_ELEMENT = 1024 * 1024;   // незакрытый элемент длиннее 1 МБ считаем битым
const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DISPLAY_NAME_RE = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g;
const ICON_RE = /<icon\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/;
const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const tagPatterns = {};

/**
 * V8 хранит подстроку как ссылку на исходную строку. Без копирования каждое
 * сохранённое название удерживало бы в памяти целый прочитанный кусок XML.
 */
function own(s) {
  return s.length > 12 ? Buffer.from(s, 'utf8').toString('utf8') : s;
}

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (match, entity) => {
    if (entity.charAt(0) !== '#') return ENTITIES[entity.toLowerCase()];
    const hex = entity.charAt(1) === 'x' || entity.charAt(1) === 'X';
    try {
      return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
    } catch (e) {
      return match;
    }
  });
}

function parseAttrs(tag) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    attrs[m[1]] = own(decodeEntities(m[2] !== undefined ? m[2] : m[3]));
  }
  return attrs;
}

/** Текст первого вложенного тега (title, desc…): раскодирован, пробелы схлопнуты, обрезан до maxLen. */
function textOf(xml, tag, maxLen) {
  let re = tagPatterns[tag];
  if (!re) re = tagPatterns[tag] = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(xml);
  if (!m) return '';
  const cdata = CDATA_RE.exec(m[1]);   // внутри CDATA сущности не раскодируются
  let text = (cdata ? cdata[1] : decodeEntities(m[1])).replace(/\s+/g, ' ').trim();
  if (maxLen && text.length > maxLen) text = `${text.slice(0, maxLen).replace(/\s+\S*$/, '')}…`;
  return own(text);
}

/** '20261029180000 +0300' → Unix Timestamp (с). Без часового пояса считается UTC. */
function parseTime(value) {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/.exec(value || '');
  if (!m) return NaN;
  let ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) {
    const offset = (+m[8] * 60 + +m[9]) * 60;
    ts += m[7] === '+' ? -offset : offset;
  }
  return ts;
}

function isNameEnd(code) {
  // пробел, табуляция, перевод строки, '>' или '/'
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 62 || code === 47;
}

class XmltvParser {
  /**
   * handlers.channel({ id, names, icon }) — для каждого <channel>;
   * handlers.programme(attrs, innerXml)   — для каждого <programme>
   *   (title и desc достаются через textOf только для нужных каналов — так быстрее).
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.buf = '';
  }

  feed(text) {
    const buf = this.buf + text;
    let pos = 0;
    for (;;) {
      const lt = buf.indexOf('<', pos);
      if (lt === -1) {
        pos = buf.length;
        break;
      }
      if (buf.length - lt < 11) {          // имя тега ещё не дочитано
        pos = lt;
        break;
      }
      let tag = null;
      if (buf.startsWith('programme', lt + 1) && isNameEnd(buf.charCodeAt(lt + 10))) tag = 'programme';
      else if (buf.startsWith('channel', lt + 1) && isNameEnd(buf.charCodeAt(lt + 8))) tag = 'channel';
      if (!tag) {                          // <?xml, <tv, </tv> и т.п. пропускаем
        pos = lt + 1;
        continue;
      }

      const gt = buf.indexOf('>', lt);
      let end = -1;
      let inner = '';
      if (gt !== -1 && buf.charCodeAt(gt - 1) === 47) {     // <channel id="x"/>
        end = gt + 1;
      } else if (gt !== -1) {
        const close = buf.indexOf(`</${tag}>`, gt);
        if (close !== -1) {
          end = close + tag.length + 3;
          inner = buf.slice(gt + 1, close);
        }
      }
      if (end === -1) {                    // элемент ещё не дочитан
        if (buf.length - lt > MAX_ELEMENT) {
          pos = lt + 1;
          continue;
        }
        pos = lt;
        break;
      }
      this.emit(tag, buf.slice(lt, gt + 1), inner);
      pos = end;
    }
    this.buf = buf.slice(pos);
  }

  emit(tag, openTag, inner) {
    const attrs = parseAttrs(openTag);
    if (tag === 'programme') {
      this.handlers.programme(attrs, inner);
      return;
    }
    const names = [];
    let m;
    DISPLAY_NAME_RE.lastIndex = 0;
    while ((m = DISPLAY_NAME_RE.exec(inner)) !== null) {
      const name = own(decodeEntities(m[1]).trim());
      if (name) names.push(name);
    }
    const icon = ICON_RE.exec(inner);
    this.handlers.channel({ id: attrs.id || '', names, icon: icon ? own(decodeEntities(icon[1])) : '' });
  }

  end() {
    this.buf = '';
  }
}

/** Разбирает XMLTV-файл (обычный или .gz). onProgress(доля 0…1) вызывается по мере чтения. */
function parseFile(filePath, handlers, onProgress) {
  return new Promise((resolve, reject) => {
    let total;
    let gzipped;
    try {
      total = fs.statSync(filePath).size;
      const head = Buffer.alloc(2);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      gzipped = head[0] === 0x1f && head[1] === 0x8b;
    } catch (err) {
      reject(err);
      return;
    }

    const parser = new XmltvParser(handlers);
    const file = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    const source = gzipped ? file.pipe(zlib.createGunzip()) : file;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      file.destroy();
      reject(err);
    };

    file.on('error', (err) => fail(new Error(`Не удалось прочитать файл EPG: ${err.message}`)));
    if (gzipped) source.on('error', (err) => fail(new Error(`Повреждённый архив EPG: ${err.message}`)));
    source.setEncoding('utf8');
    source.on('data', (text) => {
      if (failed) return;
      try {
        parser.feed(text);
      } catch (err) {
        fail(err);
        return;
      }
      if (onProgress && total) onProgress(Math.min(1, file.bytesRead / total));
    });
    source.on('end', () => {
      if (failed) return;
      parser.end();
      resolve();
    });
  });
}

module.exports = { XmltvParser, parseFile, parseTime, textOf, decodeEntities };
