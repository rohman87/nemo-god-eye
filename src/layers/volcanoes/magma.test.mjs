import assert from 'node:assert/strict';
import test from 'node:test';
import { INDONESIA_VOLCANOES } from './catalog.js';
import {
  MAGMA_LEVELS,
  buildVolcanoSnapshot,
  parseMagmaLevels,
  parseVonaNotices,
  volcanoKey,
  volcanoRowsFromPayload,
} from './magma.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const HOUR = 60 * 60 * 1000;
const LAPORAN = 'https://magma.esdm.go.id/v1/gunung-api/laporan';

const header = (roman, word) =>
  `<a data-toggle="collapse" href="#x">Level ${roman} (${word})</a>`;
const row = (label) =>
  `<tr><td> ${label} <a href="${LAPORAN}/x">Laporan</a></td></tr>`;

const LEVELS_HTML = [
  row('Orphan - Nowhere'),
  header('III', 'Siaga'),
  row('Merapi - Jawa Tengah &amp; DIY'),
  row('Semeru - Jawa Timur'),
  header('II', 'Waspada'),
  row('Lewotobi Laki-laki - Nusa Tenggara Timur'),
  row('Lewotobi Perempuan - Nusa Tenggara Timur'),
  row('Marapi - Sumatera Barat'),
  row('Semeru - Jawa Timur'),
  row('Gunung Fiktif - Papua'),
  header('I', 'Normal'),
  row('Agung - Bali'),
  row('Rinjani &#039;Baru&#039; - Nusa Tenggara Barat'),
  '<td>Not a volcano row <a href="https://example.com/">x</a></td>',
].join('\n');

const notice = (color, code, title, text) => `
<p class="timeline-title">
  <span class="square-10 ${color} mg-r-5 rounded-circle"></span>
  <a href="https://magma.esdm.go.id/vona?code=${code}">${title}</a>
</p>
<p class="timeline-text">${text}</p>`;

test('MAGMA_LEVELS lists the four PVMBG levels', () => {
  assert.deepEqual(
    MAGMA_LEVELS.map(({ level, roman, label }) => [level, roman, label]),
    [
      [1, 'I', 'Normal'],
      [2, 'II', 'Waspada'],
      [3, 'III', 'Siaga'],
      [4, 'IV', 'Awas'],
    ],
  );
  assert.ok(Object.isFrozen(MAGMA_LEVELS));
});

test('volcanoKey keeps only lowercase letters and digits', () => {
  assert.equal(volcanoKey('Lewotobi Laki-laki'), 'lewotobilakilaki');
  assert.equal(volcanoKey(' Ili Lewotolok '), 'ililewotolok');
  assert.equal(volcanoKey(undefined), '');
});

test('parseMagmaLevels groups rows under their level header', () => {
  const rows = parseMagmaLevels(LEVELS_HTML);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.Merapi.level, 3);
  assert.equal(byName.Merapi.province, 'Jawa Tengah & DIY');
  assert.equal(byName.Marapi.level, 2);
  assert.equal(byName.Agung.level, 1);
  assert.equal(byName["Rinjani 'Baru'"].province, 'Nusa Tenggara Barat');
  assert.equal(byName['Lewotobi Laki-laki'].level, 2);
});

test('parseMagmaLevels skips rows before a header and unrelated cells', () => {
  const rows = parseMagmaLevels(LEVELS_HTML);
  assert.ok(!rows.some((r) => r.name === 'Orphan'));
  assert.ok(!rows.some((r) => /Not a volcano/.test(r.name)));
});

test('parseMagmaLevels dedupes by key and keeps the highest level', () => {
  const html = [
    header('II', 'Waspada'),
    row('Semeru - Jawa Timur'),
    header('III', 'Siaga'),
    row('semeru - Jawa Timur'),
    header('I', 'Normal'),
    row('SEMERU - Jawa Timur'),
  ].join('');
  const rows = parseMagmaLevels(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 3);
});

test('parseMagmaLevels returns null for non-strings and rowless pages', () => {
  assert.equal(parseMagmaLevels(null), null);
  assert.equal(parseMagmaLevels(42), null);
  assert.equal(parseMagmaLevels('<html>nothing</html>'), null);
  assert.equal(parseMagmaLevels(row('Orphan - Nowhere')), null);
});

test('parseMagmaLevels caps name and province length', () => {
  const html =
    header('I', 'Normal') + row(`${'N'.repeat(100)} - ${'P'.repeat(100)}`);
  const [one] = parseMagmaLevels(html);
  assert.equal(one.name.length, 60);
  assert.equal(one.province.length, 60);
});

