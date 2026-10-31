import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISASTER_TYPES,
  DISASTER_WINDOWS,
  countByType,
  createDisasterReportOverlayEntry,
  disasterWindow,
  drawDisasterDot,
  filterByWindow,
  mapAnalystRecord,
  newestPerType,
  normalizePetaBencanaReports,
  reportAlpha,
} from './model.js';

const NOW = Date.parse('2026-10-30T06:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const feature = (overrides = {}, coordinates = [106.82, -6.2]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    pkey: '1001',
    created_at: new Date(NOW - 2 * HOUR).toISOString(),
    source: 'grasp',
    status: 'confirmed',
    url: 'https://petabencana.id/jakarta/1001',
    image_url: 'https://example.test/x.jpg',
    disaster_type: 'flood',
    report_data: { report_type: 'flood', flood_depth: 45.4 },
    tags: { city: 'Jakarta Utara', instance_region_code: 'jbd' },
    title: 'Banjir di Kelapa Gading',
    text: 'Air setinggi lutut',
    ...overrides,
  },
});
const body = (...features) => ({
  statusCode: 200,
  result: { type: 'FeatureCollection', features },
});

test('DISASTER_TYPES is frozen and carries spec colours and labels', () => {
  assert.ok(Object.isFrozen(DISASTER_TYPES));
  assert.ok(DISASTER_TYPES.every(Object.isFrozen));
  assert.deepEqual(
    DISASTER_TYPES.map((t) => [t.id, t.label, t.color]),
    [
      ['flood', 'Flood', '#3b82f6'],
      ['fire', 'Fire', '#ff7a1a'],
      ['haze', 'Haze', '#a8a29e'],
      ['wind', 'Wind', '#2dd4bf'],
      ['earthquake', 'Earthquake', '#e8eef5'],
      ['volcano', 'Volcano', '#9d6b53'],
    ],
  );
});

test('normalizes a valid report', () => {
  const [row] = normalizePetaBencanaReports(body(feature()), NOW);
  assert.deepEqual(row, {
    id: '1001',
    type: 'flood',
    createdMs: NOW - 2 * HOUR,
    lat: -6.2,
    lon: 106.82,
    city: 'Jakarta Utara',
    regionCode: 'jbd',
    source: 'grasp',
    title: 'Banjir di Kelapa Gading',
    text: 'Air setinggi lutut',
    url: 'https://petabencana.id/jakarta/1001',
    floodDepthCm: 45,
  });
  assert.equal('image_url' in row || 'imageUrl' in row, false);
});

test('structural failures return null', () => {
  for (const bad of [
    null,
    undefined,
    'x',
    [],
    {},
    { result: null },
    { result: { features: 'no' } },
  ])
    assert.equal(normalizePetaBencanaReports(bad, NOW), null);
  assert.deepEqual(normalizePetaBencanaReports(body(), NOW), []);
});

test('skips unknown types, bad ids, bad geometry and out-of-bounds points', () => {
  const rows = normalizePetaBencanaReports(
    body(
      feature({ pkey: '1', disaster_type: 'tsunami' }),
      feature({ pkey: '2', disaster_type: 'FIRE' }),
      feature({ pkey: 'a/b' }),
      feature({ pkey: '' }),
      feature({ pkey: { x: 1 } }),
      feature({ pkey: '3' }, [0, 0]),
      feature({ pkey: '4' }, [106.8, 'x']),
      feature({ pkey: '5' }, [106.8]),
      { geometry: { type: 'LineString', coordinates: [[1, 1]] } },
      null,
      feature({ pkey: 'x'.repeat(41) }),
    ),
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.type]),
    [['2', 'fire']],
  );
});

test('numeric pkey is accepted and stringified', () => {
  const [row] = normalizePetaBencanaReports(body(feature({ pkey: 77 })), NOW);
  assert.equal(row.id, '77');
});

test('skips future-dated, over-age and unparseable reports', () => {
  const at = (ms) => new Date(ms).toISOString();
  const rows = normalizePetaBencanaReports(
    body(
      feature({ pkey: 'ok-future', created_at: at(NOW + 30 * 60_000) }),
      feature({ pkey: 'future', created_at: at(NOW + 2 * HOUR) }),
      feature({ pkey: 'old', created_at: at(NOW - 7 * DAY - 1000) }),
      feature({ pkey: 'edge', created_at: at(NOW - 7 * DAY + 1000) }),
      feature({ pkey: 'bad', created_at: 'yesterday-ish' }),
      feature({ pkey: 'none', created_at: undefined }),
    ),
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.id).sort(), ['edge', 'ok-future']);
});

test('keeps only https urls', () => {
  const urls = (value) =>
    normalizePetaBencanaReports(body(feature({ url: value })), NOW)[0].url;
  assert.equal(urls('http://petabencana.id/x'), null);
  assert.equal(urls('javascript:alert(1)'), null);
  assert.equal(urls('data:text/html,hi'), null);
  assert.equal(urls('not a url'), null);
  assert.equal(urls(12), null);
  assert.equal(urls('https://petabencana.id/a'), 'https://petabencana.id/a');
  assert.equal(urls(`https://x.test/${'a'.repeat(400)}`), null);
});

