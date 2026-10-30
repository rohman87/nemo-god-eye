import assert from 'node:assert/strict';
import test from 'node:test';
import { OBSERVATION_MAX_AGE_MS } from './model.js';
import {
  ISPU_MAX_STATIONS,
  ispuReadings,
  ispuUtcOffsetHours,
  normalizeIspuStations,
  parseIspuTime,
} from './ispu.js';

const HOUR = 60 * 60 * 1000;
// 2026-10-30 19:00 WIB.
const NOW = Date.UTC(2026, 9, 30, 12);

const feature = (lon, lat, properties) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties,
});
const props = (overrides = {}) => ({
  val: 42,
  waktu: '2026-10-30 19:00:00',
  kota: 'Jakarta Pusat',
  provinsi: 'DKI Jakarta',
  alamat: 'Jl. Medan Merdeka',
  ...overrides,
});
const collection = (features) => ({ type: 'FeatureCollection', features });

test('ispuUtcOffsetHours maps provinces to WIT, WITA and WIB', () => {
  assert.equal(ispuUtcOffsetHours('Maluku'), 9);
  assert.equal(ispuUtcOffsetHours('Papua Tengah'), 9);
  assert.equal(ispuUtcOffsetHours('Bali'), 8);
  assert.equal(ispuUtcOffsetHours('Sulawesi Utara'), 8);
  assert.equal(ispuUtcOffsetHours('NTB'), 8);
  assert.equal(ispuUtcOffsetHours('DKI Jakarta'), 7);
  assert.equal(ispuUtcOffsetHours('Kalimantan Tengah'), 7);
});

test('ispuUtcOffsetHours tolerates case, whitespace and punctuation', () => {
  assert.equal(ispuUtcOffsetHours('  papua   tengah '), 9);
  assert.equal(ispuUtcOffsetHours('BALI'), 8);
  assert.equal(ispuUtcOffsetHours('Kep. Riau'), 7);
});

test('ispuUtcOffsetHours falls back on longitude for an unknown province', () => {
  assert.equal(ispuUtcOffsetHours('Atlantis', 130), 9);
  assert.equal(ispuUtcOffsetHours('Atlantis', 120), 8);
  assert.equal(ispuUtcOffsetHours('Atlantis', 106), 7);
  assert.equal(ispuUtcOffsetHours('Atlantis'), 7);
  assert.equal(ispuUtcOffsetHours(undefined, undefined), 7);
  // A known province wins over a misleading longitude.
  assert.equal(ispuUtcOffsetHours('DKI Jakarta', 130), 7);
});

test('parseIspuTime reads the stamp in the province zone', () => {
  assert.equal(parseIspuTime('2026-10-30 19:00:00', 'DKI Jakarta'), NOW);
  assert.equal(parseIspuTime('2026-10-30 19:00:00', 'Bali'), NOW - HOUR);
  assert.equal(parseIspuTime('2026-10-30 19:00:00', 'Maluku'), NOW - 2 * HOUR);
});

test('parseIspuTime accepts optional and fractional seconds and a T separator', () => {
  assert.equal(parseIspuTime('2026-10-30 19:00', 'DKI Jakarta'), NOW);
  assert.equal(parseIspuTime('2026-10-30T19:00:00', 'DKI Jakarta'), NOW);
  assert.equal(parseIspuTime('2026-10-30 19:00:00.750', 'DKI Jakarta'), NOW);
  assert.equal(
    parseIspuTime('  2026-10-30 19:00:30  ', 'DKI Jakarta'),
    NOW + 30_000,
  );
});

test('parseIspuTime lets an explicit zone override the province', () => {
  assert.equal(parseIspuTime('2026-10-30 12:00:00Z', 'Maluku'), NOW);
  assert.equal(parseIspuTime('2026-10-30 20:00:00+08:00', 'Maluku'), NOW);
  assert.equal(parseIspuTime('2026-10-30 20:00:00+0800', 'Maluku'), NOW);
  assert.equal(parseIspuTime('2026-10-30 05:00:00-07:00', 'Bali'), NOW);
});

