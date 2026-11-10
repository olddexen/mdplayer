/*
 * mdplayer: управление с пульта ТВ-приставки.
 *
 * - Стрелки переводят фокус на ближайший элемент в выбранном направлении (пространственная
 *   навигация): строки каналов, передачи, кнопки. Старый WebView сам так не умеет.
 * - OK (Enter) нажимает элемент в фокусе, даже если это строка списка, а не кнопка.
 * - Пока открыто окно (настройки, категории), фокус не выходит за его пределы.
 * - Плеер во весь экран управляется отдельно (player.js → handleKey).
 */
(function (window, document) {
  'use strict';

  var MD = window.MD;

  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
  var FOCUSABLE = 'button, input, select, textarea, [tabindex]';
  var layers = [];         // функции, возвращающие корень открытого окна (или null)
  var playerKey = null;    // обработчик клавиш плеера; true — клавиша обработана
  var lastNav = 0;

  function isVisible(node) {
    if (!node || node.disabled) return false;
    var r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
      // за пределами окна, но внутри прокручиваемого списка — тоже годится
      return !!scrollParent(node);
    }
    var style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.pointerEvents !== 'none' && +style.opacity !== 0;
  }

  function scrollParent(node) {
    var p = node.parentNode;
    while (p && p !== document.body && p.nodeType === 1) {
      var o = window.getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
      p = p.parentNode;
    }
    return null;
  }

  function scope() {
    for (var i = layers.length - 1; i >= 0; i--) {
      var root = layers[i]();
      if (root) return root;
    }
    return document;
  }

  function candidates(root) {
    var all = root.querySelectorAll(FOCUSABLE);
    var list = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.getAttribute('tabindex') === '-1' || el.hasAttribute('data-nav-skip')) continue;
      if (el.closest && el.closest('.hidden')) continue;
      if (isVisible(el)) list.push(el);
    }
    return list;
  }

  function center(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /**
   * Лучший кандидат в направлении dir: близко по основной оси и с перекрытием по поперечной.
   * Так «вниз» из строки канала ведёт к следующей строке, а не к кнопке в соседней колонке.
   */
  function best(from, list, dir) {
    var a = from.getBoundingClientRect();
    var ca = center(a);
    var winner = null;
    var winnerScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === from) continue;
      // кнопка внутри строки (звёздочка) — «вправо» со строки, «влево» обратно на строку
      var inner = from.contains(el);
      var outer = el.contains(from);
      if (inner || outer) {
        if ((inner && dir === 'right') || (outer && dir === 'left')) return el;
        continue;
      }
      var b = el.getBoundingClientRect();
      var cb = center(b);
      var main;
      var cross;
      var overlap;
      if (dir === 'down' || dir === 'up') {
        main = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
        if ((dir === 'down' ? cb.y <= ca.y : cb.y >= ca.y)) continue;
        overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        cross = Math.abs(cb.x - ca.x);
      } else {
        main = dir === 'right' ? b.left - a.right : a.left - b.right;
        if ((dir === 'right' ? cb.x <= ca.x : cb.x >= ca.x)) continue;
        overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        cross = Math.abs(cb.y - ca.y);
      }
      if (main < -4) main = 0;   // соседние элементы немного перекрываются
      var score = Math.max(0, main) + cross * (overlap > 0 ? 0.3 : 2) + (overlap > 0 ? 0 : 400);
      if (score < winnerScore) {
        winnerScore = score;
        winner = el;
      }
    }
    return winner;
  }

  function reveal(el) {
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(false);
    else if (el.scrollIntoView) el.scrollIntoView(false);
  }

  function focus(el) {
    if (!el) return false;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      el.focus();
    }
    reveal(el);
    return true;
  }

  /** Первый элемент для фокуса: активный канал, иначе первый подходящий. */
  function entry(root) {
    var preferred = root.querySelector('[data-nav-default]') ||
      (root === document ? document.querySelector('.ch.active') || document.querySelector('.ch') : null);
    if (preferred && isVisible(preferred)) return preferred;
    var list = candidates(root);
    return list[0] || null;
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return ['text', 'search', 'url', 'email', 'number', 'password'].indexOf(el.type) !== -1;
  }

  function move(dir) {
    var root = scope();
    var current = document.activeElement;
    if (!current || current === document.body || !(root === document || root.contains(current)) || !isVisible(current)) {
      return focus(entry(root));
    }
    var next = best(current, candidates(root), dir);
    if (next) return focus(next);
    // у края длинного списка — прокрутить его, чтобы дорисовались следующие строки
    var sp = scrollParent(current);
    if (sp && (dir === 'down' || dir === 'up')) {
      sp.scrollTop += dir === 'down' ? 200 : -200;
      return true;
    }
    return false;
  }

  function onKeyDown(e) {
    var key = e.keyCode;
    if (playerKey && playerKey(e)) {
      e.preventDefault();
      return;
    }
    var dir = KEYS[key];
    var active = document.activeElement;
    if (dir) {
      // в текстовом поле стрелки влево/вправо двигают курсор
      if (isTextField(active) && (dir === 'left' || dir === 'right')) return;
      if (active && active.tagName === 'SELECT') return;
      var now = Date.now();
      if (e.repeat && now - lastNav < 60) {   // зажатая стрелка — не быстрее 16 шагов в секунду
        e.preventDefault();
        return;
      }
      lastNav = now;
      if (move(dir)) e.preventDefault();
      return;
    }
    // OK на строке списка (div с tabindex) — как нажатие
    if ((key === 13 || key === 23) && active && active !== document.body &&
        active.tagName !== 'BUTTON' && active.tagName !== 'INPUT' && active.tagName !== 'SELECT' && active.tagName !== 'TEXTAREA') {
      e.preventDefault();
      active.click();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);

  MD.nav = {
    /** Окно, внутри которого держится фокус: getRoot() → элемент или null, если окно закрыто. */
    addLayer: function (getRoot) { layers.push(getRoot); },
    /** Обработчик клавиш плеера (полноэкранный режим). */
    setPlayerHandler: function (fn) { playerKey = fn; },
    focus: focus,
    focusFirst: function (root) { return focus(entry(root || scope())); },
    move: move
  };
})(window, document);
