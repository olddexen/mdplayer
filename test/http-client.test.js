'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const httpClient = require('../lib/http-client');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlOf(server, p) {
  return `http://127.0.0.1:${server.address().port}${p}`;
}

const DATA = Buffer.alloc(300 * 1024);
for (let i = 0; i < DATA.length; i++) DATA[i] = i % 251;

test('download: обрыв посередине — докачка с места остановки (Range)', async () => {
  let calls = 0;
  const ranges = [];
  const server = await listen((req, res) => {
    calls++;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    ranges.push(req.headers.range || '');
    if (m) {
      const from = +m[1];
      res.writeHead(206, { 'Content-Length': DATA.length - from, 'Content-Range': `bytes ${from}-${DATA.length - 1}/${DATA.length}` });
      res.end(DATA.subarray(from));
      return;
    }
    // первая попытка: отдаём треть и рвём соединение
    res.writeHead(200, { 'Content-Length': DATA.length });
    res.write(DATA.subarray(0, 100 * 1024), () => setTimeout(() => res.destroy(), 20));
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-')), 'f.bin');
  try {
    const result = await httpClient.download(urlOf(server, '/f'), dest, null, { retryDelay: 10 });
    assert.strictEqual(result.size, DATA.length);
    assert.ok(fs.readFileSync(dest).equals(DATA));
    assert.ok(calls >= 2);
    assert.match(ranges[ranges.length - 1], /^bytes=\d+-$/);
    assert.ok(!fs.existsSync(`${dest}.part`));
  } finally {
    server.close();
  }
});

test('download: сервер без докачки — скачивается заново целиком', async () => {
  let calls = 0;
  const server = await listen((req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Length': DATA.length });
    if (calls === 1) res.write(DATA.subarray(0, 50 * 1024), () => setTimeout(() => res.destroy(), 20));
    else res.end(DATA);
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-')), 'f.bin');
  try {
    await httpClient.download(urlOf(server, '/f'), dest, null, { retryDelay: 10 });
    assert.ok(fs.readFileSync(dest).equals(DATA));
  } finally {
    server.close();
  }
});

test('download: 404 — без повторов, временный файл удалён', async () => {
  let calls = 0;
  const server = await listen((req, res) => {
    calls++;
    res.writeHead(404);
    res.end();
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-')), 'f.bin');
  try {
    await assert.rejects(httpClient.download(urlOf(server, '/f'), dest, null, { retryDelay: 10 }), /404/);
    assert.strictEqual(calls, 1);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
  } finally {
    server.close();
  }
});

test('keep-alive: последовательные запросы идут по одному соединению', async () => {
  const sockets = new Set();
  const server = await listen((req, res) => {
    sockets.add(req.socket);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  try {
    for (let i = 0; i < 4; i++) {
      const { text } = await httpClient.fetchText(urlOf(server, `/x${i}`));
      assert.strictEqual(text, 'ok');
    }
    assert.strictEqual(sockets.size, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('редирект и gzip', async () => {
  const zlib = require('zlib');
  const server = await listen((req, res) => {
    if (req.url === '/a') {
      res.writeHead(302, { Location: '/b' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync('#EXTM3U\nпривет'));
  });
  try {
    const { text, url } = await httpClient.fetchText(urlOf(server, '/a'));
    assert.strictEqual(text, '#EXTM3U\nпривет');
    assert.match(url, /\/b$/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('download: слишком медленный источник обрывается без повторов', async () => {
  let calls = 0;
  const timers = [];
  const server = await listen((req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Length': DATA.length });
    const t = setInterval(() => res.write(DATA.subarray(0, 10)), 20);   // ~500 байт/с
    timers.push(t);
    res.on('close', () => clearInterval(t));
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-')), 'f.bin');
  try {
    await assert.rejects(
      httpClient.download(urlOf(server, '/f'), dest, null, { retryDelay: 10, minSpeed: 5000, speedWindow: 200 }),
      (err) => err.code === 'SLOW'
    );
    assert.strictEqual(calls, 1);
    await new Promise((r) => setTimeout(r, 50));   // временный файл удаляется асинхронно
    assert.ok(!fs.existsSync(`${dest}.part`));
    assert.ok(!fs.existsSync(dest));
  } finally {
    timers.forEach(clearInterval);
    server.closeAllConnections();
    server.close();
  }
});

test('download: обрыв сразу после большой порции — файл без дыр', async () => {
  const BIG = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 7) % 253;
  let calls = 0;
  const server = await listen((req, res) => {
    calls++;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const from = m ? +m[1] : 0;
    res.writeHead(m ? 206 : 200, Object.assign({ 'Content-Length': BIG.length - from },
      m ? { 'Content-Range': `bytes ${from}-${BIG.length - 1}/${BIG.length}` } : {}));
    if (calls < 3) {
      res.write(BIG.subarray(from, from + 1500 * 1024));
      res.destroy();   // без паузы: часть данных ещё не успела дойти до файла
    } else {
      res.end(BIG.subarray(from));
    }
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdp-')), 'f.bin');
  try {
    await httpClient.download(urlOf(server, '/f'), dest, null, { retryDelay: 5 });
    assert.ok(fs.readFileSync(dest).equals(BIG));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
