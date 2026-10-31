import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARINE_STALE_AFTER_MS,
  MARINE_STRAITS,
  VESSEL_LIMITS,
  WAVE_BANDS,
  arrowSizePx,
  compassPoint,
  createMarineOverlayEntry,
  exceedsLimit,
  mapAnalystRecord,
  marineLabelTitle,
  marineRowsAreStale,
  normalizeMarinePayload,
  parseGmtTime,
  sortRowsByHeight,
  travelBearing,
  waveBand,
} from './model.js';

const NOW = Date.parse('2026-10-30T16:50:00Z');

const item = (height, extra = {}) => ({
  latitude: 0,
  longitude: 0,
  current: {
    time: '2026-10-30T16:45',
    interval: 900,
    wave_height: height,
    wave_direction: 225,
    wave_period: 6.2,
  },
  hourly: {
    time: ['2026-10-30T16:00', '2026-10-30T17:00', '2026-10-31T17:00'],
    wave_height: [height, height + 0.5, 20],
  },
  ...extra,
});
const payload = (height = 1.4) => MARINE_STRAITS.map(() => item(height));

test('straits and tables are frozen and in the agreed order', () => {
  assert.equal(MARINE_STRAITS.length, 10);
  assert.ok(Object.isFrozen(MARINE_STRAITS));
  assert.ok(Object.isFrozen(MARINE_STRAITS[0]));
  assert.deepEqual(
    MARINE_STRAITS.map((s) => s.id),
    [
      'sunda',
      'bali',
      'lombok',
      'alas',
      'madura',
      'makassar',
      'bangka',
      'malacca',
      'karimata',
      'sape',
    ],
  );
  assert.ok(Object.isFrozen(WAVE_BANDS) && Object.isFrozen(VESSEL_LIMITS));
  assert.deepEqual(
    VESSEL_LIMITS.map((v) => [v.id, v.limitM]),
    [
      ['fishing', 1.25],
      ['barge', 1.5],
      ['ferry', 2.5],
      ['ship', 4],
    ],
  );
});

test('waveBand uses BMKG bounds with an exclusive upper edge', () => {
  const id = (m) => waveBand(m).id;
  assert.equal(id(0), 'calm');
  assert.equal(id(0.49), 'calm');
  assert.equal(id(0.5), 'low');
  assert.equal(id(1.25), 'moderate');
  assert.equal(id(2.49), 'moderate');
  assert.equal(id(2.5), 'high');
  assert.equal(id(4), 'very-high');
  assert.equal(id(6), 'extreme');
  assert.equal(id(8.99), 'extreme');
  assert.equal(id(9), 'very-extreme');
  assert.equal(id(30), 'very-extreme');
  assert.equal(waveBand(-1), null);
  assert.equal(waveBand(NaN), null);
  assert.equal(waveBand(null), null);
});

test('arrowSizePx steps 20 / 26 / 32 by band', () => {
  const sizes = WAVE_BANDS.map((band) => arrowSizePx(band));
  assert.deepEqual(sizes, [20, 20, 26, 26, 32, 32, 32]);
  assert.equal(arrowSizePx('high'), 26);
  assert.equal(arrowSizePx(null), 20);
});

test('travelBearing turns wave-from by 180 degrees', () => {
  assert.equal(travelBearing(0), 180);
  assert.equal(travelBearing(225), 45);
  assert.equal(travelBearing(180), 0);
  assert.equal(travelBearing(359), 179);
  assert.equal(travelBearing(null), null);
  assert.equal(travelBearing('x'), null);
  assert.equal(compassPoint(225), 'SW');
  assert.equal(compassPoint(359), 'N');
});

test('exceedsLimit is inclusive and follows the vessel', () => {
  assert.equal(exceedsLimit(2.5, 'ferry'), true);
  assert.equal(exceedsLimit(2.4, 'ferry'), false);
  assert.equal(exceedsLimit(1.3, 'fishing'), true);
  assert.equal(exceedsLimit(1.3, 'ship'), false);
  assert.equal(exceedsLimit(NaN, 'ferry'), false);
});

test('parseGmtTime reads zone-less Open-Meteo times as UTC', () => {
  assert.equal(
    parseGmtTime('2026-10-30T16:45'),
    Date.parse('2026-10-30T16:45:00Z'),
  );
  assert.equal(
    parseGmtTime('2026-10-30T16:45Z'),
    Date.parse('2026-10-30T16:45:00Z'),
  );
  assert.equal(parseGmtTime('nope'), null);
  assert.equal(parseGmtTime(5), null);
});

test('normalizeMarinePayload builds rows in strait order', () => {
  const rows = normalizeMarinePayload(payload(1.4), MARINE_STRAITS, NOW);
  assert.equal(rows.length, 10);
  const [first] = rows;
  assert.equal(first.id, 'sunda');
  assert.equal(first.name, 'Selat Sunda');
  assert.equal(first.route, 'Merak–Bakauheni');
  assert.equal(first.lat, -5.9);
  assert.equal(first.lon, 105.85);
  assert.equal(first.heightM, 1.4);
  assert.equal(first.directionFromDeg, 225);
  assert.equal(first.periodS, 6.2);
  assert.equal(first.band, 'moderate');
  assert.equal(first.validMs, Date.parse('2026-10-30T16:45:00Z'));
  // 17:00 sample counts, the +24 h-and-more 20 m sample does not.
  assert.equal(first.maxNext24hM, 1.9);
});

