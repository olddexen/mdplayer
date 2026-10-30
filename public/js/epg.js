/* mdplayer: программа передач текущего канала; прошедшие передачи открываются из архива. */
(function (window, document) {
  'use strict';

  var MD = window.MD;
  var U = MD.util;

  var CACHE_MS = 10 * 60 * 1000;   // программу того же канала не перезапрашиваем чаще

  var daysEl, listEl;
  var handlers = {};
  var channel = null;
  var programmes = [];     // [[начало, конец, название, описание], ...]
  var note = '';           // пояснение над списком (например, «архив по часам»)
  var source = '';         // откуда взята программа: «Первый канал (epg.it999.ru)»
  var manual = false;      // программа выбрана вручную
  var dayKeys = [];
  var dayStarts = {};
  var day = null;
  var playing = null;      // { id, start } — передача из архива, которая сейчас идёт
  var loadedAt = 0;
  var seq = 0;

  function init(options) {
    handlers = options;
    daysEl = U.byId('days');
    listEl = U.byId('epg-list');

    daysEl.addEventListener('click', function (e) {
      var chip = U.closestAttr(e.target, 'data-day', daysEl);
      if (!chip) return;
      day = chip.getAttribute('data-day');
      renderDays();
      renderList(true);
    });

    listEl.addEventListener('click', function (e) {
      if (U.closestAttr(e.target, 'data-map', listEl)) {
        if (channel) handlers.onMap(channel);
        return;
      }
      var row = U.closestAttr(e.target, 'data-index', listEl);
      if (!row || !channel) return;
      var p = programmes[+row.getAttribute('data-index')];
      if (!p) return;
      if (isArchive(p)) handlers.onArchive(channel, p);
      else if (isLive(p)) handlers.onLive(channel);
    });
  }

  function isLive(p) {
    var now = U.now();
    return p[0] <= now && now < p[1];
  }

  /** Передача есть в архиве: уже началась и не старше глубины архива канала. */
  function isArchive(p) {
    if (!channel || !channel.archive) return false;
    var now = U.now();
    return p[0] < now && p[0] >= now - channel.archive * 86400;
  }

  function minutes(sec) {
    var m = Math.round(sec / 60);
    return m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч' + (m % 60 ? ' ' + (m % 60) + ' мин' : '');
  }

  /** Нет EPG, но есть архив: делим архив на часовые отрезки, чтобы его всё равно можно было смотреть. */
  function hourlySlots(days) {
    var d = new Date(U.now() * 1000);
    d.setMinutes(0, 0, 0);
    var top = Math.floor(d.getTime() / 1000);
    var list = [];
    for (var t = top - days * 86400 + 3600; t <= top; t += 3600) {
      list.push([t, t + 3600, 'Архив ' + U.fmtTime(t) + '–' + U.fmtTime(t + 3600), '']);
    }
    return list;
  }

  /** Показать программу канала. */
  function show(ch, force) {
    if (!ch) return;
    var same = channel && channel.id === ch.id;
    channel = ch;
    if (same && !force && programmes.length && Date.now() - loadedAt < CACHE_MS) {
      renderList(false);
      return;
    }
    if (!same) {
      day = null;
      programmes = [];
      U.clear(daysEl);
      message('Загрузка программы…', false);
    }

    var mySeq = ++seq;
    MD.api.epg(ch.id, function (err, res) {
      if (mySeq !== seq) return;   // пока ждали ответ, выбрали другой канал
      if (err) {
        if (!programmes.length) message(err.message, false);
        return;
      }
      U.setServerTime(res.now);
      loadedAt = Date.now();
      programmes = res.programmes;
      source = res.source || '';
      manual = !!res.manual;
      note = '';

      if (!programmes.length) {
        var busy = res.epg.state === 'download' || res.epg.state === 'parse';
        if (busy) loadedAt = 0;   // перезапросим, когда EPG загрузится
        if (!ch.archive) {
          U.clear(daysEl);
          message(busy ? 'Программа передач загружается…' : 'Для этого канала не найдена программа передач.', !busy);
          return;
        }
        programmes = hourlySlots(ch.archive);
        note = busy
          ? 'Программа передач загружается — пока архив по часам'
          : 'Программа для этого канала не найдена — архив разбит по часам. Выберите программу вручную (внизу списка), и здесь появятся названия передач.';
      }
      buildDays();
      renderDays();
      renderList(true);
    });
  }

  function buildDays() {
    dayKeys = [];
    dayStarts = {};
    for (var i = 0; i < programmes.length; i++) {
      var key = U.dayKey(programmes[i][0]);
      if (!dayStarts.hasOwnProperty(key)) {
        dayStarts[key] = programmes[i][0];
        dayKeys.push(key);
      }
    }
    if (!day || !dayStarts.hasOwnProperty(day)) day = defaultDay();
  }

  function defaultDay() {
    if (playing && channel && playing.id === channel.id) {
      var playingDay = U.dayKey(playing.start);
      if (dayStarts.hasOwnProperty(playingDay)) return playingDay;
    }
    var today = U.dayKey(U.now());
    return dayStarts.hasOwnProperty(today) ? today : dayKeys[dayKeys.length - 1];
  }

  function renderDays() {
    U.clear(daysEl);
    for (var i = 0; i < dayKeys.length; i++) {
      var key = dayKeys[i];
      var chip = U.el('button', 'chip' + (key === day ? ' active' : ''), U.dayLabel(dayStarts[key]));
      chip.type = 'button';
      chip.setAttribute('data-day', key);
      daysEl.appendChild(chip);
    }
    scrollDays();
  }

  function scrollDays() {
    var active = daysEl.querySelector('.chip.active');
    if (active) daysEl.scrollLeft = Math.max(0, active.offsetLeft - 40);
  }

  function scrollToCurrent() {
    var target = listEl.querySelector('.pr.playing') || listEl.querySelector('.pr.live');
    listEl.scrollTop = target ? Math.max(0, target.offsetTop - 60) : 0;
  }

  /** scroll=true — прокрутить к идущей или просматриваемой передаче, иначе сохранить прокрутку. */
  function renderList(scroll) {
    if (!programmes.length) return;
    var keep = listEl.scrollTop;
    var now = U.now();
    var frag = document.createDocumentFragment();
    if (note) frag.appendChild(U.el('div', 'note', note));
    for (var i = 0; i < programmes.length; i++) {
      if (U.dayKey(programmes[i][0]) === day) frag.appendChild(renderRow(programmes[i], i, now));
    }
    frag.appendChild(renderFooter());
    U.clear(listEl);
    listEl.appendChild(frag);
    if (scroll) scrollToCurrent();
    else listEl.scrollTop = keep;
  }

  /** Строка: «12:00  Comedy Club / до 13:00 · 1 ч», полоска «досмотреть», отметка архива. */
  function renderRow(p, index, now) {
    var live = p[0] <= now && now < p[1];
    var archive = isArchive(p);
    var isPlaying = !!(playing && playing.id === channel.id && playing.start === p[0]);
    var resumeAt = archive && !isPlaying && handlers.resumeOf ? handlers.resumeOf(channel.id, p[0]) : 0;
    var cls = 'pr ' + (live ? 'live' : p[1] <= now ? 'past' : 'future');
    if (archive) cls += ' archive';
    else if (!live && p[1] <= now) cls += ' no-archive';
    if (isPlaying) cls += ' playing';

    var row = U.el('div', cls);
    row.setAttribute('data-index', index);
    row.appendChild(U.el('div', 'pr-time', U.fmtTime(p[0])));

    var body = U.el('div', 'pr-body');
    body.appendChild(U.el('div', 'pr-title', p[2]));
    body.appendChild(U.el('div', 'pr-sub', 'до ' + U.fmtTime(p[1]) + ' · ' + minutes(p[1] - p[0]) + (resumeAt ? ' · остановились на ' + U.fmtTime(resumeAt) : '')));
    if (live || resumeAt) {
      var bar = U.el('div', 'bar' + (live ? '' : ' resume'));
      var fill = U.el('i');
      var pos = live ? now : resumeAt;
      fill.style.width = Math.min(100, (pos - p[0]) * 100 / Math.max(1, p[1] - p[0])).toFixed(1) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
    }
    if (p[3] && (live || isPlaying)) body.appendChild(U.el('div', 'pr-desc', p[3]));
    row.appendChild(body);

    var mark = isPlaying ? '▶ смотрите' : live ? (archive ? '↻ с начала' : '● эфир') : resumeAt ? '▶ досмотреть' : archive ? '↻' : '';
    if (mark) row.appendChild(U.el('div', 'pr-mark', mark));
    return row;
  }

  /** Внизу: откуда взята программа и кнопка ручного выбора. */
  function renderFooter() {
    var footer = U.el('div', 'epg-footer');
    if (source) footer.appendChild(document.createTextNode('Программа: ' + source + (manual ? ' — выбрана вручную' : '') + ' '));
    var link = U.el('button', 'link-btn', source ? 'Не та программа?' : 'Выбрать программу вручную');
    link.type = 'button';
    link.setAttribute('data-map', '1');
    footer.appendChild(link);
    return footer;
  }

  function message(text, withMapButton) {
    U.clear(listEl);
    listEl.appendChild(U.el('div', 'empty', text));
    if (withMapButton) listEl.appendChild(renderFooter());
  }

  /** Отметить передачу из архива, которую сейчас смотрим (id = null — прямой эфир). */
  function setPlaying(id, start) {
    playing = id ? { id: id, start: start } : null;
    if (channel && programmes.length) renderList(false);
  }

  /** Передача канала, которая шла в момент ts (если программа этого канала загружена). */
  function programmeAt(chId, ts) {
    if (!channel || channel.id !== chId) return null;
    for (var i = 0; i < programmes.length; i++) {
      if (programmes[i][0] <= ts && ts < programmes[i][1]) return programmes[i];
    }
    return null;
  }

  /**
   * Панель стала видимой. Пока она скрыта (вкладка «Каналы» на телефоне),
   * прокрутка не работает — поэтому доводим её здесь.
   */
  function focus() {
    scrollDays();
    scrollToCurrent();
  }

  /** Раз в минуту: сдвинуть отметку «сейчас», время от времени — перезапросить программу. */
  function tick() {
    if (!channel) return;
    if (!loadedAt || Date.now() - loadedAt > CACHE_MS) show(channel, true);
    else renderList(false);
  }

  function reload() {
    if (channel) show(channel, true);
  }

  MD.epg = {
    init: init,
    show: show,
    setPlaying: setPlaying,
    programmeAt: programmeAt,
    tick: tick,
    reload: reload,
    focus: focus
  };
})(window, document);
