'use strict';
/**
 * HLS-прокси.
 *
 * Серверы IPTV обычно не отдают CORS-заголовки, и hls.js в браузере не может
 * читать их потоки напрямую. Поэтому плейлисты и сегменты идут через сервер:
 *   GET /proxy?u=<ссылка>
 * Если ответ — плейлист m3u8, все ссылки внутри переписываются на /proxy?u=…,
 * иначе (сегменты .ts / .aac, ключи) байты передаются браузеру как есть.
 */
const { URL } = require('url');
const httpClient = require('./http-client');

const PLAYLIST_LIMIT = 4 * 1024 * 1024;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-encoding'];

function proxify(url) {
  return `/proxy?u=${encodeURIComponent(url)}`;
}

function proxifyRef(base, ref) {
  let abs;
  try {
    abs = new URL(ref, base).href;
  } catch (e) {
    return ref;
  }
  return /^https?:\/\//i.test(abs) ? proxify(abs) : ref;   // data:, skd: и т.п. не трогаем
}

/** Переписывает ссылки в m3u8: строки-адреса и атрибуты URI="…" (ключи, аудиодорожки, EXT-X-MAP). */
function rewritePlaylist(text, baseUrl) {
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (t.charAt(0) === '#') return t.replace(/URI="([^"]*)"/g, (m, uri) => `URI="${proxifyRef(baseUrl, uri)}"`);
    return proxifyRef(baseUrl, t);
  }).join('\n');
}

function looksLikePlaylist(contentType, url) {
  if (/mpegurl|m3u/i.test(contentType)) return true;
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch (e) {
    // не ссылка — решаем по типу
  }
  return /\.m3u8?$/i.test(pathname) || /^text\//i.test(contentType);
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function handle(req, res, target) {
  if (!target || !/^https?:\/\//i.test(target)) {
    send(res, 400, 'text/plain; charset=utf-8', 'Некорректная ссылка для прокси');
    return;
  }

  // Зритель переключил канал — обрываем загрузку у провайдера, чтобы не тратить трафик.
  let upstream = null;
  let finished = false;
  res.on('finish', () => {
    finished = true;
  });
  res.on('close', () => {
    if (!finished && upstream) upstream.destroy();
  });

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;

  httpClient.open(target, { headers, timeout: 20000, anyStatus: true, onRequest: (r) => { upstream = r; } })
    .then(({ res: up, url: finalUrl }) => {
      const type = up.headers['content-type'] || '';
      if (up.statusCode < 400 && looksLikePlaylist(type, finalUrl)) {
        return httpClient.readAll(up, PLAYLIST_LIMIT).then((raw) => {
          const body = httpClient.decompress(raw, up.headers['content-encoding']);
          const text = body.toString('utf8').replace(/^﻿/, '');
          if (/^\s*#EXTM3U/.test(text)) send(res, 200, 'application/vnd.apple.mpegurl', rewritePlaylist(text, finalUrl));
          else send(res, up.statusCode, type || 'application/octet-stream', body);
        });
      }
      const out = { 'Cache-Control': 'no-cache' };
      PASS_HEADERS.forEach((name) => {
        if (up.headers[name]) out[name] = up.headers[name];
      });
      res.writeHead(up.statusCode, out);
      up.on('error', () => res.destroy());
      up.on('aborted', () => res.destroy());
      up.pipe(res);
      return null;
    })
    .catch((err) => {
      if (res.headersSent) res.destroy();
      else send(res, 502, 'text/plain; charset=utf-8', err.message);
    });
}

module.exports = { handle, proxify, rewritePlaylist };