test('upstream coordinates are ignored in favour of the strait position', () => {
  const data = payload();
  data[0].latitude = 50;
  data[0].longitude = 10;
  const [row] = normalizeMarinePayload(data, MARINE_STRAITS, NOW);
  assert.equal(row.lat, MARINE_STRAITS[0].lat);
  assert.equal(row.lon, MARINE_STRAITS[0].lon);
});

test('a strait without a usable height is skipped, not an error', () => {
  const data = payload();
  data[1] = item(null);
  data[2] = item('abc');
  data[3] = item(-2);
  data[4] = { latitude: 0 };
  data[5] = null;
  const rows = normalizeMarinePayload(data, MARINE_STRAITS, NOW);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['sunda', 'bangka', 'malacca', 'karimata', 'sape'],
  );
});

test('a bad time skips the strait; a future time is held to now', () => {
  const data = payload();
  data[0].current.time = 'garbage';
  data[1].current.time = '2027-01-01T00:00';
  const rows = normalizeMarinePayload(data, MARINE_STRAITS, NOW);
  assert.equal(
    rows.some((r) => r.id === 'sunda'),
    false,
  );
  assert.equal(rows.find((r) => r.id === 'bali').validMs, NOW);
});

test('heights and periods are clamped, direction wrapped', () => {
  const data = payload();
  data[0].current.wave_height = 400;
  data[0].current.wave_period = 99;
  data[0].current.wave_direction = 725;
  data[1].current.wave_direction = null;
  data[1].current.wave_period = -3;
  const rows = normalizeMarinePayload(data, MARINE_STRAITS, NOW);
  assert.equal(rows[0].heightM, 30);
  assert.equal(rows[0].periodS, 30);
  assert.equal(rows[0].directionFromDeg, 5);
  assert.equal(rows[0].band, 'very-extreme');
  assert.equal(rows[1].directionFromDeg, null);
  assert.equal(rows[1].periodS, null);
});

test('malformed structure returns null', () => {
  assert.equal(normalizeMarinePayload(null, MARINE_STRAITS, NOW), null);
  assert.equal(normalizeMarinePayload({}, MARINE_STRAITS, NOW), null);
  assert.equal(normalizeMarinePayload('x', MARINE_STRAITS, NOW), null);
  assert.equal(
    normalizeMarinePayload(payload().slice(1), MARINE_STRAITS, NOW),
    null,
  );
  assert.deepEqual(
    normalizeMarinePayload([], MARINE_STRAITS.slice(0, 0), NOW),
    [],
  );
});

test('a single-strait request that answers with a bare object is accepted', () => {
  const rows = normalizeMarinePayload(item(1), MARINE_STRAITS.slice(0, 1), NOW);
  assert.equal(rows.length, 1);
});

test('sortRowsByHeight puts the tallest first and ties follow strait order', () => {
  const rows = normalizeMarinePayload(payload(1), MARINE_STRAITS, NOW);
  rows[7].heightM = 3;
  const sorted = sortRowsByHeight(rows);
  assert.equal(sorted[0].id, 'malacca');
  assert.deepEqual(
    sorted.slice(1, 3).map((r) => r.id),
    ['sunda', 'bali'],
  );
});

test('staleness is judged on the newest valid time', () => {
  const rows = normalizeMarinePayload(payload(), MARINE_STRAITS, NOW);
  assert.equal(marineRowsAreStale(rows, NOW), false);
  assert.equal(
    marineRowsAreStale(rows, rows[0].validMs + MARINE_STALE_AFTER_MS),
    false,
  );
  assert.equal(
    marineRowsAreStale(rows, rows[0].validMs + MARINE_STALE_AFTER_MS + 1),
    true,
  );
  assert.equal(marineRowsAreStale([], NOW), true);
});

test('label entry ranks by band then height and reads like the spec', () => {
  const [row] = normalizeMarinePayload(payload(1.44), MARINE_STRAITS, NOW);
  assert.equal(marineLabelTitle(row), 'Selat Sunda 1.4 m');
  const entry = (band, heightM) =>
    createMarineOverlayEntry({
      id: 'x',
      position: {},
      title: 'x',
      accent: '#fff',
      band,
      heightM,
    });
  assert.equal(entry('moderate', 1.4).priority, 3140);
  assert.ok(entry('high', 2.5).priority > entry('moderate', 2.49).priority);
  assert.ok(entry('very-extreme', 30).priority < 9000);
  assert.equal(entry('calm', 0.2).variant, 'label');
  assert.equal(entry('calm', 0.2).collisionGroup, 'ambient-label');
});

test('analyst records carry the agreed fields', () => {
  const [row] = normalizeMarinePayload(payload(1.4), MARINE_STRAITS, NOW);
  assert.deepEqual(mapAnalystRecord(row), {
    id: 'sunda',
    strait: 'Selat Sunda',
    route: 'Merak–Bakauheni',
    waveHeightM: 1.4,
    band: 'Moderate',
    directionFromDeg: 225,
    periodS: 6.2,
    maxNext24hM: 1.9,
    validTimeMs: Date.parse('2026-10-30T16:45:00Z'),
    lat: -5.9,
    lon: 105.85,
  });
});
