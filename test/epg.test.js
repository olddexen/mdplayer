'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const store = require('../lib/epg-store');
const { build, createMatcher } = require('../lib/epg-build');
const { EpgManager } = require('../lib/epg');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mdplayer-test-'));
}

const NOW = 1794300000;

function xmltvTime(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}

function sampleXml() {
  const progs = [];
  // «Первый канал»: передачи по часу от 2 суток назад до суток вперёд
  for (let t = NOW - 2 * 86400; t < NOW + 86400; t += 3600) {
    progs.push(`<programme start="${xmltvTime(t)}" stop="${xmltvTime(t + 3600)}" channel="1tv"><title>Передача ${t} «ё»</title><desc>Описание &amp; ${t}\nвторая строка</desc></programme>`);
  }
  progs.push(`<programme start="${xmltvTime(NOW)}" stop="${xmltvTime(NOW + 1800)}" channel="ctc"><title>Ералаш 😀</title></programme>`);
  progs.push(`<programme start="${xmltvTime(NOW)}" stop="${xmltvTime(NOW + 1800)}" channel="unused"><title>Никому</title></programme>`);
  return `<?xml version="1.0"?><tv>
<channel id="1tv"><display-name>Первый канал</display-name><icon src="http://x/1.png"/></channel>
<channel id="ctc"><display-name>CTC</display-name></channel>
<channel id="unused"><display-name>Ненужный</display-name></channel>
${progs.join('\n')}
</tv>`;
}

const CHANNELS = [
  { id: 'a', name: 'Первый канал HD', tvgId: '', tvgName: '', catchupDays: 1 },
  { id: 'b', name: 'СТС', tvgId: '', tvgName: '', catchupDays: 0 },
  { id: 'c', name: 'Неизвестный', tvgId: '', tvgName: '', catchupDays: 0 }
];

async function buildSample(dir, gz) {
  const file = path.join(dir, 'epg-test.raw');
  fs.writeFileSync(file, gz ? zlib.gzipSync(sampleXml()) : sampleXml());
  const result = await build({
    dataDir: dir,
    sources: [{ url: 'http://epg/test.xml.gz', tag: 'tst', file, downloadedAt: 123 }],
    channels: CHANNELS,
    overrides: {},
    key: 'k1',
    now: NOW
  });
  return result;
}

test('сопоставление по названию: HD, латиница/кириллица', () => {
  const match = createMatcher([['1tv', ['Первый канал']], ['ctc', ['CTC']]]);
  assert.strictEqual(match({ name: 'Первый канал HD' }), '1tv');
  assert.strictEqual(match({ name: 'СТС' }), 'ctc');
  assert.strictEqual(match({ name: 'Нет такого' }), null);
});

test('сборка и чтение компактного кэша', async () => {
  const dir = tmpDir();
  const result = await buildSample(dir, true);
  assert.strictEqual(result.matched, 2);
  // архив 1 день: передачи, закончившиеся раньше суток назад, отброшены
  const s = await store.read(dir);
  assert.ok(s);
  assert.strictEqual(s.key, 'k1');
  assert.strictEqual(s.downloadedAt, 123);
  assert.deepStrictEqual(Object.keys(s.links).sort(), ['a', 'b']);
  assert.strictEqual(s.links.a, 'tst:1tv');
  assert.strictEqual(s.channels['tst:1tv'].icon, 'http://x/1.png');
  assert.ok(!s.entries.has('tst:unused'));

  const cur = s.current('tst:1tv', NOW + 10);
  assert.deepStrictEqual(cur, [NOW, NOW + 3600, `Передача ${NOW} «ё»`]);
  assert.deepStrictEqual(s.current('tst:ctc', NOW + 60), [NOW, NOW + 1800, 'Ералаш 😀']);
  assert.strictEqual(s.current('tst:ctc', NOW + 1800), null);
  assert.strictEqual(s.current('tst:1tv', NOW - 5 * 86400), null);

  const list = await s.programmes('tst:1tv', NOW - 3600);
  assert.strictEqual(list[0][0], NOW - 3600);
  assert.strictEqual(list[0][2], `Передача ${NOW - 3600} «ё»`);
  assert.strictEqual(list[0][3], `Описание & ${NOW - 3600} вторая строка`);
  assert.strictEqual(list[list.length - 1][1], NOW + 86400);
  // окно хранения: сутки назад (архив 1 день) … двое суток вперёд
  const all = await s.programmes('tst:1tv', 0);
  assert.ok(all[0][1] > NOW - 86400);
  assert.strictEqual(all.length, 48);
});