test('parseIspuTime rejects impossible dates, bad times and non-strings', () => {
  assert.equal(parseIspuTime('2026-02-30 10:00', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2026-13-01 10:00', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2026-00-10 10:00', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2026-10-00 10:00', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2026-10-30 24:00', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2026-10-30 10:60', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2026-10-30 10:00:60', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2026-10-30 10:00+15:00', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('yesterday', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime(null, 'DKI Jakarta'), null);
  assert.equal(parseIspuTime(1761825600000, 'DKI Jakarta'), null);
  assert.equal(parseIspuTime(undefined, 'DKI Jakarta'), null);
});

test('parseIspuTime accepts 29 February in a leap year only', () => {
  assert.notEqual(parseIspuTime('2028-02-29 10:00', 'DKI Jakarta'), null);
  assert.equal(parseIspuTime('2027-02-29 10:00', 'DKI Jakarta'), null);
});

test('normalizeIspuStations returns null when features is not an array', () => {
  assert.equal(normalizeIspuStations(null), null);
  assert.equal(normalizeIspuStations(undefined), null);
  assert.equal(normalizeIspuStations({}), null);
  assert.equal(normalizeIspuStations({ features: 'no' }), null);
  assert.equal(normalizeIspuStations({ features: {} }), null);
  assert.deepEqual(normalizeIspuStations(collection([])), []);
});

test('normalizeIspuStations builds a station row from a valid feature', () => {
  const [station, ...rest] = normalizeIspuStations(
    collection([feature(106.8456, -6.2088, props({ val: 42 }))]),
  );
  assert.equal(rest.length, 0);
  assert.deepEqual(station, {
    id: '-6.2088,106.8456',
    name: 'Jakarta Pusat',
    city: 'Jakarta Pusat',
    province: 'DKI Jakarta',
    address: 'Jl. Medan Merdeka',
    lat: -6.2088,
    lon: 106.8456,
    value: 42,
    observedMs: NOW,
  });
});

test('normalizeIspuStations names a station by province, then id, when the city is missing', () => {
  const [byProvince, byId] = normalizeIspuStations(
    collection([
      feature(106.8, -6.2, props({ kota: '' })),
      feature(107.8, -7.2, props({ kota: undefined, provinsi: undefined })),
    ]),
  );
  assert.equal(byProvince.name, 'DKI Jakarta');
  assert.equal(byId.name, byId.id);
});

test('normalizeIspuStations skips a feature with unusable properties but keeps the rest', () => {
  const stations = normalizeIspuStations(
    collection([
      feature(106.8, -6.2, null),
      feature(106.9, -6.3, ['not', 'an', 'object']),
      feature(107.0, -6.4, 'text'),
      null,
      feature(107.1, -6.5, props()),
    ]),
  );
  assert.equal(stations.length, 1);
  assert.equal(stations[0].lon, 107.1);
});

test('normalizeIspuStations parses string coordinates and rejects blank or bad ones', () => {
  const stations = normalizeIspuStations(
    collection([
      feature('106.8', '-6.2', props()),
      feature('', '-6.3', props()),
      feature('  ', '-6.4', props()),
      feature('abc', '-6.5', props()),
      feature(null, -6.6, props()),
      feature(Number.NaN, -6.7, props()),
      { properties: props() },
      { geometry: { coordinates: [106.8] }, properties: props() },
      { geometry: { coordinates: 'x' }, properties: props() },
    ]),
  );
  assert.equal(stations.length, 1);
  assert.equal(stations[0].lon, 106.8);
  assert.equal(stations[0].lat, -6.2);
});

test('normalizeIspuStations skips stations outside Indonesia', () => {
  const stations = normalizeIspuStations(
    collection([
      feature(-79.38, 43.65, props()),
      feature(106.8, 7, props()),
      feature(106.8, -12, props()),
      feature(93, -6, props()),
      feature(142, -6, props()),
      feature(94, -11.5, props({ kota: 'SW corner' })),
      feature(141.5, 6.5, props({ kota: 'NE corner' })),
    ]),
  );
  assert.deepEqual(
    stations.map((station) => station.name),
    ['SW corner', 'NE corner'],
  );
});

test('normalizeIspuStations validates the value and falls back to nilai only when val is absent', () => {
  const at = (index) => [106.8 + index * 0.01, -6.2];
  const cases = [
    props({ val: 'abc' }),
    props({ val: '-5' }),
    props({ val: -1 }),
    props({ val: 1001 }),
    props({ val: Number.NaN }),
    props({ val: null, nilai: null }),
    props({ val: {} }),
    props({ val: undefined, nilai: '63' }),
    props({ val: null, nilai: 80 }),
    props({ val: '75.6' }),
    props({ val: 1000 }),
    props({ val: 0 }),
  ];
  const stations = normalizeIspuStations(
    collection(cases.map((p, index) => feature(...at(index), p))),
  );
  assert.deepEqual(
    stations.map((station) => station.value),
    [63, 80, 76, 1000, 0],
  );
});

test('normalizeIspuStations skips a feature with an unreadable time', () => {
  const stations = normalizeIspuStations(
    collection([
      feature(106.8, -6.2, props({ waktu: 'soon' })),
      feature(106.9, -6.2, props({ waktu: undefined })),
      feature(107.0, -6.2, props({ waktu: '2026-02-30 10:00:00' })),
      feature(107.1, -6.2, props()),
    ]),
  );
  assert.equal(stations.length, 1);
});

test('normalizeIspuStations reads the stamp in the station province zone', () => {
  const [wib, wita, wit] = normalizeIspuStations(
    collection([
      feature(106.8, -6.2, props({ provinsi: 'DKI Jakarta' })),
      feature(115.2, -8.6, props({ provinsi: 'Bali', kota: 'Denpasar' })),
      feature(128.2, -3.7, props({ provinsi: 'Maluku', kota: 'Ambon' })),
    ]),
  );
  assert.equal(wib.observedMs, NOW);
  assert.equal(wita.observedMs, NOW - HOUR);
  assert.equal(wit.observedMs, NOW - 2 * HOUR);
});

test('normalizeIspuStations strips control, bidi and zero-width characters and collapses spaces', () => {
  const [station] = normalizeIspuStations(
    collection([
      feature(
        106.8,
        -6.2,
        props({
          kota: '  Ja​kar‮ta\u0000   ⁦Pusat﻿  ',
          provinsi: 'DKI\u0007   Jakarta',
          alamat: 'Jl.‏  Medan\u0085  Merdeka',
        }),
      ),
    ]),
  );
  assert.equal(station.city, 'Jakarta Pusat');
  assert.equal(station.name, 'Jakarta Pusat');
  assert.equal(station.province, 'DKI Jakarta');
  assert.equal(station.address, 'Jl. Medan Merdeka');
});

test('normalizeIspuStations caps text length', () => {
  const [station] = normalizeIspuStations(
    collection([
      feature(
        106.8,
        -6.2,
        props({
          kota: 'K'.repeat(200),
          provinsi: 'P'.repeat(200),
          alamat: 'A'.repeat(500),
        }),
      ),
    ]),
  );
  assert.equal(station.city.length, 80);
  assert.equal(station.province.length, 80);
  assert.equal(station.address.length, 160);
});

test('normalizeIspuStations keeps the newest reading for duplicate coordinates', () => {
  const older = props({ val: 10, waktu: '2026-10-30 17:00:00' });
  const newer = props({ val: 20, waktu: '2026-10-30 19:00:00' });
  const same = props({ val: 30, waktu: '2026-10-30 19:00:00' });
  const [a] = normalizeIspuStations(
    collection([feature(106.8, -6.2, older), feature(106.8, -6.2, newer)]),
  );
  const [b] = normalizeIspuStations(
    collection([feature(106.8, -6.2, newer), feature(106.8, -6.2, older)]),
  );
  assert.equal(a.value, 20);
  assert.equal(b.value, 20);
  // On an exact tie the first one seen stays.
  const [c] = normalizeIspuStations(
    collection([feature(106.8, -6.2, newer), feature(106.8, -6.2, same)]),
  );
  assert.equal(c.value, 20);
  // Coordinates are keyed to four decimals.
  const merged = normalizeIspuStations(
    collection([
      feature(106.80001, -6.20001, older),
      feature(106.80002, -6.20002, newer),
    ]),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, 20);
});

test('normalizeIspuStations tells same-city stations apart by their first address segment', () => {
  const stations = normalizeIspuStations(
    collection([
      feature(
        106.8,
        -6.2,
        props({ kota: 'Bandung', alamat: 'Jl. Soekarno, Kel. Satu' }),
      ),
      feature(
        107.6,
        -6.9,
        props({ kota: 'Bandung', alamat: ' Jl. Asia Afrika , Kel. Dua' }),
      ),
      feature(107.7, -6.95, props({ kota: 'Bandung', alamat: '' })),
      feature(110.4, -7.0, props({ kota: 'Semarang', alamat: 'Jl. Pemuda' })),
    ]),
  );
  assert.deepEqual(
    stations.map((station) => station.name),
    [
      'Bandung · Jl. Soekarno',
      'Bandung · Jl. Asia Afrika',
      'Bandung',
      'Semarang',
    ],
  );
});

test('normalizeIspuStations never exceeds the station cap', () => {
  const features = Array.from({ length: ISPU_MAX_STATIONS + 100 }, (_, index) =>
    feature(106.8, -10 + index * 0.01, props({ kota: `City ${index}` })),
  );
  const stations = normalizeIspuStations(collection(features));
  assert.equal(stations.length, ISPU_MAX_STATIONS);
  assert.equal(stations.at(-1).city, `City ${ISPU_MAX_STATIONS - 1}`);
});

const row = (overrides = {}) => ({
  id: '-6.2088,106.8456',
  name: 'Jakarta Pusat',
  province: 'DKI Jakarta',
  lat: -6.2088,
  lon: 106.8456,
  value: 42,
  observedMs: NOW - HOUR,
  ...overrides,
});

test('ispuReadings returns null for a malformed payload', () => {
  assert.equal(ispuReadings(null, NOW), null);
  assert.equal(ispuReadings(undefined, NOW), null);
  assert.equal(ispuReadings('text', NOW), null);
  assert.equal(ispuReadings([], NOW), null);
  assert.equal(ispuReadings({}, NOW), null);
  assert.equal(ispuReadings({ stations: 'no' }, NOW), null);
  assert.deepEqual(ispuReadings({ stations: [] }, NOW), []);
});

test('ispuReadings turns a row into a provider-shaped reading', () => {
  const [reading] = ispuReadings({ stations: [row()] }, NOW);
  assert.deepEqual(reading, {
    id: 'klhk:-6.2088,106.8456',
    provider: 'klhk',
    scale: 'ISPU',
    value: 42,
    band: 'low',
    stationId: '-6.2088,106.8456',
    name: 'Jakarta Pusat',
    zone: 'DKI Jakarta',
    lat: -6.2088,
    lon: 106.8456,
    observedMs: NOW - HOUR,
    color: '#4cc9f0',
    label: '42',
    risk: 'Low health risk',
    note: null,
  });
});

test('ispuReadings assigns bands at the ISPU thresholds and sorts worst first', () => {
  const values = [50, 51, 101, 201];
  const stations = values.map((value, index) =>
    row({ id: `s${index}`, value, lat: -6 - index * 0.1 }),
  );
  const readings = ispuReadings({ stations }, NOW);
  assert.deepEqual(
    readings.map((reading) => [reading.value, reading.band]),
    [
      [201, 'very-high'],
      [101, 'high'],
      [51, 'moderate'],
      [50, 'low'],
    ],
  );
});

test('ispuReadings drops rows that fail re-validation', () => {
  const bad = [
    row({ id: '' }),
    row({ id: 42 }),
    row({ id: 'x'.repeat(33) }),
    row({ id: 'a\u0000b' }),
    row({ id: 'a‮b' }),
    row({ name: 7 }),
    row({ province: null }),
    row({ lat: '1' }),
    row({ lat: Number.NaN }),
    row({ value: 55.5 }),
    row({ value: '55' }),
    row({ value: -1 }),
    row({ value: 1001 }),
    row({ lat: 10 }),
    row({ lon: 200 }),
    row({ observedMs: Number.NaN }),
    row({ observedMs: '2026' }),
    row({ observedMs: undefined }),
    null,
    'text',
  ];
  const readings = ispuReadings({ stations: [...bad, row({ id: 'ok' })] }, NOW);
  assert.deepEqual(
    readings.map((reading) => reading.stationId),
    ['ok'],
  );
});

test('ispuReadings drops stale readings and readings dated too far ahead', () => {
  const edge = (id, observedMs) => row({ id, observedMs });
  const readings = ispuReadings(
    {
      stations: [
        edge('exactly-6h', NOW - OBSERVATION_MAX_AGE_MS),
        edge('over-6h', NOW - OBSERVATION_MAX_AGE_MS - 1),
        edge('exactly-1h-ahead', NOW + HOUR),
        edge('over-1h-ahead', NOW + HOUR + 1),
      ],
    },
    NOW,
  );
  assert.deepEqual(readings.map((reading) => reading.stationId).sort(), [
    'exactly-1h-ahead',
    'exactly-6h',
  ]);
});

test('ispuReadings keeps the newest reading for a duplicate id', () => {
  const newer = row({ value: 80, observedMs: NOW - HOUR });
  const older = row({ value: 20, observedMs: NOW - 2 * HOUR });
  for (const stations of [
    [older, newer],
    [newer, older],
  ]) {
    const readings = ispuReadings({ stations }, NOW);
    assert.equal(readings.length, 1);
    assert.equal(readings[0].value, 80);
  }
});

test('ispuReadings cleans and caps display text', () => {
  const [reading] = ispuReadings(
    {
      stations: [
        row({
          name: ' Ja​karta   Pusat ' + 'x'.repeat(100),
          province: 'DKI‮  Jakarta',
        }),
      ],
    },
    NOW,
  );
  assert.equal(reading.name.length, 80);
  assert.ok(reading.name.startsWith('Jakarta Pusat xxx'));
  assert.equal(reading.zone, 'DKI Jakarta');
});

test('ispuReadings reads no more than the station cap of rows', () => {
  const stations = Array.from({ length: ISPU_MAX_STATIONS + 50 }, (_, index) =>
    row({ id: `s${index}` }),
  );
  assert.equal(ispuReadings({ stations }, NOW).length, ISPU_MAX_STATIONS);
});

test('ispuReadings defaults the clock to Date.now', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const readings = ispuReadings({ stations: [row()] });
  assert.equal(readings.length, 1);
});
