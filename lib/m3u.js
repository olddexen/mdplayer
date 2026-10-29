'use strict';
/**
 * Парсер расширенного M3U/M3U8 (#EXTM3U / #EXTINF / #EXTGRP).
 *
 * Понимает атрибуты, которые используют iEdem TV (Edem / iLook) и OttPlayer:
 *   заголовок: url-tvg / x-tvg-url (ссылка на EPG), catchup, catchup-days, catchup-source;
 *   канал:     tvg-id, tvg-name, tvg-logo, group-title, catchup, catchup-days,
 *              catchup-source, tvg-rec / timeshift (глубина архива в днях).
 */
const crypto = require('crypto');

const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g;
const DEFAULT_CATCHUP_DAYS = 3;   // архив заявлен, но глубина не указана
const NO_GROUP = 'Без группы';

function parseAttrs(text) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text)) !== null) attrs[m[1].toLowerCase()] = m[2].trim();
  return attrs;
}

/** '#EXTINF:-1 group-title="Кино, сериалы",Имя' → [атрибуты, 'Имя']: запятая в кавычках не разделитель. */
function splitExtinf(line) {
  const body = line.slice('#EXTINF:'.length);
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) return [body.slice(0, i), body.slice(i + 1).trim()];
  }
  return [body, ''];
}

function toDays(value) {
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

/** Стабильный id по названию: не меняется при обновлении плейлиста (на нём держится избранное). */
function makeId(name, used) {
  const base = crypto.createHash('md5').update(name.toLowerCase()).digest('hex').slice(0, 10);
  used[base] = (used[base] || 0) + 1;
  return used[base] === 1 ? base : `${base}-${used[base]}`;
}

function makeChannel(entry, url, extGroup, defaults, usedIds) {
  const a = entry.attrs;
  const name = entry.name || a['tvg-name'] || 'Без названия';
  const catchup = (a.catchup || defaults.catchup).toLowerCase();
  let days = toDays(a['catchup-days'] || a['tvg-rec'] || a.timeshift) || defaults.days;
  if (catchup && !days) days = DEFAULT_CATCHUP_DAYS;
  return {
    id: makeId(name, usedIds),
    name,
    url,
    tvgId: a['tvg-id'] || '',
    tvgName: a['tvg-name'] || '',
    logo: a['tvg-logo'] || a.logo || '',
    group: a['group-title'] || extGroup || NO_GROUP,
    catchup,
    catchupDays: days,
    catchupSource: a['catchup-source'] || defaults.source
  };
}

/** Возвращает { channels, groups, epgUrls }. Бросает ошибку, если текст — не плейлист. */
function parse(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines[0].indexOf('#EXTM3U') !== 0) {
    // частый случай: вместо плейлиста пришла HTML-страница с ошибкой
    throw new Error('Это не M3U-плейлист (нет заголовка #EXTM3U). Проверьте ссылку и ключ доступа');
  }

  const header = parseAttrs(lines[0]);
  const epgUrls = (header['url-tvg'] || header['x-tvg-url'] || '')
    .split(',').map((u) => u.trim()).filter(Boolean);
  const defaults = {
    catchup: header.catchup || '',
    days: toDays(header['catchup-days'] || header['tvg-rec']),
    source: header['catchup-source'] || ''
  };

  const channels = [];
  const usedIds = {};
  let entry = null;    // #EXTINF, который ждёт строку с адресом потока
  let extGroup = '';   // #EXTGRP действует до следующего #EXTGRP

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('#EXTINF:') === 0) {
      const parts = splitExtinf(line);
      entry = { attrs: parseAttrs(parts[0]), name: parts[1] };
    } else if (line.indexOf('#EXTGRP:') === 0) {
      extGroup = line.slice('#EXTGRP:'.length).trim();
    } else if (line.charAt(0) !== '#' && entry) {
      channels.push(makeChannel(entry, line, extGroup, defaults, usedIds));
      entry = null;
    }
    // остальные строки с '#' (#EXTVLCOPT, #KODIPROP…) не нужны
  }

  if (!channels.length) throw new Error('В плейлисте нет ни одного канала');

  const groups = [];
  const seen = Object.create(null);
  channels.forEach((ch) => {
    if (!seen[ch.group]) {
      seen[ch.group] = true;
      groups.push(ch.group);
    }
  });
  return { channels, groups, epgUrls };
}

module.exports = { parse };