test('parseVonaNotices reads colour, time and text, newest first', () => {
  const html =
    notice(
      'bg-warning',
      'MAR',
      'Marapi - 20261030/1448Z',
      'Eruption at 1448 UTC.',
    ) +
    notice(
      'bg-danger',
      'SMR',
      'Semeru - 20261030/1530Z',
      'Ash &amp; <b>gas</b>.',
    ) +
    notice('bg-success', 'AGU', 'Agung - 20261029/0001Z', 'Quiet.') +
    notice('bg-yellow', 'LEW', 'Lewotobi Laki-laki - 20261030/0101Z', '');
  const notices = parseVonaNotices(html);
  assert.deepEqual(
    notices.map((n) => [n.code, n.color]),
    [
      ['SMR', 'RED'],
      ['MAR', 'ORANGE'],
      ['LEW', 'YELLOW'],
      ['AGU', 'GREEN'],
    ],
  );
  assert.equal(notices[0].issuedAt, Date.UTC(2026, 9, 30, 15, 30));
  assert.equal(notices[0].name, 'Semeru');
  assert.equal(notices[0].text, 'Ash & gas .');
  assert.equal(notices[2].name, 'Lewotobi Laki-laki');
});

test('parseVonaNotices skips unknown colours, bad dates and bad codes', () => {
  const html =
    notice('bg-purple', 'MAR', 'Marapi - 20261030/1448Z', 'a') +
    notice('bg-warning', 'SMR', 'Semeru - 20261340/1530Z', 'b') +
    notice('bg-warning', 'SMR', 'Semeru - 20260230/1530Z', 'b') +
    notice('bg-warning', 'SMR', 'Semeru - 20261030/2560Z', 'b') +
    notice('bg-warning', 'SMR', 'Semeru - not a date', 'b') +
    notice('bg-warning', 'smr', 'Semeru - 20261030/1530Z', 'b') +
    notice('bg-warning', 'AGU', 'Agung - 20261030/1530Z', 'ok');
  const notices = parseVonaNotices(html);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].code, 'AGU');
});

test('parseVonaNotices pairs a title with its own text only', () => {
  const html =
    `<p class="timeline-title"><span class="bg-warning"></span><a href="https://magma.esdm.go.id/vona?code=MAR">Marapi - 20261030/1448Z</a></p>` +
    notice('bg-danger', 'SMR', 'Semeru - 20261030/1500Z', 'Semeru text');
  const notices = parseVonaNotices(html);
  const marapi = notices.find((n) => n.code === 'MAR');
  assert.equal(marapi.text, '');
  assert.equal(notices.find((n) => n.code === 'SMR').text, 'Semeru text');
});

test('parseVonaNotices caps text at 280 characters and items at 50', () => {
  const long = notice(
    'bg-warning',
    'MAR',
    'Marapi - 20261030/1448Z',
    'x'.repeat(500),
  );
  assert.equal(parseVonaNotices(long)[0].text.length, 280);
  const many = Array.from({ length: 60 }, (_, i) =>
    notice(
      'bg-warning',
      'MAR',
      `Marapi - 20261030/${String(i % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}Z`,
      't',
    ),
  ).join('');
  assert.equal(parseVonaNotices(many).length, 50);
  assert.deepEqual(parseVonaNotices('<html></html>'), []);
  assert.deepEqual(parseVonaNotices(null), []);
});

test('buildVolcanoSnapshot joins levels to the catalog', () => {
  const levels = parseMagmaLevels(LEVELS_HTML);
  const snapshot = buildVolcanoSnapshot({ levels, notices: [], now: NOW });
  assert.equal(snapshot.volcanoes.length, INDONESIA_VOLCANOES.length);
  const byId = Object.fromEntries(snapshot.volcanoes.map((v) => [v.id, v]));
  assert.equal(byId.merapi.level, 3);
  assert.equal(byId.merapi.name, 'Merapi');
  assert.equal(byId.lewotobilakilaki.level, 2);
  assert.equal(byId.lewotobiperempuan.level, 2);
  assert.equal(typeof byId.merapi.lat, 'number');
  assert.equal(byId.merapi.vona, null);
  // Catalogued but absent from MAGMA: kept with an unknown level.
  assert.equal(byId.bromo.level, null);
  assert.deepEqual(snapshot.unplaced.sort(), [
    'Gunung Fiktif',
    "Rinjani 'Baru'",
  ]);
  assert.equal(snapshot.noticeCount, 0);
});

