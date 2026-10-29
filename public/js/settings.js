/* mdplayer: окно настроек — источник плейлиста, EPG, прокси, выбор плеера и состояние сервера. */
(function (window, document) {
  'use strict';

  var MD = window.MD;
  var U = MD.util;

  var root, closeBtn, intro, fieldUrl, fieldFile, urlInput, fileInput, fileNameEl;
  var epgInput, proxyInput, engineSelect, errorEl, statusEl, saveBtn, refreshPlaylistBtn, refreshEpgBtn;
  var onChange = function () {};
  var lastState = null;

  function init(options) {
    onChange = options.onChange;
    root = U.byId('settings');
    closeBtn = U.byId('settings-close');
    intro = U.byId('settings-intro');
    fieldUrl = U.byId('field-url');
    fieldFile = U.byId('field-file');
    urlInput = U.byId('cfg-url');
    fileInput = U.byId('cfg-file');
    fileNameEl = U.byId('cfg-file-name');
    epgInput = U.byId('cfg-epg');
    proxyInput = U.byId('cfg-proxy');
    engineSelect = U.byId('cfg-engine');
    errorEl = U.byId('settings-error');
    statusEl = U.byId('settings-status');
    saveBtn = U.byId('settings-save');
    refreshPlaylistBtn = U.byId('refresh-playlist');
    refreshEpgBtn = U.byId('refresh-epg');

    var radios = root.querySelectorAll('input[name="source"]');
    for (var i = 0; i < radios.length; i++) radios[i].addEventListener('change', updateSourceFields);
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileNameEl.textContent = file ? file.name : '';
    });
    urlInput.addEventListener('keydown', function (e) {
      if (e.keyCode === 13) save();
    });
    engineSelect.addEventListener('change', function () {
      U.storage.set('engine', engineSelect.value);
    });
    closeBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', save);
    refreshPlaylistBtn.addEventListener('click', function () { refresh('playlist', refreshPlaylistBtn); });
    refreshEpgBtn.addEventListener('click', function () { refresh('epg', refreshEpgBtn); });
  }

  function source() {
    var checked = root.querySelector('input[name="source"]:checked');
    return checked ? checked.value : 'url';
  }

  function updateSourceFields() {
    var isFile = source() === 'file';
    U.setVisible(fieldUrl, !isFile);
    U.setVisible(fieldFile, isFile);
  }

  /** required — первый запуск: закрыть окно без плейлиста нельзя. */
  function open(state, required) {
    U.setVisible(closeBtn, !required);
    U.setVisible(intro, !!required);
    U.setVisible(errorEl, false);
    if (state) fill(state);
    U.setVisible(root, true);
  }

  function close() {
    if (!lastState || !lastState.configured) return;
    U.setVisible(root, false);
  }

  function fill(state) {
    var c = state.config;
    var src = c.playlistSource === 'file' ? 'file' : 'url';
    root.querySelector('input[name="source"][value="' + src + '"]').checked = true;
    urlInput.value = c.playlistUrl || '';
    epgInput.value = c.epgUrl || '';
    proxyInput.checked = c.proxy !== false;
    engineSelect.value = U.storage.get('engine', 'hls');
    fileInput.value = '';
    fileNameEl.textContent = c.playlistFileName ? 'Сейчас: ' + c.playlistFileName : '';
    updateSourceFields();
    updateStatus(state);
  }

  function fmtDate(ms) {
    return ms ? U.dayLabel(ms / 1000) + ' ' + U.fmtTime(ms / 1000) : '—';
  }

  function addRow(label, text, bad) {
    var row = U.el('div', 'status-row' + (bad ? ' bad' : ''));
    if (label) row.appendChild(U.el('b', null, label + ': '));
    row.appendChild(document.createTextNode(text));
    statusEl.appendChild(row);
  }

  /** Состояние плейлиста и EPG на сервере. */
  function updateStatus(state) {
    lastState = state;
    var pl = state.playlist;
    var epg = state.epg;
    U.clear(statusEl);

    if (pl.count) {
      addRow('Плейлист', pl.count + ' каналов, ' + pl.groups + ' категорий · ' + fmtDate(pl.updatedAt), false);
      if (pl.message) addRow('', pl.message, true);
    } else {
      addRow('Плейлист', pl.state === 'loading' ? 'загрузка…' : pl.message || 'не загружен', pl.state === 'error');
    }

    if (epg.state === 'download' || epg.state === 'parse') {
      addRow('Программа', (epg.message || 'Загрузка') + (epg.progress ? ' (' + epg.progress + '%)' : '') + '…', false);
    } else if (epg.state === 'ready') {
      addRow('Программа', epg.matched + ' из ' + pl.count + ' каналов с программой · ' + fmtDate(epg.updatedAt), false);
      if (epg.error) addRow('', 'Последнее обновление не удалось: ' + epg.error, true);
      else if (!epg.matched && pl.count) addRow('', 'Ни один канал не сопоставлен с EPG — укажите другую ссылку на программу', true);
    } else {
      addRow('Программа', epg.message || 'не загружена', epg.state === 'error');
    }
    addRow('Источник EPG', epg.url || (epg.sources || []).join(', ') || '—', false);
  }

  function showError(text) {
    errorEl.textContent = text;
    U.setVisible(errorEl, true);
  }

  function setBusy(busy) {
    saveBtn.disabled = busy;
    saveBtn.textContent = busy ? 'Загрузка плейлиста…' : 'Сохранить';
  }

  function save() {
    var src = source();
    var payload = { playlistSource: src, epgUrl: epgInput.value.trim(), proxy: proxyInput.checked };
    U.storage.set('engine', engineSelect.value);
    U.setVisible(errorEl, false);

    if (src === 'url') {
      payload.playlistUrl = urlInput.value.trim();
      if (!/^https?:\/\//i.test(payload.playlistUrl)) {
        showError('Вставьте ссылку на плейлист, начинающуюся с http:// или https://');
        return;
      }
      send(payload);
      return;
    }

    var file = fileInput.files && fileInput.files[0];
    if (!file) {
      // файл уже загружали раньше — сохраняем остальные настройки
      if (lastState && lastState.configured && lastState.config.playlistSource === 'file') send(payload);
      else showError('Выберите файл плейлиста (.m3u или .m3u8)');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      showError('Файл слишком большой для плейлиста');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      payload.playlistContent = String(reader.result);
      payload.playlistFileName = file.name;
      send(payload);
    };
    reader.onerror = function () {
      showError('Не удалось прочитать файл');
    };
    reader.readAsText(file, 'utf-8');
  }

  function send(payload) {
    setBusy(true);
    MD.api.saveConfig(payload, function (err, state) {
      setBusy(false);
      if (err) {
        showError(err.message);
        return;
      }
      fill(state);
      close();
      onChange(state);
    });
  }

  function refresh(what, button) {
    button.disabled = true;
    U.setVisible(errorEl, false);
    MD.api.refresh(what, function (err, state) {
      button.disabled = false;
      if (err) {
        showError(err.message);
        return;
      }
      updateStatus(state);
      onChange(state);
    });
  }

  MD.settings = { init: init, open: open, close: close, updateStatus: updateStatus };
})(window, document);