test('cleans and caps text', () => {
  const [row] = normalizePetaBencanaReports(
    body(
      feature({
        title: `  Banjir\u0000‮ besar\n\n${'t'.repeat(300)}`,
        text: 'x'.repeat(1000),
        tags: { city: `Ci\u0007ty ${'c'.repeat(100)}` },
      }),
    ),
    NOW,
  );
  assert.equal(row.title.length, 120);
  assert.ok(!/[\u0000-\u001f‮]/.test(row.title));
  assert.ok(row.title.startsWith('Banjir besar'));
  assert.equal(row.text.length, 280);
  assert.equal(row.city.length, 60);
  assert.ok(row.city.startsWith('City '));
});

test('flood depth is kept for floods only and clamped to a sane range', () => {
  const depth = (type, value) =>
    normalizePetaBencanaReports(
      body(
        feature({
          disaster_type: type,
          report_data: { flood_depth: value },
        }),
      ),
      NOW,
    )[0].floodDepthCm;
  assert.equal(depth('flood', 120), 120);
  assert.equal(depth('flood', -3), null);
  assert.equal(depth('flood', 99999), null);
  assert.equal(depth('flood', '40'), null);
  assert.equal(depth('fire', 40), null);
});

test('sorts newest first, dedupes by id, and caps at 500', () => {
  const many = Array.from({ length: 520 }, (_, i) =>
    feature({
      pkey: String(i),
      created_at: new Date(NOW - (i + 1) * 60_000).toISOString(),
    }),
  );
  const rows = normalizePetaBencanaReports(body(...many, many[0]), NOW);
  assert.equal(rows.length, 500);
  assert.equal(rows[0].id, '0');
  assert.equal(rows[499].id, '499');
  for (let i = 1; i < rows.length; i++)
    assert.ok(rows[i - 1].createdMs >= rows[i].createdMs);
});

test('filterByWindow keeps reports inside the window', () => {
  const rows = [
    { id: 'a', createdMs: NOW - HOUR },
    { id: 'b', createdMs: NOW - 2 * DAY },
    { id: 'c', createdMs: NOW - 5 * DAY },
  ];
  assert.deepEqual(
    filterByWindow(rows, DAY, NOW).map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(
    filterByWindow(rows, 3 * DAY, NOW).map((r) => r.id),
    ['a', 'b'],
  );
  assert.equal(filterByWindow(rows, 7 * DAY, NOW).length, 3);
  assert.deepEqual(filterByWindow(null, DAY, NOW), []);
  assert.deepEqual(filterByWindow(rows, NaN, NOW), []);
});

test('windows are 24 h / 3 d / 7 d and unknown ids fall back to 3 d', () => {
  assert.deepEqual(
    DISASTER_WINDOWS.map((w) => w.label),
    ['24 h', '3 d', '7 d'],
  );
  assert.equal(disasterWindow('7d').ms, 7 * DAY);
  assert.equal(disasterWindow('nope').id, '3d');
});

test('countByType and newestPerType', () => {
  const rows = [
    { id: 'a', type: 'flood', createdMs: 30 },
    { id: 'b', type: 'flood', createdMs: 20 },
    { id: 'c', type: 'fire', createdMs: 25 },
  ];
  assert.deepEqual(countByType(rows), {
    flood: 2,
    fire: 1,
    haze: 0,
    wind: 0,
    earthquake: 0,
    volcano: 0,
  });
  assert.deepEqual(
    newestPerType(rows).map((r) => r.id),
    ['a', 'c'],
  );
});

test('reportAlpha fades reports older than six hours', () => {
  assert.equal(reportAlpha(NOW - HOUR, NOW), 0.9);
  assert.equal(reportAlpha(NOW - 7 * HOUR, NOW), 0.6);
});

test('overlay entry follows the shared label shape', () => {
  const entry = createDisasterReportOverlayEntry({
    id: 5,
    position: {},
    title: 'Flood',
    accent: '#3b82f6',
  });
  assert.equal(entry.id, '5');
  assert.equal(entry.variant, 'label');
  assert.equal(entry.priority, 500);
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.placement, 'above');
});

test('drawDisasterDot paints a coloured dot on an injected canvas', () => {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
      set: (_, name, value) => {
        calls.push(['set', name, value]);
        return true;
      },
    },
  );
  const canvas = drawDisasterDot('fire', () => ({
    getContext: () => ctx,
  }));
  assert.equal(canvas.width, 24);
  assert.equal(canvas.height, 24);
  assert.ok(calls.some((c) => c[1] === 'fillStyle' && c[2] === '#ff7a1a'));
  assert.ok(calls.some((c) => c[1] === 'strokeStyle' && c[2] === '#e8eef5'));
  assert.equal(
    drawDisasterDot('tsunami', () => ({})),
    null,
  );
});

test('mapAnalystRecord yields JSON-safe fields', () => {
  const record = mapAnalystRecord(
    {
      id: '9',
      type: 'fire',
      createdMs: 5,
      lat: 1,
      lon: 2,
      city: '',
      title: 'T',
      text: 'X',
      url: null,
      extra: 1,
    },
    3,
  );
  assert.deepEqual(record, {
    id: '9',
    type: 'fire',
    createdMs: 5,
    lat: 1,
    lon: 2,
    city: null,
    title: 'T',
    text: 'X',
  });
  assert.equal(mapAnalystRecord(null, 3).id, 'DR-0003');
});
