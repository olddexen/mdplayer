/* mdplayer: запросы к REST API сервера (XMLHttpRequest — работает везде). */
(function (window) {
  'use strict';

  var MD = window.MD;

  function request(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function done(err, data) {
      if (finished) return;
      finished = true;
      callback(err, data);
    }

    xhr.open(method, url, true);
    xhr.timeout = 90000;   // загрузка плейлиста по новой ссылке может быть долгой
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        done(null, data);
      } else if (!xhr.status) {
        done(new Error('Нет связи с сервером mdplayer. Он запущен в Termux?'));
      } else {
        done(new Error(data && data.error ? data.error : 'Ошибка сервера (' + xhr.status + ')'));
      }
    };

    if (body !== undefined) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(body));
    } else {
      xhr.send();
    }
  }

  function get(url, callback) {
    request('GET', url, undefined, callback);
  }

  function post(url, body, callback) {
    request('POST', url, body, callback);
  }

  function q(value) {
    return encodeURIComponent(value);
  }

  MD.api = {
    state: function (cb) { get('/api/state', cb); },
    saveConfig: function (data, cb) { post('/api/config', data, cb); },
    refresh: function (what, cb) { post('/api/refresh', { what: what }, cb); },
    channels: function (cb) { get('/api/channels', cb); },
    now: function (cb) { get('/api/now', cb); },
    epg: function (id, cb) { get('/api/epg?ch=' + q(id), cb); },
    epgSearch: function (text, cb) { get('/api/epg/search?q=' + q(text), cb); },
    epgMap: function (id, key, cb) { post('/api/epg/map', { ch: id, key: key }, cb); },
    stream: function (id, cb) { get('/api/stream?ch=' + q(id), cb); },
    archive: function (id, start, stop, cb) {
      get('/api/archive?ch=' + q(id) + '&start=' + start + '&stop=' + stop, cb);
    }
  };
})(window);
