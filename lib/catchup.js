'use strict';
/**
 * Ссылки на архив передач (catchup / timeshift) по правилам OttPlayer / Kodi.
 * Все времена — Unix Timestamp в секундах (UTC).
 *
 * iEdem TV (catchup="shift" или "append" без шаблона, а также просто tvg-rec):
 *   http://host/iptv/TOKEN/106/index.m3u8?utc=НАЧАЛО&lutc=СЕЙЧАС
 */

const DEFAULT_DURATION = 2 * 3600;   // если конец передачи неизвестен
const PLACEHOLDER_RE = /\$?\{(\w+)(?::([^}]+))?\}/g;
const DATE_PARTS = {
  Y: 'getUTCFullYear', m: 'getUTCMonth', d: 'getUTCDate',
  H: 'getUTCHours', M: 'getUTCMinutes', S: 'getUTCSeconds'
};

function userError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function datePart(ts, key) {
  const value = new Date(ts * 1000)[DATE_PARTS[key]]() + (key === 'm' ? 1 : 0);
  return key === 'Y' || value >= 10 ? String(value) : `0${value}`;
}

/** Добавляет параметры к ссылке, не трогая уже имеющиеся (токен и т.п.). */
function appendQuery(url, query) {
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  const tail = hash === -1 ? '' : url.slice(hash);
  const sep = base.indexOf('?') === -1 ? '?' : /[?&]$/.test(base) ? '' : '&';
  return base + sep + query + tail;
}

/**
 * Подставляет значения в шаблон catchup-source:
 *   {utc} {start} ${start}     начало передачи
 *   {utcend} {end} ${end}      конец передачи
 *   {lutc} {now} {timestamp}   текущее время
 *   {duration} {offset}        длительность / сколько секунд прошло с начала;
 *                              {duration:60} — то же в минутах
 *   {Y} {m} {d} {H} {M} {S}    части даты начала (UTC)
 *   {utc:Y-m-d:H-M-S}          дата в произвольном формате
 */
function expandTemplate(template, start, stop, now) {
  const values = {
    utc: start, start, utcend: stop, end: stop,
    lutc: now, now, timestamp: now,
    duration: stop - start, offset: now - start
  };
  return template.replace(PLACEHOLDER_RE, (match, key, format) => {
    if (DATE_PARTS[key]) return datePart(start, key);
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    const value = values[key];
    if (!format) return String(value);
    if (/^\d+$/.test(format)) return String(Math.floor(value / Number(format)));
    return format.replace(/[YmdHMS]/g, (part) => datePart(value, part));
  });
}

/** Flussonic: …/index.m3u8 → …/index-НАЧАЛО-ДЛИТЕЛЬНОСТЬ.m3u8, MPEG-TS → …/timeshift_abs-НАЧАЛО.ts */
function flussonicUrl(url, start, duration) {
  const m = /^([^?#]*\/)([^/?#]*)(.*)$/.exec(url);
  if (!m) return url;
  const file = /\.m3u8$/i.test(m[2])
    ? `${m[2].replace(/\.m3u8$/i, '')}-${start}-${duration}.m3u8`
    : `timeshift_abs-${start}.ts`;
  return m[1] + file + m[3];
}

/**
 * Строит ссылку на запись передачи.
 * channel — канал из m3u.parse(); start / stop — Unix Timestamp передачи.
 * Бросает ошибку со status=400, если архив недоступен.
 */
function buildArchiveUrl(channel, start, stop, now) {
  now = Math.floor(now || Date.now() / 1000);
  start = Math.floor(start);
  stop = Math.floor(stop) || start + DEFAULT_DURATION;

  if (!channel.catchupDays) throw userError(`У канала «${channel.name}» нет архива`);
  if (!(start > 0)) throw userError('Не указано время начала передачи');
  if (start >= now) throw userError('Передача ещё не началась — архива пока нет');
  if (start < now - channel.catchupDays * 86400) {
    throw userError(`Передача старше глубины архива (${channel.catchupDays} дн.)`);
  }
  if (stop <= start) stop = start + DEFAULT_DURATION;

  const mode = channel.catchup || 'shift';

  // 1) Провайдер дал шаблон catchup-source
  if (channel.catchupSource) {
    const expanded = expandTemplate(channel.catchupSource, start, stop, now);
    // catchup="default" и прочие: шаблон и есть полная ссылка
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(expanded) && mode !== 'append') return expanded;
    // catchup="append": шаблон дописывается к ссылке на поток
    if (expanded.charAt(0) === '?' && channel.url.indexOf('?') !== -1) return `${channel.url}&${expanded.slice(1)}`;
    return channel.url + expanded;
  }

  // 2) Шаблона нет — стандартные схемы
  switch (mode) {
    case 'shift':
    case 'append':
    case 'default':
    case 'archive':
      return appendQuery(channel.url, `utc=${start}&lutc=${now}`);          // схема iEdem TV
    case 'timeshift':
      return appendQuery(channel.url, `timeshift=${start}&timenow=${now}`);
    case 'flussonic':
    case 'flussonic-hls':
    case 'flussonic-ts':
    case 'fs':
      return flussonicUrl(channel.url, start, stop - start);
    default:
      throw userError(`Неизвестный тип архива catchup="${channel.catchup}"`);
  }
}

module.exports = { buildArchiveUrl, expandTemplate, appendQuery };
