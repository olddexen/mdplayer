'use strict';
/**
 * Раздача веб-интерфейса из public/ и автозагрузка hls.js,
 * если папку скопировали без public/vendor/hls.min.js.
 */
const fs = require('fs');
const path = require('path');
const httpClient = require('./http-client');
const { PUBLIC_DIR } = require('./config');

const HLS_VERSION = '0.14.17';
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const HLS_FILE = path.join(VENDOR_DIR, 'hls.min.js');
const HLS_SOURCES = [
  `https://cdn.jsdelivr.net/npm/hls.js@${HLS_VERSION}/dist/hls.min.js`,
  `https://cdnjs.cloudflare.com/ajax/libs/hls.js/${HLS_VERSION}/hls.min.js`,
  `https://unpkg.com/hls.js@${HLS_VERSION}/dist/hls.min.js`
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

let hlsDownload = null;

async function downloadHlsJs() {
  for (const src of HLS_SOURCES) {
    try {
      const { text } = await httpClient.fetchText(src, { timeout: 30000 });
      if (text.indexOf('Hls') === -1) throw new Error('неожиданное содержимое файла');
      fs.mkdirSync(VENDOR_DIR, { recursive: true });
      fs.writeFileSync(HLS_FILE, text);
      console.log(`[hls.js] Скачан ${HLS_VERSION} в public/vendor`);
      return true;
    } catch (err) {
      console.warn(`[hls.js] ${src}: ${err.message}`);
    }
  }
  console.warn('[hls.js] Не удалось скачать — браузер попробует загрузить его с CDN сам');
  return false;
}

function ensureHlsJs() {
  if (fs.existsSync(HLS_FILE)) return Promise.resolve(true);
  if (!hlsDownload) {
    hlsDownload = downloadHlsJs().then((ok) => {
      hlsDownload = null;
      return ok;
    });
  }
  return hlsDownload;
}

function sendStatus(res, status) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(String(status));
}

function sendFile(req, res, file, stat) {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    // библиотеки не меняются, а файлы приложения после правок должны подхватываться сразу
    'Cache-Control': file.indexOf(VENDOR_DIR + path.sep) === 0 ? 'public, max-age=604800' : 'no-cache'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function serve(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    sendStatus(res, 400);
    return;
  }
  if (rel.indexOf('\0') !== -1) {
    sendStatus(res, 400);
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (file.indexOf(PUBLIC_DIR + path.sep) !== 0) {
    sendStatus(res, 403);
    return;
  }

  fs.stat(file, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(req, res, file, stat);
    } else if (file === HLS_FILE) {
      ensureHlsJs().then((ok) => {
        if (ok) {
          serve(req, res, pathname);
          return;
        }
        res.writeHead(503, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end('/* hls.js нет в public/vendor, и скачать его не удалось */');
      });
    } else {
      sendStatus(res, 404);
    }
  });
}

module.exports = { serve, ensureHlsJs };
