#!/usr/bin/env node
'use strict';
/**
 * mdplayer — веб-плеер онлайн-ТВ и архива передач для iEdem TV (Edem / iLook).
 *
 *   node server.js                  → http://127.0.0.1:8080
 *   node server.js --port 8081      → другой порт
 *   node server.js --host 0.0.0.0   → доступ с других устройств в Wi-Fi
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const { URL } = require('url');

const config = require('./lib/config');
const TvService = require('./lib/service');
const api = require('./lib/api');
const proxy = require('./lib/proxy');
const staticFiles = require('./lib/static');

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

fs.mkdirSync(config.DATA_DIR, { recursive: true });

const service = new TvService();
const PORT = parseInt(argValue('port') || process.env.PORT, 10) || service.config.port;
const HOST = argValue('host') || service.config.host;

/**
 * Защита от DNS rebinding: чужой сайт не должен достучаться до сервера через
 * своё доменное имя. Разрешены localhost, IP-адреса и имена из allowedHosts.
 */
function hostAllowed(header) {
  if (!header) return true;
  const host = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.indexOf(':') !== -1) return true;
  return (service.config.allowedHosts || []).some((h) => String(h).toLowerCase() === host);
}

function onRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`mdplayer: откройте страницу по IP-адресу (например, http://127.0.0.1:${PORT}) или добавьте это имя в allowedHosts в config.json`);
    return;
  }

  if (url.pathname === '/proxy') {
    proxy.handle(req, res, url.searchParams.get('u'));
  } else if (url.pathname.indexOf('/api/') === 0) {
    api.handle(service, req, res, url);
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    staticFiles.serve(req, res, url.pathname);
  } else {
    res.writeHead(405);
    res.end();
  }
}

function lanAddresses() {
  try {
    const result = [];
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach((name) => ifaces[name].forEach((a) => {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) result.push(a.address);
    }));
    return result;
  } catch (e) {
    return [];   // на части версий Android список сетевых интерфейсов недоступен
  }
}

const server = http.createServer(onRequest);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят — возможно, mdplayer уже запущен. Другой порт: node server.js --port ${PORT + 1}`);
  } else {
    console.error(`Не удалось запустить сервер: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const everywhere = HOST === '0.0.0.0' || HOST === '::';
  console.log('mdplayer запущен');
  console.log(`  Откройте в браузере:  http://${everywhere ? '127.0.0.1' : HOST}:${PORT}`);
  if (everywhere) lanAddresses().forEach((ip) => console.log(`  С других устройств:   http://${ip}:${PORT}`));
  console.log('  Остановить: Ctrl+C\n');
  staticFiles.ensureHlsJs();
  service.start().catch((err) => console.error(`[start] ${err.message}`));
});

// Сервер неделями работает на телефоне: случайная ошибка в одном запросе не должна его ронять.
process.on('unhandledRejection', (err) => console.error('[error]', err && err.stack ? err.stack : err));
process.on('uncaughtException', (err) => console.error('[error]', err && err.stack ? err.stack : err));
