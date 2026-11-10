'use strict';
/**
 * Небольшой HTTP-клиент на встроенных модулях http/https:
 * постоянные соединения (keep-alive), редиректы, таймауты, распаковка gzip,
 * докачка больших файлов и понятные сообщения об ошибках.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Linux; Android 8.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0 Mobile Safari/537.36';
const REDIRECTS = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;
const DOWNLOAD_ATTEMPTS = 4;       // большие файлы (EPG) докачиваются после обрыва
const RESET_CODES = ['ECONNRESET', 'EPIPE', 'ECONNABORTED'];
const RETRYABLE = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED', 'INCOMPLETE'];

/**
 * Постоянные соединения: плейлист потока перечитывается каждые несколько секунд,
 * сегменты идут один за другим — без keep-alive каждый запрос заново открывал TCP-соединение.
 */
const AGENT_OPTIONS = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 8, timeout: 60000, scheduling: 'lifo' };
const agents = { 'http:': new http.Agent(AGENT_OPTIONS), 'https:': new https.Agent(AGENT_OPTIONS) };

let userAgent = DEFAULT_USER_AGENT;

function setUserAgent(value) {
  userAgent = value || DEFAULT_USER_AGENT;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return url;
  }
}

function httpError(status, url) {
  let message = `Сервер ${hostOf(url)} ответил ошибкой HTTP ${status}`;
  if (status === 401 || status === 403) message = `Доступ запрещён (HTTP ${status}). Проверьте ключ в ссылке и оплату подписки`;
  if (status === 404) message = `Не найдено (HTTP 404) на ${hostOf(url)}. Проверьте ссылку`;
  const err = new Error(message);
  err.status = status;
  return err;
}

function networkError(err, url) {
  const host = hostOf(url);
  const messages = {
    ENOTFOUND: `Сервер ${host} не найден (нет интернета или неверный адрес)`,
    EAI_AGAIN: `Не удалось найти ${host}: проблема с DNS или интернетом`,
    ECONNREFUSED: `Сервер ${host} отклонил соединение`,
    ECONNRESET: `Соединение с ${host} разорвано`,
    ETIMEDOUT: `Сервер ${host} не отвечает`,
    CERT_HAS_EXPIRED: `У сервера ${host} просрочен SSL-сертификат`
  };
  const wrapped = new Error(messages[err.code] || err.message);
  wrapped.code = err.code;
  return wrapped;
}

/**
 * Открывает GET-запрос, проходя по редиректам.
 * Возвращает Promise<{ res, req, url }>, где url — адрес после редиректов.
 *   opts.headers   — дополнительные заголовки
 *   opts.timeout   — сколько мс ждать данных (простой сокета)
 *   opts.anyStatus — не считать ответы 4xx/5xx ошибкой (нужно прокси)
 *   opts.onRequest — получает текущий http.ClientRequest, чтобы его можно было прервать
 */
function open(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let resent = false;

    const request = (current) => {
      let target;
      try {
        target = new URL(current);
      } catch (e) {
        reject(new Error(`Некорректная ссылка: ${current}`));
        return;
      }
      const lib = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
      if (!lib) {
        reject(new Error('Поддерживаются только ссылки http:// и https://'));
        return;
      }

      const req = lib.request({
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: target.pathname + target.search,
        method: 'GET',
        agent: agents[target.protocol],
        headers: Object.assign({ 'User-Agent': userAgent, Accept: '*/*' }, opts.headers)
      }, (res) => {
        const location = res.headers.location;
        if (REDIRECTS.indexOf(res.statusCode) !== -1 && location) {
          res.resume();
          if (++redirects > MAX_REDIRECTS) {
            reject(new Error('Слишком много перенаправлений'));
            return;
          }
          let next;
          try {
            next = new URL(location, current).href;
          } catch (e) {
            reject(new Error(`Некорректное перенаправление: ${location}`));
            return;
          }
          request(next);
          return;
        }
        if (!opts.anyStatus && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(httpError(res.statusCode, current));
          return;
        }
        resolve({ res, req, url: current });
      });

      if (opts.onRequest) opts.onRequest(req);
      req.setTimeout(opts.timeout || 20000, () => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      });
      req.on('error', (err) => {
        // сервер закрыл простаивавшее соединение как раз тогда, когда мы его взяли — повторяем на новом
        // (только если ответа ещё не было: обрыв посреди тела — обычная ошибка для читающего)
        if (req.reusedSocket && !req.res && !resent && RESET_CODES.indexOf(err.code) !== -1) {
          resent = true;
          request(current);
          return;
        }
        reject(networkError(err, current));
      });
      req.end();
    };

    request(url);
  });
}

/** Читает поток целиком в Buffer, но не больше limit байт. */
function readAll(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        finish(new Error('Слишком большой ответ сервера'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(null, Buffer.concat(chunks)));
    stream.on('aborted', () => finish(new Error('Соединение прервано')));
    stream.on('error', (err) => finish(err));
    stream.on('close', () => finish(new Error('Соединение прервано')));
  });
}

