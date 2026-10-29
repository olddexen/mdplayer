/* mdplayer: главный модуль — связывает список каналов, плеер, программу передач и настройки. */
(function (window, document) {
  'use strict';

  var MD = window.MD;
  var U = MD.util;
  var api = MD.api;

  var TICK = 60000;        // раз в минуту: «сейчас в эфире» и состояние сервера
  var BUSY_POLL = 3000;    // пока грузятся плейлист или EPG — чаще

  var appEl, tabsEl, nowLogo, nowTitle, nowSub, nowBadge, btnLive, btnExternal;
  var state = null;
  var byId = {};
  var nowItems = {};
  var playlistVersion = -1;
  var epgState = '';
  var current = null;      // канал, который смотрим
  var archiveProg = null;  // передача из архива [начало, конец, название, описание]; null — прямой эфир
  var directUrl = '';      // прямая ссылка на поток (для внешнего плеера)
  var failedLogo = '';
  var playSeq = 0;         // защита от гонок: ответ на устаревший запрос игнорируется
  var pollTimer = null;

  function init() {
    appEl = U.byId('app');
    tabsEl = U.byId('tabs');
    nowLogo = U.byId('now-logo');
    nowTitle = U.byId('now-title');
    nowSub = U.byId('now-sub');
    nowBadge = U.byId('now-badge');
    btnLive = U.byId('btn-live');
    btnExternal = U.byId('btn-external');

    MD.player.init();
    MD.channels.init({ onSelect: function (id) { playLive(byId[id]); } });
    MD.epg.init({ onArchive: playArchive, onLive: playLive });
    MD.settings.init({ onChange: applyState });

    tabsEl.addEventListener('click', function (e) {
      var tab = U.closestAttr(e.target, 'data-tab', tabsEl);
      if (!tab) return;
      if (tab.getAttribute('data-tab') === 'settings') openSettings();
      else setTab(tab.getAttribute('data-tab'));
    });
    U.byId('side-settings').addEventListener('click', openSettings);
    U.byId('now-info').addEventListener('click', function () { setTab('epg'); });
    btnLive.addEventListener('click', function () { if (current) playLive(current); });
    btnExternal.addEventListener('click', openExternal);
    nowLogo.onerror = function () {
      failedLogo = nowLogo.getAttribute('src');
      U.setVisible(nowLogo, false);
    };

    setTab(U.storage.get('tab', 'channels'));
    api.state(function (err, st) {
      if (err) {
        MD.channels.message(err.message);
        return;
      }
      applyState(st);
      if (!st.configured) MD.settings.open(st, true);
    });
    setInterval(tick, TICK);
  }

  /** Свежее состояние сервера: перечитать каналы и программу, если они обновились. */
  function applyState(st) {
    state = st;
    MD.settings.updateStatus(st);

    var epgReady = epgState && epgState !== 'ready' && st.epg.state === 'ready';
    if (st.playlist.count && (st.playlist.version !== playlistVersion || epgReady)) {
      playlistVersion = st.playlist.version;
      loadChannels();   // после EPG — ради логотипов из программы передач
    } else if (!st.playlist.count && st.configured) {
      MD.channels.message(st.playlist.state === 'loading' ? 'Загрузка плейлиста…' : 'Плейлист не загружен: ' + (st.playlist.message || 'нет данных'));
    }
    if (epgReady) MD.epg.reload();
    epgState = st.epg.state;

    var busy = st.playlist.state === 'loading' || st.epg.state === 'download' || st.epg.state === 'parse';
    clearTimeout(pollTimer);
    if (busy) pollTimer = setTimeout(pollState, BUSY_POLL);
  }

  function pollState() {
    api.state(function (err, st) {
      if (err) {
        pollTimer = setTimeout(pollState, BUSY_POLL * 3);
        return;
      }
      applyState(st);
    });
  }

  function loadChannels() {
    api.channels(function (err, res) {
      if (err) {
        playlistVersion = -1;   // попробуем ещё раз на следующем тике
        MD.channels.message(err.message);
        return;
      }
      playlistVersion = res.version;
      byId = {};
      for (var i = 0; i < res.channels.length; i++) byId[res.channels[i].id] = res.channels[i];
      MD.channels.setData(res.channels, res.groups);
      loadNow();

      if (current && byId[current.id]) {
        current = byId[current.id];
        MD.channels.setActive(current.id);
        updateNowbar();
      } else if (!current) {
        var last = U.storage.get('lastChannel', null);
        if (last && byId[last]) playLive(byId[last]);
      }
    });
  }

  function loadNow() {
    api.now(function (err, res) {
      if (err) return;
      U.setServerTime(res.now);
      nowItems = res.items;
      MD.channels.setNow(nowItems);
      updateNowbar();
    });
  }

  function tick() {
    loadNow();
    MD.epg.tick();
    pollState();
  }

  function playLive(ch) {
    if (!ch) return;
    var mySeq = ++playSeq;
    current = ch;
    archiveProg = null;
    directUrl = '';
    U.storage.set('lastChannel', ch.id);
    MD.channels.setActive(ch.id);
    MD.epg.setPlaying(null);
    MD.epg.show(ch);
    updateNowbar();
    MD.player.loading();

    api.stream(ch.id, function (err, res) {
      if (mySeq !== playSeq) return;
      if (err) {
        MD.player.fail(err.message, function () { playLive(ch); });
        return;
      }
      directUrl = res.direct;
      updateNowbar();
      MD.player.play(res.url, ch.name);
    });
  }

  /** Передача из архива: ссылку с параметрами времени генерирует сервер. */
  function playArchive(ch, prog) {
    var mySeq = ++playSeq;
    current = ch;
    archiveProg = prog;
    directUrl = '';
    MD.channels.setActive(ch.id);
    MD.epg.setPlaying(ch.id, prog[0]);
    updateNowbar();
    MD.player.loading();

    api.archive(ch.id, prog[0], prog[1], function (err, res) {
      if (mySeq !== playSeq) return;
      if (err) {
        MD.player.fail(err.message, function () { playArchive(ch, prog); });
        return;
      }
      directUrl = res.direct;
      updateNowbar();
      MD.player.play(res.url, ch.name + ' — ' + prog[2]);
    });
  }

  function updateNowbar() {
    if (!current) return;
    nowTitle.textContent = current.name;
    if (current.logo && current.logo !== failedLogo) {
      if (nowLogo.getAttribute('src') !== current.logo) nowLogo.src = current.logo;
      U.setVisible(nowLogo, true);
    } else {
      U.setVisible(nowLogo, false);
    }

    if (archiveProg) {
      nowSub.textContent = 'Архив · ' + U.dayLabel(archiveProg[0]) + ' ' + U.fmtTime(archiveProg[0]) + ' · ' + archiveProg[2];
    } else {
      var item = nowItems[current.id];
      nowSub.textContent = item ? U.fmtTime(item[1]) + '–' + U.fmtTime(item[2]) + ' · ' + item[0] : 'Прямой эфир';
    }
    U.setVisible(nowBadge, !archiveProg);
    U.setVisible(btnLive, !!archiveProg);
    U.setVisible(btnExternal, !!directUrl);
  }

  /** Открыть поток в другом приложении (VLC, MX Player…). На Android — через intent:. */
  function openExternal() {
    if (!directUrl) return;
    var m = /^(https?):\/\/([^#]+)/i.exec(directUrl);
    MD.player.pause();
    if (m && /Android/i.test(navigator.userAgent)) {
      window.location.href = 'intent://' + m[2] + '#Intent;scheme=' + m[1].toLowerCase() + ';type=video/*;end';
    } else {
      window.open(directUrl, '_blank');
    }
  }

  function setTab(name) {
    if (name !== 'channels' && name !== 'epg') name = 'channels';
    appEl.className = 'app tab-' + name;
    var tabs = tabsEl.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-tab') === name) tabs[i].classList.add('active');
      else tabs[i].classList.remove('active');
    }
    U.storage.set('tab', name);
    if (name === 'epg') MD.epg.focus();
  }

  function openSettings() {
    MD.settings.open(state, !(state && state.configured));
    pollState();
  }

  init();
})(window, document);
