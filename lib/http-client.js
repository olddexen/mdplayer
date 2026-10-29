'use strict';
/**
 * Небольшой HTTP-клиент на встроенных модулях http/https:
 * редиректы, таймауты, распаковка gzip и понятные сообщения об ошибках.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Linux; Android 8.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0 Mobile Safari/537.36';
const REDIRECTS = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;

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
      req.on('error', (err) => reject(networkError(err, current)));
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

/**
 * Скачивает файл на диск: сначала во временный *.part, потом переименовывает,
 * чтобы оборванная загрузка не испортила предыдущую копию.
 * onProgress(получено, всего) — всего = 0, если сервер не сообщил размер.
 */
async function download(url, dest, onProgress) {
  const { res, url: finalUrl } = await open(url, { timeout: 60000 });
  const total = parseInt(res.headers['content-length'], 10) || 0;
  const part = `${dest}.part`;

  const size = await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    let received = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      res.destroy();
      out.destroy();
      fs.unlink(part, () => {});
      reject(err);
    };
    res.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    res.on('aborted', () => fail(new Error('Загрузка прервана')));
    res.on('error', (err) => fail(networkError(err, url)));
    out.on('error', (err) => fail(new Error(`Не удалось записать файл: ${err.message}`)));
    out.on('finish', () => {
      if (total && received < total) {
        fail(new Error('Загрузка прервана: файл скачан не полностью'));
        return;
      }
      if (settled) return;
      settled = true;
      resolve(received);
    });
    res.pipe(out);
  });

  fs.renameSync(part, dest);
  return { url: finalUrl, size };
}

module.exports = { open, readAll, decompress, fetchText, download, setUserAgent };