/** Снимает сжатие: по заголовку Content-Encoding и/или по сигнатуре gzip (файлы .gz). */
function decompress(buf, encoding) {
  try {
    let out = buf;
    if (/gzip/i.test(encoding || '')) out = zlib.gunzipSync(out);
    else if (/deflate/i.test(encoding || '')) out = zlib.inflateSync(out);
    if (out[0] === 0x1f && out[1] === 0x8b) out = zlib.gunzipSync(out);
    return out;
  } catch (err) {
    throw new Error(`Повреждённые сжатые данные: ${err.message}`);
  }
}

/** Скачивает текст (плейлист, библиотеку и т.п.). Возвращает Promise<{ text, url }>. */
async function fetchText(url, opts = {}) {
  const { res, url: finalUrl } = await open(url, opts);
  const raw = await readAll(res, opts.maxBytes || 50 * 1024 * 1024);
  const text = decompress(raw, res.headers['content-encoding']).toString('utf8').replace(/^﻿/, '');
  return { text, url: finalUrl };
}

function incomplete(message) {
  return Object.assign(new Error(message), { code: 'INCOMPLETE' });
}

/** Полный размер файла из ответа: Content-Range «bytes 100-999/1000» или Content-Length. */
function totalSize(res, offset) {
  const range = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
  if (range) return parseInt(range[1], 10);
  const length = parseInt(res.headers['content-length'], 10);
  return length ? length + offset : 0;
}

/**
 * Пишет ответ в файл (дописывая, если append). onData(байт) — по мере получения.
 * minSpeed (байт/с): если за окно speedWindow мс пришло меньше — загрузка обрывается (код SLOW):
 * иначе источник, который «капает» по килобайту, держал бы загрузку часами.
 */
function saveBody(res, file, append, onData, minSpeed, speedWindow) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { flags: append ? 'a' : 'w' });
    let settled = false;
    let windowBytes = 0;
    let speedTimer = null;
    // При ошибке ждём, пока файл закроется: докачка начнётся с его настоящего размера (см. download)
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(speedTimer);
      res.unpipe(out);
      res.destroy();
      out.end();
      out.once('close', () => reject(err));
      out.once('error', () => reject(err));
    };
    if (minSpeed) {
      speedTimer = setInterval(() => {
        const speed = windowBytes * 1000 / speedWindow;
        windowBytes = 0;
        if (speed < minSpeed) {
          fail(Object.assign(new Error(`слишком медленная загрузка (${(speed / 1024).toFixed(1)} КБ/с)`), { code: 'SLOW' }));
        }
      }, speedWindow);
    }
    res.on('data', (chunk) => {
      windowBytes += chunk.length;
      onData(chunk.length);
    });
    res.on('aborted', () => fail(incomplete('Загрузка прервана')));
    res.on('error', (err) => fail(err.code ? err : incomplete(err.message)));
    out.on('error', (err) => fail(new Error(`Не удалось записать файл: ${err.message}`)));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      clearInterval(speedTimer);
      resolve();
    });
    res.pipe(out);
  });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Скачивает файл на диск: сначала во временный *.part, потом переименовывает,
 * чтобы оборванная загрузка не испортила предыдущую копию.
 * При обрыве связи докачивает с места остановки (Range), если сервер это умеет.
 * onProgress(получено, всего) — всего = 0, если сервер не сообщил размер.
 *   opts.minSpeed, opts.speedWindow — обрыв слишком медленной загрузки (см. saveBody), без повторов
 */
async function download(url, dest, onProgress, opts = {}) {
  const part = `${dest}.part`;
  const attempts = opts.attempts || DOWNLOAD_ATTEMPTS;
  const speedWindow = opts.speedWindow || 45000;
  const pause = opts.retryDelay === undefined ? 2000 : opts.retryDelay;
  let received = 0;
  let total = 0;
  let finalUrl = url;

  for (let attempt = 1; ; attempt++) {
    try {
      const headers = received ? { Range: `bytes=${received}-` } : {};
      const { res, url: u } = await open(url, { timeout: opts.timeout || 60000, headers });
      finalUrl = u;
      if (received && res.statusCode !== 206) received = 0;   // докачка не поддерживается — сначала
      total = totalSize(res, received) || total;
      await saveBody(res, part, received > 0, (n) => {
        received += n;
        if (onProgress) onProgress(received, total);
      }, opts.minSpeed || 0, speedWindow);
      if (total && received < total) throw incomplete('Загрузка прервана: файл скачан не полностью');
      break;
    } catch (err) {
      const retry = attempt < attempts && (RETRYABLE.indexOf(err.code) !== -1 || err.status >= 500 || err.status === 416);
      if (!retry) {
        fs.unlink(part, () => {});
        throw err;
      }
      // докачиваем с того, что реально записано на диск, а не с того, что пришло по сети
      received = err.status === 416 ? 0 : fileSize(part);
      console.warn(`[download] ${hostOf(url)}: ${err.message} — попытка ${attempt + 1} из ${attempts}${received ? `, докачка с ${(received / 1048576).toFixed(1)} МБ` : ''}`);
      await delay(pause * attempt);
    }
  }

  fs.renameSync(part, dest);
  return { url: finalUrl, size: received };
}

module.exports = { open, readAll, decompress, fetchText, download, setUserAgent };
