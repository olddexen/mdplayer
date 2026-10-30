/*
 * mdplayer: плеер в стиле MX Player.
 * HTML5 <video> + hls.js 0.14 (стабильная ветка для старых Android) и свои элементы управления:
 * таймлайн, ±10 с, масштаб, жесты (яркость, громкость, перемотка), полноэкранный режим.
 *
 * Перемотка «по времени эфира»: позиция — это Unix-время передачи, а не секунды файла.
 * Если нужное место уже есть в буфере — перематываем внутри потока, иначе просим приложение
 * открыть архив с этого момента (onRestart) — так перемотка работает на любых плейлистах провайдера.
 */
(function (window, document) {
  'use strict';

  var MD = window.MD;
  var U = MD.util;

  // Настройки hls.js под телефон: умеренный буфер, качество не выше размера плеера.
  var HLS_CONFIG = {
    enableWorker: true,
    capLevelToPlayerSize: true,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    maxBufferSize: 40 * 1000 * 1000,
    liveBackBufferLength: 60,
    liveSyncDurationCount: 3,
    manifestLoadingTimeOut: 15000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 15000,
    levelLoadingMaxRetry: 4,
    fragLoadingTimeOut: 25000,
    fragLoadingMaxRetry: 6
  };
  var MAX_RECOVERIES = 3;
  var HIDE_DELAY = 4000;       // элементы управления прячутся через 4 с
  var SEEK_STEP = 10;          // кнопки и двойное касание: ±10 с
  var SWIPE_SECONDS = 180;     // свайп на всю ширину экрана = 3 минуты
  var ASPECTS = [['fit', 'Оригинал'], ['fill', 'Растянуть'], ['crop', 'Обрезать'], ['16:9', '16:9'], ['4:3', '4:3']];

  var native = window.MDNative || null;   // мост из приложения mdplayer.apk (системные громкость и яркость)

  var video, box, player, controls, overlay, overlayText, overlayBtn;
  var els = {};
  var hls = null;
  var session = null;          // текущий поток, см. play()
  var handlers = {};
  var retry = null;
  var recoveries = 0;
  var unlocked = false;
  var aspect = U.storage.get('aspect', 'fit');
  var hideTimer = null;
  var osdTimer = null;
  var toastTimer = null;
  var tapTimer = null;
  var lastTap = null;
  var gesture = null;
  var drag = null;             // перетаскивание по таймлайну
  var dimLevel = 0;            // в браузере яркость имитируется затемнением

  // ---------- Вспомогательное ----------

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 20:34:05 */
  function clock(ts) {
    var d = new Date(ts * 1000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** +1:05 / −0:35 */
  function delta(sec) {
    var s = Math.round(Math.abs(sec));
    var text = Math.floor(s / 60) + ':' + pad(s % 60);
    if (s >= 3600) text = Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
    return (sec < 0 ? '−' : '+') + text;
  }

  function setWidth(node, fraction) {
    node.style.width = (clamp(fraction, 0, 1) * 100).toFixed(2) + '%';
  }

  function on(node, type, fn) {
    node.addEventListener(type, fn, { passive: false });
  }

  // ---------- Инициализация ----------

  function init(options) {
    handlers = options || {};
    video = U.byId('video');
    box = U.byId('player-box');
    player = U.byId('player');
    controls = U.byId('controls');
    overlay = U.byId('overlay');
    overlayText = U.byId('overlay-text');
    overlayBtn = U.byId('overlay-btn');
    ['gesture', 'dimmer', 'osd', 'osd-text', 'osd-fill', 'ctl-title', 'ctl-play', 'ctl-back', 'ctl-fwd', 'ctl-prev', 'ctl-next',
      'ctl-live', 'ctl-aspect', 'ctl-fs', 'ctl-time', 'timeline', 'tl-avail', 'tl-buffer', 'tl-progress', 'tl-thumb', 'tl-tip',
      'toast', 'toast-text', 'toast-btn'].forEach(function (id) { els[id] = U.byId(id); });

    video.addEventListener('playing', function () {
      recoveries = 0;
      hideOverlay();
      calibrate();
      updatePlayButton();
      scheduleHide();
    });
    video.addEventListener('pause', function () {
      updatePlayButton();
      showControls();
    });
    video.addEventListener('play', updatePlayButton);
    video.addEventListener('loadedmetadata', applyAspect);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('error', function () {
      // с hls.js ошибки приходят через его события
      if (session && !hls) fail('Браузер не смог воспроизвести поток. Выберите hls.js в настройках или откройте внешний плеер (↗).', retry);
    });

    overlay.addEventListener('click', function () {
      if (overlay.getAttribute('data-mode') === 'tap') resume();
    });
    overlayBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (overlay.getAttribute('data-mode') === 'tap') resume();
      else if (retry) retry();
    });

    bindButton('ctl-play', togglePlay);
    bindButton('ctl-back', function () { seekBy(-SEEK_STEP); });
    bindButton('ctl-fwd', function () { seekBy(SEEK_STEP); });
    bindButton('ctl-prev', function () { if (handlers.onPrevChannel) handlers.onPrevChannel(); });
    bindButton('ctl-next', function () { if (handlers.onNextChannel) handlers.onNextChannel(); });
    bindButton('ctl-live', goLive);
    bindButton('ctl-aspect', cycleAspect);
    bindButton('ctl-fs', toggleFullscreen);

    bindGestures();
    bindTimeline();
    bindKeyboard();

    window.addEventListener('resize', function () { setTimeout(applyAspect, 50); });
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('webkitfullscreenchange', syncFullscreen);
    setInterval(renderTimeline, 1000);   // для эфира таймлайн движется и на паузе

    document.addEventListener('touchend', unlock, true);
    document.addEventListener('click', unlock, true);
    applyAspect();
    showOverlay('idle', 'Выберите канал');
  }

  function bindButton(id, action) {
    els[id].addEventListener('click', function (e) {
      e.stopPropagation();
      action();
      if (session) showControls();
    });
  }

  /**
   * Старые Chrome на Android разрешают video.play() без касания, только если
   * этот элемент уже запускали внутри жеста пользователя. Делаем такой вызов
   * при первом касании страницы — дальше каналы стартуют сами.
   */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    document.removeEventListener('touchend', unlock, true);
    document.removeEventListener('click', unlock, true);
    if (session) return;
    try {
      var p = video.play();
      if (p && p.then) p.then(null, function () {});
      video.pause();
    } catch (e) {
      // не страшно
    }
  }

  // ---------- Слой ошибок и загрузки ----------

  // mode: idle — подсказка; loading — крутилка; tap — «нажмите, чтобы смотреть»; error — ошибка
  function showOverlay(mode, text) {
    overlay.className = 'overlay overlay-' + mode;
    overlay.setAttribute('data-mode', mode);
    overlayText.textContent = text || '';
    overlayBtn.textContent = mode === 'tap' ? '▶ Смотреть' : 'Повторить';
    U.setVisible(overlayBtn, mode === 'tap' || (mode === 'error' && !!retry));
    if (mode !== 'loading') hideControls(true);
  }

  function hideOverlay() {
    overlay.className = 'overlay hidden';
    overlay.setAttribute('data-mode', '');
  }

  // ---------- Воспроизведение ----------

  function tryPlay() {
    var p;
    try {
      p = video.play();
    } catch (e) {
      p = null;
    }
    // старые браузеры возвращают undefined; .then(null, …) вместо .catch — для старых движков
    if (p && typeof p.then === 'function') {
      p.then(null, function (err) {
        if (err && err.name === 'NotAllowedError') showOverlay('tap', 'Нажмите, чтобы смотреть');
      });
    }
  }

  function resume() {
    hideOverlay();
    tryPlay();
  }

  function togglePlay() {
    if (!session) return;
    if (video.paused) tryPlay();
    else video.pause();
  }

  function updatePlayButton() {
    els['ctl-play'].className = 'ctl-btn ctl-play' + (video.paused ? '' : ' is-playing');
  }

  function stopPlayback() {
    session = null;
    if (hls) {
      hls.destroy();
      hls = null;
    }
    try {
      video.pause();
    } catch (e) {
      // уже остановлен
    }
    if (video.hasAttribute('src')) {
      video.removeAttribute('src');
      try {
        video.load();
      } catch (e) {
        // нечего сбрасывать
      }
    }
  }

  function describeError(data) {
    var D = window.Hls.ErrorDetails;
    var code = data.response && data.response.code;
    if (data.details === D.MANIFEST_LOAD_ERROR || data.details === D.MANIFEST_LOAD_TIMEOUT || data.details === D.LEVEL_LOAD_ERROR) {
      if (code === 401 || code === 403) return 'Доступ к потоку запрещён (' + code + '). Проверьте подписку и ключ.';
      if (code === 404) return 'Поток не найден (404). Канал недоступен или запись в архиве отсутствует.';
      if (code === 502) return 'Сервер провайдера недоступен. Проверьте интернет.';
      return 'Не удалось загрузить поток' + (code ? ' (' + code + ')' : '') + '.';
    }
    if (data.details === D.MANIFEST_PARSING_ERROR) return 'Провайдер вернул некорректный плейлист потока.';
    if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
      return 'Ошибка декодирования видео. Попробуйте встроенный плеер в настройках или внешний плеер (↗).';
    }
    return 'Ошибка воспроизведения: ' + data.details;
  }

  function onHlsError(event, data) {
    if (!data || !data.fatal || !hls) return;
    var Hls = window.Hls;
    var manifestFailed = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
      data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
      data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;

    // Сначала пытаемся восстановиться сами: сеть мигнула или декодер споткнулся.
    if (!manifestFailed && recoveries < MAX_RECOVERIES) {
      recoveries++;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (recoveries > 1) hls.swapAudioCodec();
        hls.recoverMediaError();
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }
    }
    fail(describeError(data), retry);
  }

  /** Если провайдер пишет в плейлист EXT-X-PROGRAM-DATE-TIME — берём точное время эфира из него. */
  function onFragChanged(event, data) {
    var frag = data && data.frag;
    if (!session || !frag || !frag.programDateTime) return;
    var abs = frag.programDateTime / 1000 + (video.currentTime - frag.start);
    var expected = session.baseVt !== null ? position() : (session.live ? U.now() : session.startAbs);
    if (Math.abs(abs - expected) > 3600) return;   // явно чужие метки времени — не доверяем
    session.baseVt = frag.start;
    session.baseAbs = frag.programDateTime / 1000;
  }

  /**
   * Запускает HLS-поток.
   *   opts.live        — прямой эфир (иначе архив)
   *   opts.startAbs    — для архива: Unix-время, с которого начинается поток
   *   opts.windowStart, opts.windowStop — границы таймлайна (обычно передача)
   *   opts.timeshift   — можно перематываться за пределы буфера (у канала есть архив)
   *   opts.title       — заголовок в полноэкранном режиме
   */
  function play(url, opts) {
    opts = opts || {};
    stopPlayback();
    session = {
      live: !!opts.live,
      startAbs: opts.startAbs || 0,
      windowStart: opts.windowStart || 0,
      windowStop: opts.windowStop || 0,
      timeshift: !!opts.timeshift,
      baseAbs: null,
      baseVt: null,
      lastTick: 0
    };
    recoveries = 0;
    retry = function () { play(url, opts); };
    els['ctl-title'].textContent = opts.title || '';
    showOverlay('loading', '');

    var Hls = window.Hls;
    var hlsOk = !!(Hls && Hls.isSupported());
    var nativeOk = !!video.canPlayType('application/vnd.apple.mpegurl');
    var preferNative = U.storage.get('engine', 'hls') === 'native';

    if (hlsOk && !(preferNative && nativeOk)) {
      hls = new Hls(HLS_CONFIG);
      hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
      hls.on(Hls.Events.ERROR, onHlsError);
      hls.on(Hls.Events.FRAG_CHANGED, onFragChanged);
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (nativeOk) {
      video.src = url;
      tryPlay();
    } else {
      fail('Браузер не умеет воспроизводить HLS. Обновите Chrome или откройте поток во внешнем плеере (↗).', null);
      return;
    }
    renderTimeline();
    showControls();
  }

  /** Останавливает поток и показывает крутилку — пока сервер готовит ссылку. */
  function loading() {
    stopPlayback();
    retry = null;
    showOverlay('loading', '');
  }

  /** Ошибка с кнопкой «Повторить» (если передано действие). */
  function fail(message, retryAction) {
    stopPlayback();
    retry = retryAction || null;
    showOverlay('error', message);
  }

  function pause() {
    try {
      video.pause();
    } catch (e) {
      // нечего ставить на паузу
    }
  }

  // ---------- Время эфира и перемотка ----------

  /** Привязка секунд видео к времени эфира — в момент старта воспроизведения. */
  function calibrate() {
    if (!session || session.baseVt !== null) return;
    session.baseVt = video.currentTime;
    if (session.live) {
      var range = seekRange();
      var behind = range ? Math.max(0, range[1] - video.currentTime) : 0;
      session.baseAbs = U.now() - behind;
    } else {
      session.baseAbs = session.startAbs;
    }
  }

  /** Текущая позиция — Unix-время эфира, которое сейчас на экране. */
  function position() {
    if (!session) return 0;
    if (session.baseVt === null) return session.live ? U.now() : session.startAbs;
    return session.baseAbs + (video.currentTime - session.baseVt);
  }

  /** Диапазон, куда можно перемотаться внутри уже загруженного потока (секунды видео). */
  function seekRange() {
    var s = video.seekable;
    if (s && s.length && isFinite(s.end(s.length - 1)) && s.end(s.length - 1) > 0) return [s.start(0), s.end(s.length - 1)];
    var b = video.buffered;
    if (b && b.length) return [b.start(0), b.end(b.length - 1)];
    return null;
  }

  function canSeek() {
    return !!session && (session.timeshift || !!seekRange());
  }

  function isAtLive() {
    return !!session && session.live && U.now() - position() < 30;
  }

  function seekTo(abs) {
    if (!session) return;
    var now = U.now();
    if (abs >= now - 3) {   // догнали эфир
      goLive();
      return;
    }
    var range = seekRange();
    if (session.baseVt !== null && range) {
      var vt = session.baseVt + (abs - session.baseAbs);
      if (vt >= range[0] && vt <= range[1] - 0.5) {
        video.currentTime = vt;
        renderTimeline();
        return;
      }
      if (!session.timeshift) {   // архива нет — перематываемся, насколько позволяет буфер
        video.currentTime = clamp(vt, range[0], range[1] - 0.5);
        return;
      }
    }
    if (session.timeshift && handlers.onRestart) handlers.onRestart(Math.floor(abs));
  }

  function seekBy(sec) {
    if (!session) return;
    if (!canSeek()) {
      osd('Перемотка недоступна', null);
      return;
    }
    osd((sec < 0 ? '« ' : '» ') + delta(sec), null);
    seekTo(position() + sec);
  }

  function goLive() {
    if (!session) return;
    if (session.live) {
      if (hls && hls.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
      else {
        var range = seekRange();
        if (range) video.currentTime = Math.max(range[0], range[1] - 6);
      }
      if (video.paused) tryPlay();
    } else if (handlers.onLive) {
      handlers.onLive();
    }
  }

  /** Границы таймлайна: передача, а если её нет — последний час эфира / час с начала архива. */
  function windowRange() {
    var s = session;
    var now = U.now();
    var pos = position();
    var start = s.windowStart;
    var stop = s.windowStop;
    if (!start || !stop || stop <= start) {
      if (s.live) {
        start = now - 3600;
        stop = now;
      } else {
        start = s.startAbs;
        stop = s.startAbs + 3600;
      }
    }
    if (pos > stop) stop = pos;
    if (pos < start) start = pos;
    return [start, stop];
  }

  function setWindow(start, stop, title) {
    if (!session) return;
    session.windowStart = start;
    session.windowStop = stop;
    if (title) els['ctl-title'].textContent = title;
    renderTimeline();
  }

  function onTimeUpdate() {
    renderTimeline();
    if (!session || session.baseVt === null) return;
    var now = Date.now();
    if (now - session.lastTick < 1000) return;
    session.lastTick = now;
    if (handlers.onTime) handlers.onTime(position(), session.live);
  }

  function renderTimeline() {
    if (!session || drag) return;
    var w = windowRange();
    var len = Math.max(1, w[1] - w[0]);
    var pos = position();
    var f = (pos - w[0]) / len;
    setWidth(els['tl-progress'], f);
    setWidth(els['tl-avail'], (Math.min(U.now(), w[1]) - w[0]) / len);
    var b = video.buffered;
    if (session.baseVt !== null && b && b.length) {
      setWidth(els['tl-buffer'], (session.baseAbs + (b.end(b.length - 1) - session.baseVt) - w[0]) / len);
    } else {
      setWidth(els['tl-buffer'], 0);
    }
    els['tl-thumb'].style.left = (clamp(f, 0, 1) * 100).toFixed(2) + '%';
    els['ctl-time'].textContent = clock(pos) + ' / ' + U.fmtTime(w[1]);
    els.timeline.className = 'timeline' + (canSeek() ? '' : ' disabled');
    U.setVisible(els['ctl-live'], session.live || session.timeshift);
    els['ctl-live'].className = 'ctl-chip ctl-live' + (isAtLive() ? ' at-live' : '') + (session.live || session.timeshift ? '' : ' hidden');
  }

  // ---------- Таймлайн ----------

  function bindTimeline() {
    var tl = els.timeline;
    function x(e) {
      return e.touches && e.touches.length ? e.touches[0].clientX : e.changedTouches && e.changedTouches.length ? e.changedTouches[0].clientX : e.clientX;
    }
    on(tl, 'touchstart', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragStart(x(e));
    });
    on(tl, 'touchmove', function (e) {
      e.preventDefault();
      dragMove(x(e));
    });
    on(tl, 'touchend', function (e) {
      e.preventDefault();
      dragEnd();
    });
    on(tl, 'touchcancel', function () { dragEnd(); });
    tl.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragStart(e.clientX);
      function move(ev) { dragMove(ev.clientX); }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        dragEnd();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function dragStart(clientX) {
    if (!canSeek()) return;
    drag = { from: position(), abs: position() };
    els.timeline.className = 'timeline dragging';
    U.setVisible(els['tl-tip'], true);
    clearTimeout(hideTimer);
    dragMove(clientX);
  }

  function dragMove(clientX) {
    if (!drag) return;
    var r = els.timeline.getBoundingClientRect();
    var f = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
    var w = windowRange();
    drag.abs = Math.min(w[0] + f * (w[1] - w[0]), U.now());
    f = (drag.abs - w[0]) / Math.max(1, w[1] - w[0]);
    setWidth(els['tl-progress'], f);
    els['tl-thumb'].style.left = (f * 100).toFixed(2) + '%';
    els['tl-tip'].style.left = (clamp(f, 0.08, 0.92) * 100).toFixed(2) + '%';
    els['tl-tip'].textContent = clock(drag.abs) + '  ' + delta(drag.abs - drag.from);
  }

  function dragEnd() {
    if (!drag) return;
    var target = drag.abs;
    drag = null;
    els.timeline.className = 'timeline';
    U.setVisible(els['tl-tip'], false);
    seekTo(target);
    scheduleHide();
  }

  // ---------- Жесты ----------

  /** Касание началось на кнопке плеера? Тогда простое нажатие — это нажатие кнопки, а свайп — всё равно жест. */
  function onButton(node) {
    while (node && node !== box) {
      if (node.tagName === 'BUTTON') return true;
      node = node.parentNode;
    }
    return false;
  }

  function bindGestures() {
    // Слушаем весь плеер: свайп, начатый поверх кнопок, тоже работает.
    on(box, 'touchstart', function (e) {
      if (e.touches.length !== 1 || overlay.getAttribute('data-mode') === 'tap') return;
      var button = onButton(e.target);
      if (!button) e.preventDefault();
      gestureStart(e.touches[0].clientX, e.touches[0].clientY, button);
    });
    on(box, 'touchmove', function (e) {
      if (!gesture) return;
      e.preventDefault();
      gestureMove(e.touches[0].clientX, e.touches[0].clientY);
    });
    on(box, 'touchend', function (e) {
      if (!gesture) return;
      if (!gesture.button || gesture.mode) e.preventDefault();
      gestureEnd();
    });
    on(box, 'touchcancel', function () { gesture = null; });
    // мышь (компьютер): щелчок — показать/скрыть, двойной — во весь экран
    els.gesture.addEventListener('click', function () { toggleControls(); });
    els.gesture.addEventListener('dblclick', toggleFullscreen);
    player.addEventListener('mousemove', function () { if (session && !drag) showControls(); });
  }

  function gestureStart(x, y, button) {
    var r = box.getBoundingClientRect();
    gesture = {
      x0: x, y0: y, w: r.width, h: r.height, rx: (x - r.left) / r.width, button: button,
      mode: null, target: null, volume: getVolume(), brightness: getBrightness(), from: position()
    };
  }

  function gestureMove(x, y) {
    var g = gesture;
    var dx = x - g.x0;
    var dy = y - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
      if (Math.abs(dx) > Math.abs(dy)) g.mode = session && canSeek() ? 'seek' : 'none';
      else g.mode = g.rx < 0.5 ? 'brightness' : 'volume';
    }
    if (g.mode === 'seek') {
      var sec = dx / g.w * SWIPE_SECONDS;
      g.target = Math.min(g.from + sec, U.now());
      osd(delta(g.target - g.from) + '  ·  ' + clock(g.target), null);
    } else if (g.mode === 'volume') {
      var v = clamp(g.volume - dy / (g.h * 0.8), 0, 1);
      setVolume(v);
      osd('Громкость ' + Math.round(v * 100) + '%', v);
    } else if (g.mode === 'brightness') {
      var b = clamp(g.brightness - dy / (g.h * 0.8), 0.05, 1);
      setBrightness(b);
      osd('Яркость ' + Math.round(b * 100) + '%', b);
    }
  }

  function gestureEnd() {
    var g = gesture;
    gesture = null;
    if (!g) return;
    if (g.mode === 'seek' && g.target !== null) seekTo(g.target);
    else if (!g.mode && !g.button) tap(g.rx);
  }

  /** Одно касание — показать/скрыть кнопки; двойное слева/справа — ∓10 с (как в MX Player). */
  function tap(rx) {
    var now = Date.now();
    var side = rx < 0.35 ? -1 : rx > 0.65 ? 1 : 0;
    if (lastTap && now - lastTap.t < 300 && side && side === lastTap.side) {
      clearTimeout(tapTimer);
      lastTap = null;
      seekBy(side * SEEK_STEP);
      return;
    }
    lastTap = { t: now, side: side };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () {
      lastTap = null;
      toggleControls();
    }, 280);
  }

  function getVolume() {
    try {
      if (native && native.getVolume) return +native.getVolume();
    } catch (e) {
      // нет моста — громкость самого видео
    }
    return video.muted ? 0 : video.volume;
  }

  function setVolume(v) {
    try {
      if (native && native.setVolume) {
        native.setVolume(v);
        return;
      }
    } catch (e) {
      // нет моста — громкость самого видео
    }
    video.muted = false;
    video.volume = v;
  }

  function getBrightness() {
    try {
      if (native && native.getBrightness) return +native.getBrightness();
    } catch (e) {
      // нет моста — затемнение
    }
    return 1 - dimLevel / 0.85;
  }

  function setBrightness(b) {
    try {
      if (native && native.setBrightness) {
        native.setBrightness(b);
        return;
      }
    } catch (e) {
      // нет моста — затемнение
    }
    // браузер не может менять яркость экрана — затемняем картинку
    dimLevel = (1 - b) * 0.85;
    els.dimmer.style.opacity = dimLevel.toFixed(2);
  }

  /** Подсказка по центру экрана: «Громкость 40%», «+0:35 · 20:45:10». */
  function osd(text, level) {
    els['osd-text'].textContent = text;
    var bar = els['osd-fill'].parentNode;
    U.setVisible(bar, level !== null && level !== undefined);
    if (level !== null && level !== undefined) setWidth(els['osd-fill'], level);
    U.setVisible(els.osd, true);
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { U.setVisible(els.osd, false); }, 900);
  }

  // ---------- Масштаб ----------

  function aspectLabel(mode) {
    for (var i = 0; i < ASPECTS.length; i++) if (ASPECTS[i][0] === mode) return ASPECTS[i][1];
    return ASPECTS[0][1];
  }

  /** Оригинал — вписать; Растянуть — на весь экран с искажением; Обрезать — заполнить с обрезкой; 16:9 и 4:3 — принудительно. */
  function applyAspect() {
    var vs = video.style;
    var ratio = aspect === '16:9' ? 16 / 9 : aspect === '4:3' ? 4 / 3 : 0;
    vs.left = '0';
    vs.top = '0';
    vs.width = '100%';
    vs.height = '100%';
    vs.objectFit = aspect === 'fill' ? 'fill' : aspect === 'crop' ? 'cover' : 'contain';
    if (ratio) {
      var bw = box.clientWidth;
      var bh = box.clientHeight;
      if (bw && bh) {
        var w = bw;
        var h = bh;
        if (w / h > ratio) w = h * ratio;
        else h = w / ratio;
        vs.width = Math.round(w) + 'px';
        vs.height = Math.round(h) + 'px';
        vs.left = Math.round((bw - w) / 2) + 'px';
        vs.top = Math.round((bh - h) / 2) + 'px';
        vs.objectFit = 'fill';
      }
    }
    els['ctl-aspect'].textContent = aspectLabel(aspect);
  }

  function cycleAspect() {
    var i = 0;
    while (i < ASPECTS.length && ASPECTS[i][0] !== aspect) i++;
    aspect = ASPECTS[(i + 1) % ASPECTS.length][0];
    U.storage.set('aspect', aspect);
    applyAspect();
    osd('Масштаб: ' + aspectLabel(aspect), null);
  }

  // ---------- Полноэкранный режим ----------

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement) || player.className.indexOf('pseudo-fs') !== -1;
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      exitFullscreen();
      return;
    }
    var request = player.requestFullscreen || player.webkitRequestFullscreen || player.webkitRequestFullScreen;
    if (!request) {
      pseudoFullscreen();
      return;
    }
    try {
      var result = request.call(player);
      if (result && result.then) result.then(lockLandscape, pseudoFullscreen);
      else setTimeout(function () { if (!isFullscreen()) pseudoFullscreen(); else lockLandscape(); }, 400);
    } catch (e) {
      pseudoFullscreen();
    }
  }

  /** Если настоящий полноэкранный режим недоступен — растягиваем плеер на всё окно. */
  function pseudoFullscreen() {
    player.classList.add('pseudo-fs');
    syncFullscreen();
  }

  function exitFullscreen() {
    if (player.className.indexOf('pseudo-fs') !== -1) {
      player.classList.remove('pseudo-fs');
      syncFullscreen();
      return;
    }
    var exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
    if (exit) {
      try {
        exit.call(document);
      } catch (e) {
        // уже вышли
      }
    }
  }

  function lockLandscape() {
    try {
      var o = window.screen && window.screen.orientation;
      if (o && o.lock) o.lock('landscape').then(null, function () {});
    } catch (e) {
      // ориентацию менять нельзя — не страшно
    }
  }

  function syncFullscreen() {
    if (isFullscreen()) player.classList.add('fs');
    else player.classList.remove('fs');
    els['ctl-fs'].className = 'ctl-btn ctl-small' + (isFullscreen() ? ' is-fs' : '');
    setTimeout(applyAspect, 100);
    setTimeout(applyAspect, 500);
  }

  // ---------- Показ элементов управления ----------

  function showControls() {
    if (!session) return;
    controls.classList.remove('ctl-hidden');
    renderTimeline();
    scheduleHide();
  }

  function hideControls(force) {
    if (drag && !force) return;
    controls.classList.add('ctl-hidden');
  }

  function toggleControls() {
    if (controls.className.indexOf('ctl-hidden') !== -1) showControls();
    else hideControls();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (session && !video.paused) hideControls();
    }, HIDE_DELAY);
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (!session || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var key = e.keyCode;
      if (key === 32) togglePlay();                  // пробел
      else if (key === 37) seekBy(-SEEK_STEP);       // ←
      else if (key === 39) seekBy(SEEK_STEP);        // →
      else if (key === 70) toggleFullscreen();       // F
      else return;
      e.preventDefault();
      showControls();
    });
  }

  /** Короткое сообщение внизу плеера, при желании с кнопкой. */
  function toast(text, actionLabel, action) {
    els['toast-text'].textContent = text;
    U.setVisible(els['toast-btn'], !!actionLabel);
    els['toast-btn'].textContent = actionLabel || '';
    els['toast-btn'].onclick = function (e) {
      e.stopPropagation();
      U.setVisible(els.toast, false);
      if (action) action();
    };
    U.setVisible(els.toast, true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { U.setVisible(els.toast, false); }, 7000);
  }

  MD.player = {
    init: init,
    play: play,
    loading: loading,
    fail: fail,
    pause: pause,
    position: function () { return session ? position() : 0; },
    setWindow: setWindow,
    toast: toast,
    isFullscreen: isFullscreen,
    exitFullscreen: exitFullscreen
  };
})(window, document);
