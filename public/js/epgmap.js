/* mdplayer: ручной выбор программы передач для канала (если автоматика не нашла или ошиблась). */
(function (window, document) {
  'use strict';

  var MD = window.MD;
  var U = MD.util;

  var root, hintEl, searchEl, listEl;
  var onChange = function () {};
  var channel = null;
  var seq = 0;

  function init(options) {
    onChange = options.onChange;
    root = U.byId('epg-map');
    hintEl = U.byId('epg-map-hint');
    searchEl = U.byId('epg-map-search');
    listEl = U.byId('epg-map-list');

    U.byId('epg-map-close').addEventListener('click', close);
    U.byId('epg-map-auto').addEventListener('click', function () { apply(null); });
    root.addEventListener('click', function (e) {
      if (e.target === root) close();
    });
    searchEl.addEventListener('input', U.debounce(search, 300));
    listEl.addEventListener('click', function (e) {
      var item = U.closestAttr(e.target, 'data-key', listEl);
      if (item) apply(item.getAttribute('data-key'));
    });
  }

  /** «Первый канал HD» → «Первый»: так поиск сразу показывает подходящие варианты. */
  function guess(name) {
    return String(name).replace(/\b(hd|fhd|uhd|sd|4k|orig)\b/gi, '').replace(/[()[\]+]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function open(ch) {
    channel = ch;
    hintEl.textContent = 'Канал «' + ch.name + '». Найдите его в программе передач и нажмите на подходящий вариант — названия передач появятся в архиве.';
    searchEl.value = guess(ch.name);
    U.setVisible(root, true);
    search();
  }

  function close() {
    U.setVisible(root, false);
  }

  function isOpen() {
    return root.className.indexOf('hidden') === -1;
  }

  function message(text) {
    U.clear(listEl);
    listEl.appendChild(U.el('div', 'empty', text));
  }

  function search() {
    var q = searchEl.value.trim();
    if (!q) {
      message('Введите название канала');
      return;
    }
    var mySeq = ++seq;
    MD.api.epgSearch(q, function (err, res) {
      if (mySeq !== seq) return;
      if (err) {
        message(err.message);
        return;
      }
      U.clear(listEl);
      if (!res.items.length) {
        message('Ничего не найдено. Попробуйте короче или другое написание. Если программа ещё загружается — подождите.');
        return;
      }
      for (var i = 0; i < res.items.length; i++) {
        var it = res.items[i];
        var button = U.el('button', 'pick-item', it.name);
        button.type = 'button';
        button.setAttribute('data-key', it.key);
        button.appendChild(U.el('small', null, it.source));
        listEl.appendChild(button);
      }
    });
  }

  function apply(key) {
    if (!channel) return;
    message('Применяется…');
    MD.api.epgMap(channel.id, key, function (err, state) {
      if (err) {
        message(err.message);
        return;
      }
      close();
      MD.player.toast(key ? 'Программа выбрана, обновляется…' : 'Программа будет подобрана автоматически');
      onChange(state);
    });
  }

  MD.epgmap = { init: init, open: open, close: close, isOpen: isOpen };
})(window, document);
