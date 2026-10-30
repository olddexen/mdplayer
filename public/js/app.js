/* mdplayer: главный модуль — связывает список каналов, плеер, программу передач и настройки. */
(function (window, document) {
  'use strict';

  var MD = window.MD;
  var U = MD.util;
  var api = MD.api;

  var TICK = 60000;            // раз в минуту: «сейчас в эфире» и состояние сервера
  var BUSY_POLL = 3000;        // пока грузятся плейлист или EPG — чаще
  var RESUME_MAX = 40;         // сколько недосмотренных передач помнить
  var RESUME_SAVE_MS = 10000;  // как часто запоминать позицию в архиве

  var appEl, tabsEl, nowLogo, nowTitle, nowSub, nowBadge, btnLive, btnExternal, btnPrev;
  var state = null;
  var byId = {};
  var nowItems = {};
  var playlistVersion = -1;
  var epgState = '';
  var current = null;          // канал, который смотрим
  var previousId = null;       // для кнопки «Предыдущий канал»
  var archiveProg = null;      // передача из архива [начало, конец, название, описание]; null — прямой эфир
  var liveProg = null;         // передача в эфире — границы таймлайна
  var directUrl = '';          // прямая ссылка на поток (для внешнего плеера)
  var failedLogo = '';
  var playSeq = 0;             // защита от гонок: ответ на устаревший запрос игнорируется
  var pollTimer = null;
  var resumeSavedAt = 0;

  function init() {
    appEl = U.byId('app');
    tabsEl = U.byId('tabs');
    nowLogo = U.byId('now-logo');
    nowTitle = U.byId('now-title');
    nowSub = U.byId('now-sub');
    nowBadge = U.byId('now-badge');
    btnLive = U.byId('btn-live');
    btnExternal = U.byId('btn-external');
    btnPrev = U.byId('btn-prev-channel');

    MD.player.init({
      onTime: onPlayerTime,
      onRestart: function (abs) { if (current) seekArchive(current, abs); },
      onLive: function () { if (current) playLive(current); },
      onPrevChannel: function () { stepChannel(-1); },
      onNextChannel: function () { stepChannel(1); }
    });
    MD.channels.init({ onSelect: function (id) { playLive(byId[id]); } });
    MD.epg.init({
      onArchive: openArchive,
      onLive: playLive,
      onMap: function (ch) { MD.epgmap.open(ch); },
      resumeOf: resumeOf
    });
    MD.epgmap.init({ onChange: applyState });
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
    btnPrev.addEventListener('click', function () {
      if (previousId && byId[previousId]) playLive(byId[previousId]);
    });
    nowLogo.onerror = function () {
      failedLogo = nowLogo.getAttribute('src');
      U.setVisible(nowLogo, false);
    };
    MD.back = back;   // кнопка «Назад» в приложении mdplayer.apk

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

  // ---------- Состояние сервера ----------

  /** Свежее состояние сервера: перечитать каналы и программу, если они обновились. */
  function applyState(st) {
    state = st;
    MD.settings.updateStatus(st);

    var epgReady = epgState && epgState !== 'ready' && st.epg.state === 'ready';
    if (st.playlist.count && (st.playlist.version !== playlistVersion || epgReady)) {
      playlistVersion = st.playlist.version;
      loadChannels();   // после EPG — ради логотипов и отметок «есть программа»
    } else if (!st.playlist.count && st.configured) {
      MD.channels.message(st.playlist.state === 'loading' ? 'Загрузка плейлиста…' : 'Плейлист не загружен: ' + (st.playlist.message || 'нет данных'));
    }
    if (epgReady) {
      MD.epg.reload();
      loadNow();
    }
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

  // ---------- Воспроизведение ----------

  function setCurrent(ch) {
    if (current && current.id !== ch.id) previousId = current.id;
    current = ch;
    U.storage.set('lastChannel', ch.id);
    MD.channels.setActive(ch.id);
  }

  /** Передача канала в момент ts: из загруженной программы или из «сейчас в эфире». */
  function programmeAt(ch, ts) {
    var p = MD.epg.programmeAt(ch.id, ts);
    if (p) return p;
    var item = nowItems[ch.id];
    return item && item[1] <= ts && ts < item[2] ? [item[1], item[2], item[0], ''] : null;
  }

  function titleFor(ch, prog) {
    return ch.name + (prog ? ' — ' + prog[2] : '');
  }

  function playLive(ch) {
    if (!ch) return;
    var mySeq = ++playSeq;
    setCurrent(ch);
    archiveProg = null;
    directUrl = '';
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
      liveProg = programmeAt(ch, U.now());
      updateNowbar();
      MD.player.play(res.url, {
        live: true,
        timeshift: ch.archive > 0,   // перемотка назад в эфире = переход в архив
        windowStart: liveProg ? liveProg[0] : 0,
        windowStop: liveProg ? liveProg[1] : 0,
        title: titleFor(ch, liveProg)
      });
    });
  }

  /** Нажатие на передачу в программе: продолжить с места остановки или с начала. */
  function openArchive(ch, prog) {
    var saved = resumeOf(ch.id, prog[0]);
    if (!saved) {
      playArchive(ch, prog, prog[0]);
      return;
    }
    playArchive(ch, prog, saved);
    MD.player.toast('Продолжаем с ' + U.fmtTime(saved), 'С начала', function () {
      clearResume(ch.id, prog[0]);
      playArchive(ch, prog, prog[0]);
    });
  }

  /** Перемотка за пределы загруженного: открываем архив с нужного момента. */
  function seekArchive(ch, abs) {
    if (!ch.archive) {
      MD.player.toast('У этого канала нет архива — перемотка только в пределах загруженного');
      return;
    }
    var oldest = U.now() - ch.archive * 86400 + 60;
    if (abs < oldest) {
      abs = oldest;
      MD.player.toast('Это начало архива');
    }
    var hour = abs - abs % 3600;
    var prog = programmeAt(ch, abs) || [hour, hour + 3600, 'Архив ' + U.fmtTime(hour) + '–' + U.fmtTime(hour + 3600), ''];
    playArchive(ch, prog, abs);
  }

  /** Передача из архива с момента startAbs: ссылку с параметрами времени генерирует сервер. */
  function playArchive(ch, prog, startAbs) {
    var mySeq = ++playSeq;
    var start = Math.floor(startAbs || prog[0]);
    setCurrent(ch);
    archiveProg = prog;
    directUrl = '';
    MD.epg.show(ch);
    MD.epg.setPlaying(ch.id, prog[0]);
    updateNowbar();
    MD.player.loading();

    api.archive(ch.id, start, prog[1], function (err, res) {
      if (mySeq !== playSeq) return;
      if (err) {
        MD.player.fail(err.message, function () { playArchive(ch, prog, start); });
        return;
      }
      directUrl = res.direct;
      updateNowbar();
      MD.player.play(res.url, {
        live: false,
        startAbs: start,
        windowStart: prog[0],
        windowStop: prog[1],
        timeshift: true,
        title: titleFor(ch, prog)
      });
    });
  }

  /** Раз в секунду от плеера: следим за сменой передач и запоминаем позицию в архиве. */
  function onPlayerTime(abs, live) {
    if (!current) return;
    var now = U.now();
    if (live) {
      if (!liveProg || now >= liveProg[1]) {
        var p = programmeAt(current, now);
        if (p && (!liveProg || p[0] !== liveProg[0])) {
          liveProg = p;
          MD.player.setWindow(p[0], p[1], titleFor(current, p));
          updateNowbar();
        }
      }
      return;
    }
    if (!archiveProg) return;
    if (abs >= archiveProg[1]) {   // архив дошёл до следующей передачи — она продолжается сама
      var next = programmeAt(current, abs);
      if (next && next[0] !== archiveProg[0]) {
        clearResume(current.id, archiveProg[0]);
        archiveProg = next;
        MD.epg.setPlaying(current.id, next[0]);
        MD.player.setWindow(next[0], next[1], titleFor(current, next));
        updateNowbar();
      }
    }
    if (Date.now() - resumeSavedAt > RESUME_SAVE_MS) {
      resumeSavedAt = Date.now();
      saveResume(current.id, archiveProg, abs);
    }
  }

  function stepChannel(step) {
    if (!current) return;
    var ch = MD.channels.neighbor(current.id, step);
    if (ch) playLive(byId[ch.id] || ch);
  }

  // ---------- «Досмотреть»: позиции в архиве ----------

  function resumeOf(chId, start) {
    var item = U.storage.get('resume', {})[chId + ':' + start];
    return item ? item.pos : 0;
  }

  function saveResume(chId, prog, abs) {
    var map = U.storage.get('resume', {});
    var key = chId + ':' + prog[0];
    // в самом начале и в последние 2 минуты запоминать нечего
    if (abs - prog[0] < 60 || abs > prog[1] - 120) delete map[key];
    else map[key] = { pos: Math.floor(abs), at: Date.now() };
    var keys = Object.keys(map);
    if (keys.length > RESUME_MAX) {
      keys.sort(function (a, b) { return map[a].at - map[b].at; });
      for (var i = 0; i < keys.length - RESUME_MAX; i++) delete map[keys[i]];
    }
    U.storage.set('resume', map);
  }

  function clearResume(chId, start) {
    var map = U.storage.get('resume', {});
    delete map[chId + ':' + start];
    U.storage.set('resume', map);
  }

  // ---------- Строка под плеером ----------

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
      nowSub.textContent = 'Архив · ' + U.dayLabel(archiveProg[0]) + ' ' + U.fmtTime(archiveProg[0]) + ' — ' + archiveProg[2];
    } else {
      var item = nowItems[current.id];
      nowSub.textContent = item ? U.fmtTime(item[1]) + ' — ' + item[0] : 'Прямой эфир';
    }
    var prev = previousId && byId[previousId];
    U.setVisible(nowBadge, !archiveProg);
    U.setVisible(btnLive, !!archiveProg);
    U.setVisible(btnPrev, !!prev);
    if (prev) btnPrev.title = 'Предыдущий канал: ' + prev.name;
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

  // ---------- Вкладки, настройки, «Назад» ----------

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

  /** Системная кнопка «Назад» (из mdplayer.apk): закрыть окно или полноэкранный режим. true — обработано. */
  function back() {
    if (MD.epgmap.isOpen()) {
      MD.epgmap.close();
      return true;
    }
    if (MD.channels.isGridOpen()) {
      MD.channels.closeGrid();
      return true;
    }
    if (MD.settings.isOpen() && state && state.configured) {
      MD.settings.close();
      return true;
    }
    if (MD.player.isFullscreen()) {
      MD.player.exitFullscreen();
      return true;
    }
    return false;
  }

  init();
})(window, document);