test('buildVolcanoSnapshot attaches the latest VONA within 24 hours', () => {
  const notices = [
    {
      code: 'MAR',
      name: 'Marapi',
      color: 'ORANGE',
      issuedAt: NOW - 2 * HOUR,
      text: 'new',
    },
    {
      code: 'MAR',
      name: 'Marapi',
      color: 'RED',
      issuedAt: NOW - 5 * HOUR,
      text: 'older',
    },
    {
      code: 'SMR',
      name: 'Semeru',
      color: 'RED',
      issuedAt: NOW - 24 * HOUR - 1,
      text: 'old',
    },
    {
      code: 'AGU',
      name: 'Agung',
      color: 'GREEN',
      issuedAt: NOW - 24 * HOUR,
      text: 'edge',
    },
  ];
  const { volcanoes, noticeCount } = buildVolcanoSnapshot({
    levels: [],
    notices,
    now: NOW,
  });
  const byId = Object.fromEntries(volcanoes.map((v) => [v.id, v]));
  assert.deepEqual(byId.marapi.vona, {
    color: 'ORANGE',
    issuedAt: NOW - 2 * HOUR,
    text: 'new',
    code: 'MAR',
  });
  assert.equal(byId.semeru.vona, null);
  assert.equal(byId.agung.vona.text, 'edge');
  assert.equal(noticeCount, 4);
});

test('volcanoRowsFromPayload rebuilds a snapshot from a valid body', () => {
  const snapshot = volcanoRowsFromPayload(
    {
      fetchedAt: NOW,
      levels: [{ name: 'Merapi', province: 'Jawa Tengah', level: 3 }],
      notices: [
        {
          code: 'MER',
          name: 'Merapi',
          color: 'ORANGE',
          issuedAt: NOW - HOUR,
          text: 'Eruption',
        },
      ],
    },
    NOW,
  );
  const merapi = snapshot.volcanoes.find((v) => v.id === 'merapi');
  assert.equal(merapi.level, 3);
  assert.equal(merapi.vona.color, 'ORANGE');
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(snapshot.noticesStale, false);
});

test('volcanoRowsFromPayload passes fetchedAt and noticesStale through', () => {
  const stale = volcanoRowsFromPayload(
    { fetchedAt: NOW - HOUR, levels: [], notices: [], noticesStale: true },
    NOW,
  );
  assert.equal(stale.fetchedAt, NOW - HOUR);
  assert.equal(stale.noticesStale, true);
  const bare = volcanoRowsFromPayload(
    { fetchedAt: 'x', levels: [], noticesStale: 'yes' },
    NOW,
  );
  assert.equal(bare.fetchedAt, null);
  assert.equal(bare.noticesStale, false);
});

test('volcanoRowsFromPayload drops bad items and rejects malformed bodies', () => {
  assert.equal(volcanoRowsFromPayload(null, NOW), null);
  assert.equal(volcanoRowsFromPayload([], NOW), null);
  assert.equal(volcanoRowsFromPayload({ levels: 'no' }, NOW), null);
  const snapshot = volcanoRowsFromPayload(
    {
      levels: [
        { name: 'Merapi', province: 'x', level: 3 },
        { name: 'Semeru', province: 'x', level: 5 },
        { name: 'Marapi', province: 'x', level: 2.5 },
        { name: 'Agung', province: 'x', level: '2' },
        { name: '', province: 'x', level: 2 },
        null,
        'bad',
      ],
      notices: [
        {
          code: 'MER',
          name: 'Merapi',
          color: 'PURPLE',
          issuedAt: NOW,
          text: 'a',
        },
        {
          code: 'MER',
          name: 'Merapi',
          color: 'RED',
          issuedAt: NOW + 2 * HOUR,
          text: 'future',
        },
        { code: 'MER', name: 'Merapi', color: 'RED', issuedAt: 'x', text: 'a' },
        { code: 'mer', name: 'Merapi', color: 'RED', issuedAt: NOW, text: 'a' },
        {
          code: 'SMR',
          name: 'Semeru',
          color: 'RED',
          issuedAt: NOW,
          text: 'ok\u0000​'.padEnd(400, 'z'),
        },
      ],
    },
    NOW,
  );
  const byId = Object.fromEntries(snapshot.volcanoes.map((v) => [v.id, v]));
  assert.equal(byId.merapi.level, 3);
  assert.equal(byId.semeru.level, null);
  assert.equal(byId.marapi.level, null);
  assert.equal(byId.agung.level, null);
  assert.equal(byId.merapi.vona, null);
  assert.equal(byId.semeru.vona.text.length, 280);
  assert.ok(byId.semeru.vona.text.startsWith('ok'));
  assert.equal(snapshot.noticeCount, 1);
});
