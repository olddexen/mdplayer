/* mdplayer: категории (group-title), поиск, избранное и список каналов. */
(function (window, document) {
  'use strict';

  var MD = window.MD;
  var U = MD.util;

  var ALL = '';
  var FAVORITES = '*';     // служебное значение «группы» избранного
  var CHUNK = 60;          // длинный список рисуется порциями по мере прокрутки

  var groupsEl, searchEl, listEl;
  var onSelect = function () {};
  var channels = [];
  var groups = [];
  var visible = [];
  var rendered = 0;
  var rows = {};           // id → элементы строки, чтобы обновлять «сейчас в эфире»
  var nowItems = {};
  var activeId = null;
  var group = U.storage.get('group', ALL);
  var query = '';
  var favorites = U.storage.get('favorites', {});

  function normalize(text) {
    return String(text).toLowerCase().replace(/ё/g, 'е');
  }

  function init(options) {
    onSelect = options.onSelect;
    groupsEl = U.byId('groups');
    searchEl = U.byId('search');
    listEl = U.byId('channel-list');

    groupsEl.addEventListener('click', function (e) {
      var chip = U.closestAttr(e.target, 'data-group', groupsEl);
      if (!chip) return;
      group = chip.getAttribute('data-group');
      U.storage.set('group', group);
      searchEl.value = '';
      query = '';
      renderGroups(false);
      applyFilter(0);
    });

    searchEl.addEventListener('input', U.debounce(function () {
      query = normalize(searchEl.value.trim());
      applyFilter(0);
    }, 250));

    listEl.addEventListener('click', function (e) {
      var star = U.closestAttr(e.target, 'data-star', listEl);
      if (star) {
        toggleFavorite(star.getAttribute('data-star'), star);
        return;
      }
      var row = U.closestAttr(e.target, 'data-id', listEl);
      if (row) onSelect(row.getAttribute('data-id'));
    });

    listEl.addEventListener('scroll', function () {
      if (rendered < visible.length && listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 400) renderMore();
    });
  }

  /** Новый список каналов с сервера. Прокрутка сохраняется, если список просто обновился. */
  function setData(list, groupNames) {
    var keepScroll = channels.length ? listEl.scrollTop : 0;
    channels = list;
    groups = groupNames;
    if (group !== ALL && group !== FAVORITES && groups.indexOf(group) === -1) group = ALL;
    renderGroups(true);
    applyFilter(keepScroll);
  }

  function hasFavorites() {
    for (var i = 0; i < channels.length; i++) {
      if (favorites[channels[i].id]) return true;
    }
    return false;
  }

  function renderGroups(scrollToActive) {
    var scrollLeft = groupsEl.scrollLeft;
    U.clear(groupsEl);
    if (group === FAVORITES || hasFavorites()) addChip(FAVORITES, '★ Избранное');
    addChip(ALL, 'Все');
    for (var i = 0; i < groups.length; i++) addChip(groups[i], groups[i]);

    var active = groupsEl.querySelector('.chip.active');
    groupsEl.scrollLeft = scrollToActive && active ? Math.max(0, active.offsetLeft - 16) : scrollLeft;
  }

  function addChip(value, label) {
    var chip = U.el('button', 'chip' + (value === group ? ' active' : ''), label);
    chip.type = 'button';
    chip.setAttribute('data-group', value);
    groupsEl.appendChild(chip);
  }

  function applyFilter(scrollTop) {
    visible = channels.filter(function (ch) {
      if (query) return normalize(ch.name).indexOf(query) !== -1;
      if (group === FAVORITES) return !!favorites[ch.id];
      return group === ALL || ch.group === group;
    });
    rows = {};
    rendered = 0;
    U.clear(listEl);

    if (!visible.length) {
      var text = query ? 'Ничего не найдено' : group === FAVORITES ? 'Отметьте каналы звёздочкой ☆' : 'Нет каналов';
      listEl.appendChild(U.el('div', 'empty', text));
      return;
    }
    renderMore();
    // дорисовываем столько, чтобы вернуть прежнюю прокрутку (или заполнить высокий экран)
    while (rendered < visible.length && listEl.clientHeight && listEl.scrollHeight < scrollTop + listEl.clientHeight + 400) {
      renderMore();
    }
    listEl.scrollTop = scrollTop;
  }

  function renderMore() {
    var end = Math.min(rendered + CHUNK, visible.length);
    var frag = document.createDocumentFragment();
    for (var i = rendered; i < end; i++) frag.appendChild(renderRow(visible[i]));
    listEl.appendChild(frag);
    rendered = end;
  }

  function renderRow(ch) {
    var row = U.el('div', 'ch' + (ch.id === activeId ? ' active' : ''));
    row.setAttribute('data-id', ch.id);

    var logo = U.el('div', 'ch-logo');
    if (ch.logo) {
      var img = document.createElement('img');
      img.alt = '';
      img.onerror = function () {
        U.clear(logo);
        logo.appendChild(U.el('span', 'ch-initials', U.initials(ch.name)));
      };
      img.src = ch.logo;
      logo.appendChild(img);
    } else {
      logo.appendChild(U.el('span', 'ch-initials', U.initials(ch.name)));
    }

    var body = U.el('div', 'ch-body');
    var prog = U.el('div', 'ch-prog');
    var bar = U.el('div', 'bar');
    var fill = U.el('i');
    bar.appendChild(fill);
    body.appendChild(U.el('div', 'ch-name', ch.name));
    body.appendChild(prog);
    body.appendChild(bar);

    var side = U.el('div', 'ch-side');
    if (ch.archive) side.appendChild(U.el('span', 'ch-archive', '↻ ' + ch.archive + ' д'));
    var star = U.el('button', 'star' + (favorites[ch.id] ? ' on' : ''), favorites[ch.id] ? '★' : '☆');
    star.type = 'button';
    star.title = 'Избранное';
    star.setAttribute('data-star', ch.id);
    side.appendChild(star);

    row.appendChild(logo);
    row.appendChild(body);
    row.appendChild(side);
    rows[ch.id] = { row: row, prog: prog, bar: bar, fill: fill };
    updateNow(ch.id);
    return row;
  }

  function updateNow(id) {
    var r = rows[id];
    var item = nowItems[id];   // [название, начало, конец]
    if (!r) return;
    if (!item) {
      r.prog.textContent = '';
      r.bar.style.visibility = 'hidden';
      return;
    }
    var pct = (U.now() - item[1]) * 100 / Math.max(1, item[2] - item[1]);
    r.prog.textContent = item[0];
    r.bar.style.visibility = 'visible';
    r.fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
  }

  /** Обновить «сейчас в эфире» у уже нарисованных строк. */
  function setNow(items) {
    nowItems = items || {};
    Object.keys(rows).forEach(updateNow);
  }

  function setActive(id) {
    if (activeId && rows[activeId]) rows[activeId].row.classList.remove('active');
    activeId = id;
    if (rows[id]) rows[id].row.classList.add('active');
  }

  function toggleFavorite(id, button) {
    if (favorites[id]) delete favorites[id];
    else favorites[id] = 1;
    U.storage.set('favorites', favorites);
    button.textContent = favorites[id] ? '★' : '☆';
    if (favorites[id]) button.classList.add('on');
    else button.classList.remove('on');
    renderGroups(false);
    if (group === FAVORITES && !query) applyFilter(listEl.scrollTop);
  }

  /** Сообщение вместо списка (ошибка, загрузка). */
  function message(text) {
    visible = [];
    rows = {};
    rendered = 0;
    U.clear(listEl);
    listEl.appendChild(U.el('div', 'empty', text));
  }

  MD.channels = { init: init, setData: setData, setNow: setNow, setActive: setActive, message: message };
})(window, document);
