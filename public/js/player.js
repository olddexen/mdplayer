/* mdplayer: видеоплеер — HTML5 <video> + hls.js 0.14 (стабильная ветка для старых Android). */
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
    liveBackBufferLength: 30,
    liveSyncDurationCount: 3,
    manifestLoadingTimeOut: 15000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 15000,
    levelLoadingMaxRetry: 4,
    fragLoadingTimeOut: 25000,
    fragLoadingMaxRetry: 6
  };
  var MAX_RECOVERIES = 3;

  var video, overlay, overlayText, overlayBtn;
  var hls = null;
  var playing = false;     // есть ли сейчас источник в плеере
  var retry = null;        // действие для кнопки «Повторить»
  var recoveries = 0;
  var unlocked = false;

  function init() {
    video = U.byId('video');
    overlay = U.byId('overlay');
    overlayText = U.byId('overlay-text');
    overlayBtn = U.byId('overlay-btn');

    // Свои кнопки и крутилка — пока поток не пошёл; дальше — стандартные кнопки плеера
    // (пауза, громкость, во весь экран). Так две крутилки не накладываются друг на друга.
    video.addEventListener('playing', function () {
      recoveries = 0;
      video.controls = true;
      hideOverlay();
    });
    video.addEventListener('error', function () {
      // с hls.js ошибки приходят через его события
      if (playing && !hls) fail('Браузер не смог воспроизвести поток. Выберите hls.js в настройках или откройте внешний плеер (↗).', retry);
    });
    overlay.addEventListener('click', function () {
      if (overlay.getAttribute('data-mode') === 'tap') resume();
    });
    overlayBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (overlay.getAttribute('data-mode') === 'tap') resume();
      else if (retry) retry();
    });

    document.addEventListener('touchend', unlock, true);
    document.addEventListener('click', unlock, true);
    showOverlay('idle', 'Выберите канал');
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
    if (playing) return;
    try {
      var p = video.play();
      if (p && p.then) p.then(null, function () {});
      video.pause();
    } catch (e) {
      // не страшно
    }
  }

  // mode: idle — подсказка; loading — крутилка; tap — «нажмите, чтобы смотреть»; error — ошибка
  function showOverlay(mode, text) {
    video.controls = false;
    overlay.className = 'overlay overlay-' + mode;
    overlay.setAttribute('data-mode', mode);
    overlayText.textContent = text || '';
    overlayBtn.textContent = mode === 'tap' ? '▶ Смотреть' : 'Повторить';
    U.setVisible(overlayBtn, mode === 'tap' || (mode === 'error' && !!retry));
  }

  function hideOverlay() {
    overlay.className = 'overlay hidden';
    overlay.setAttribute('data-mode', '');
  }

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

  function stopPlayback() {
    playing = false;
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

  /** Запускает HLS-поток по ссылке. */
  function play(url, title) {
    stopPlayback();
    playing = true;
    recoveries = 0;
    retry = function () { play(url, title); };
    showOverlay('loading', '');

    var Hls = window.Hls;
    var hlsOk = !!(Hls && Hls.isSupported());
    var nativeOk = !!video.canPlayType('application/vnd.apple.mpegurl');
    var preferNative = U.storage.get('engine', 'hls') === 'native';

    if (hlsOk && !(preferNative && nativeOk)) {
      hls = new Hls(HLS_CONFIG);
      hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
      hls.on(Hls.Events.ERROR, onHlsError);
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (nativeOk) {
      video.src = url;
      tryPlay();
    } else {
      fail('Браузер не умеет воспроизводить HLS. Обновите Chrome или откройте поток во внешнем плеере (↗).', null);
    }
    if (title) video.setAttribute('title', title);
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

  MD.player = { init: init, play: play, loading: loading, fail: fail, pause: pause };
})(window, document);
