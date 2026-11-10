'use strict';
/**
 * Отдельный поток для сборки программы передач (см. lib/epg-build.js).
 * Сообщения родителю: { type: 'progress', state, fraction, message }, { type: 'done', result }, { type: 'error', message }.
 */
const { parentPort, workerData } = require('worker_threads');
const { build } = require('./epg-build');

let last = 0;
build(workerData, (state, fraction, message) => {
  const now = Date.now();
  if (now - last < 300 && fraction < 1) return;   // не засыпаем родителя сообщениями
  last = now;
  parentPort.postMessage({ type: 'progress', state, fraction, message });
})
  .then((result) => parentPort.postMessage({ type: 'done', result }))
  .catch((err) => parentPort.postMessage({ type: 'error', message: err.message }));
