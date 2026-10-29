/* mdplayer: общие утилиты. ES5 без зависимостей — работает в старых WebView Android. */
(function (window, document) {
  'use strict';

  var MD = window.MD = window.MD || {};
  var WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var timeOffset = 0;   // поправка часов браузера по часам сервера, с

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setVisible(node, visible) {
    if (visible) node.classList.remove('hidden');
    else node.classList.add('hidden');
  }

  /** Ближайший элемент с атрибутом attr от node вверх по дереву, не выше root. */
  function closestAttr(node, attr, root) {
    while (node && node !== root) {
      if (node.nodeType === 1 && node.hasAttribute(attr)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function fmtTime(ts) {
    var d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayKey(ts) {
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** «Сегодня», «Вчера», «Завтра» или «Пн 27.10». */
  function dayLabel(ts) {
    var key = dayKey(ts);
    var today = now();
    if (key === dayKey(today)) return 'Сегодня';
    if (key === dayKey(today - 86400)) return 'Вчера';
    if (key === dayKey(today + 86400)) return 'Завтра';
    var d = new Date(ts * 1000);
    return WEEKDAYS[d.getDay()] + ' ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1);
  }

  function setServerTime(serverNow) {
    timeOffset = serverNow - Date.now() / 1000;
  }

  /** Текущее время по часам сервера, Unix Timestamp в секундах. */
  function now() {
    return Math.floor(Date.now() / 1000 + timeOffset);
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /** localStorage бывает недоступен (приватный режим, запрет) — тогда просто ничего не запоминаем. */
  var storage = {
    get: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem('mdplayer.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem('mdplayer.' + key, JSON.stringify(value));
      } catch (e) {
        // нет места или запрещено
      }
    }
  };

  /** Две буквы вместо логотипа: «Первый канал» → «ПК». */
  function initials(name) {
    var words = String(name).replace(/[^0-9A-Za-zА-Яа-яЁё]+/g, ' ').split(' ').filter(Boolean);
    var text = words.length > 1 ? words[0].charAt(0) + words[1].charAt(0) : (words[0] || '?').slice(0, 2);
    return text.toUpperCase();
  }

  MD.util = {
    byId: byId,
    el: el,
    clear: clear,
    setVisible: setVisible,
    closestAttr: closestAttr,
    fmtTime: fmtTime,
    dayKey: dayKey,
    dayLabel: dayLabel,
    setServerTime: setServerTime,
    now: now,
    debounce: debounce,
    storage: storage,
    initials: initials
  };
})(window, document);