test('описания читаются из файла своей сборки, старые файлы удаляются', async () => {
  const dir = tmpDir();
  await buildSample(dir, false);
  const first = await store.read(dir);
  await new Promise((r) => setTimeout(r, 5));
  await buildSample(dir, false);
  const second = await store.read(dir);
  assert.notStrictEqual(first.meta.build, second.meta.build);
  // старое хранилище всё ещё читает свои описания
  const old = await first.programmes('tst:ctc', 0);
  assert.strictEqual(old[0][2], 'Ералаш 😀');
  store.removeStale(dir, second.meta.build);
  await new Promise((r) => setTimeout(r, 50));
  const descs = fs.readdirSync(dir).filter((n) => n.endsWith('.desc'));
  assert.deepStrictEqual(descs, [`epg-v3-${second.meta.build}.desc`]); assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".idx")), [`epg-v3-${second.meta.build}.idx`]);
});

test('повреждённый или устаревший кэш не загружается', async () => {
  const dir = tmpDir();
  assert.strictEqual(await store.read(dir), null);
  fs.writeFileSync(path.join(dir, 'epg-v3.json'), '{"format":2}');
  assert.strictEqual(await store.read(dir), null);
  fs.writeFileSync(path.join(dir, 'epg-v3.json'), 'не json');
  assert.strictEqual(await store.read(dir), null);
});

test('EpgManager: сборка в отдельном потоке, загрузка кэша, поиск', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'epg.json'), '{}');   // кэш версии 1.1 удаляется
  const url = 'http://epg.example/test.xml';
  const { tagOf } = require('../lib/epg');
  fs.writeFileSync(path.join(dir, 'epg-sources.json'), JSON.stringify({ [url]: { downloadedAt: Date.now() } }));

  // передачи вокруг «сейчас», чтобы попасть в окно хранения
  const shift = Math.floor(Date.now() / 1000) - NOW;
  const xml = sampleXml().replace(/(start|stop)="(\d{14}) \+0000"/g, (m, attr, t) => {
    const ts = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12)) / 1000 + shift;
    return `${attr}="${xmltvTime(ts)}"`;
  });
  fs.writeFileSync(path.join(dir, `epg-${tagOf(url)}.raw`), xml);

  const epg = new EpgManager(dir);
  await epg.update([url], CHANNELS, {}, false);
  assert.strictEqual(epg.status.state, 'ready', epg.status.message);
  assert.ok(!fs.existsSync(path.join(dir, 'epg.json')));
  assert.ok(epg.hasProgrammes(CHANNELS[0]));
  assert.ok(!epg.hasProgrammes(CHANNELS[2]));
  assert.ok(epg.currentOf(CHANNELS[0], Math.floor(Date.now() / 1000)));
  assert.strictEqual(epg.iconOf(CHANNELS[0]), 'http://x/1.png');
  assert.match(epg.describe(epg.linkOf(CHANNELS[1])), /^CTC \(epg\.example\)$/);
  assert.strictEqual(epg.search('стс', 5)[0].name, 'CTC');
  assert.strictEqual(epg.publicStatus().matched, 2);

  // второй запуск: кэш подхватывается, повторной сборки нет
  const again = new EpgManager(dir);
  await again.loadCache();
  assert.strictEqual(again.status.state, 'ready');
  const builtAt = again.store.builtAt;
  await again.update([url], CHANNELS, {}, false);
  assert.strictEqual(again.store.builtAt, builtAt);
  const progs = await again.programmesOf(CHANNELS[0], 0);
  assert.ok(progs.length > 0 && progs[0].length === 4);
});
