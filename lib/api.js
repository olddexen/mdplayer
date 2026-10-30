'use strict';
/** REST API веб-интерфейса. Ответы — JSON, ошибки — { "error": "текст" }. */

const BODY_LIMIT = 30 * 1024 * 1024;   // загружаемый плейлист приходит в теле запроса

const ROUTES = {
  'GET /api/state': (svc) => svc.state(),
  'POST /api/config': (svc, query, body) => svc.saveConfig(body),
  'POST /api/refresh': (svc, query, body) => svc.refresh(body.what),
  'GET /api/channels': (svc) => svc.channelsPayload(),
  'GET /api/now': (svc) => svc.nowPayload(),
  'GET /api/epg': (svc, query) => svc.epgPayload(query.get('ch')),
  'GET /api/epg/search': (svc, query) => svc.epgSearch(query.get('q')),
  'POST /api/epg/map': (svc, query, body) => svc.setEpgMap(body),
  'GET /api/stream': (svc, query) => svc.streamPayload(query.get('ch')),
  'GET /api/archive': (svc, query) => svc.archivePayload(query.get('ch'), query.get('start'), query.get('stop'))
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Некорректный JSON в запросе'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handle(svc, req, res, url) {
  const route = ROUTES[`${req.method} ${url.pathname}`];
  if (!route) {
    sendJson(res, 404, { error: 'Неизвестный запрос API' });
    return;
  }
  // Требуем JSON: чужой сайт не сможет отправить такой запрос без CORS-разрешения (защита от CSRF).
  if (req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
    sendJson(res, 415, { error: 'Ожидается Content-Type: application/json' });
    return;
  }
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    sendJson(res, 200, await route(svc, url.searchParams, body));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', err.stack || err.message);
    sendJson(res, status, { error: err.message });
  }
}

module.exports = { handle };
