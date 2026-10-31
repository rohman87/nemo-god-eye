import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BMKG_FEED_URLS,
  mergeBmkgRows,
  mergeEarthquakeProviders,
  normalizeBmkgEvents,
} from './bmkg.js';
import {
  createBmkgEarthquakeSource,
  createCompositeEarthquakeSource,
} from './source.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const item = (over = {}) => ({
  Tanggal: '30 Okt 2026',
  Jam: '17:29:39 WIB',
  DateTime: '2026-10-30T10:29:39+00:00',
  Coordinates: '2.57,98.66',
  Lintang: '2.57 LU',
  Bujur: '98.66 BT',
  Magnitude: '3.5',
  Kedalaman: '3 km',
  Wilayah: 'Pusat gempa berada di darat 7 km barat daya Samosir',
  Potensi: 'Tidak berpotensi tsunami',
  ...over,
});
const wrap = (gempa) => ({ Infogempa: { gempa } });
const usgs = (over = {}) => ({
  stableId: 'us1',
  usgsId: 'us1',
  lon: 98.66,
  lat: 2.57,
  depthKm: 10,
  mag: 3.6,
  place: 'USGS place',
  time: Date.parse('2026-10-30T10:29:39Z'),
  ...over,
});
const bmkgRow = (over = {}) => ({
  ...normalizeBmkgEvents(wrap(item()))[0],
  ...over,
});

test('feed urls are frozen https BMKG endpoints', () => {
  assert.ok(Object.isFrozen(BMKG_FEED_URLS));
  for (const url of Object.values(BMKG_FEED_URLS))
    assert.match(
      url,
      /^https:\/\/data\.bmkg\.go\.id\/DataMKG\/TEWS\/.+\.json$/,
    );
});

test('normalize accepts a single object and an array', () => {
  const one = normalizeBmkgEvents(wrap(item()));
  const many = normalizeBmkgEvents(
    wrap([item(), item({ Magnitude: '5.1', Coordinates: '3,99' })]),
  );
  assert.equal(one.length, 1);
  assert.equal(many.length, 2);
  const id = `bmkg-${Date.parse('2026-10-30T10:29:39Z')}-2.57,98.66`;
  assert.deepEqual(one[0], {
    stableId: id,
    usgsId: null,
    bmkgId: id,
    provider: 'BMKG',
    providers: ['BMKG'],
    lon: 98.66,
    lat: 2.57,
    depthKm: 3,
    mag: 3.5,
    place: 'Pusat gempa berada di darat 7 km barat daya Samosir',
    time: Date.parse('2026-10-30T10:29:39Z'),
    tsunami: false,
    felt: false,
    feltReport: null,
    potential: 'Tidak berpotensi tsunami',
  });
});

test('normalize returns null for malformed structure', () => {
  for (const payload of [
    null,
    {},
    { Infogempa: {} },
    { Infogempa: { gempa: 'x' } },
    { Infogempa: { gempa: null } },
    { Infogempa: { gempa: 5 } },
  ])
    assert.equal(normalizeBmkgEvents(payload), null);
});

test('normalize skips bad items without failing the feed', () => {
  const rows = normalizeBmkgEvents(
    wrap([
      null,
      'x',
      [],
      item({ DateTime: '2026-10-30 10:29:39' }),
      item({ DateTime: '2026-13-45T99:99:99Z' }),
      item({ DateTime: undefined }),
      item({ Coordinates: '2.57' }),
      item({ Coordinates: 'a,b' }),
      item({ Coordinates: '91,10' }),
      item({ Coordinates: '10,181' }),
      item({ Coordinates: ',10' }),
      item({ Magnitude: 'abc' }),
      item({ Magnitude: '-1' }),
      item({ Magnitude: '10.5' }),
      item({ Magnitude: undefined }),
      item({ Magnitude: ' 4.2 ', DateTime: '2026-10-30T10:30:00Z' }),
    ]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mag, 4.2);
});

test('normalize caps the item count', () => {
  const rows = normalizeBmkgEvents(
    wrap(
      Array.from({ length: 150 }, (_, i) =>
        item({ Coordinates: `${(i % 80) / 10},98.${i}` }),
      ),
    ),
  );
  assert.equal(rows.length, 100);
});

test('depth parsing', () => {
  const depth = (Kedalaman) =>
    normalizeBmkgEvents(wrap(item({ Kedalaman })))[0].depthKm;
  assert.equal(depth('10 km'), 10);
  assert.equal(depth('12.5km'), 12.5);
  assert.equal(depth('33 KM'), 33);
  assert.equal(depth('deep'), null);
  assert.equal(depth(undefined), null);
});

test('tsunami flag', () => {
  const flag = (Potensi) =>
    normalizeBmkgEvents(wrap(item({ Potensi })))[0].tsunami;
  assert.equal(flag('Berpotensi tsunami'), true);
  assert.equal(flag('Gempa ini berpotensi  TSUNAMI untuk diwaspadai'), true);
  assert.equal(flag('Tidak berpotensi tsunami'), false);
  assert.equal(flag(undefined), false);
});

test('felt flag comes from the option or a felt report', () => {
  const [plain] = normalizeBmkgEvents(wrap(item()));
  assert.equal(plain.felt, false);
  const [byOption] = normalizeBmkgEvents(wrap(item()), { felt: true });
  assert.equal(byOption.felt, true);
  const [byReport] = normalizeBmkgEvents(
    wrap(item({ Dirasakan: 'II Pangururan' })),
  );
  assert.equal(byReport.felt, true);
  assert.equal(byReport.feltReport, 'II Pangururan');
});

test('control characters are stripped and text is capped', () => {
  const [row] = normalizeBmkgEvents(
    wrap(
      item({
        Wilayah: 'Pusat\u0000 gempa‮ ​  di\n laut' + 'x'.repeat(300),
        Dirasakan: 'II\u0007 Kota',
      }),
    ),
  );
  assert.match(row.place, /^Pusat gempa di lautx+$/);
  assert.equal(row.place.length, 160);
  assert.equal(row.feltReport, 'II Kota');
});

test('mergeBmkgRows dedupes and ORs flags', () => {
  const a = bmkgRow({ tsunami: false, felt: true, feltReport: null });
  const b = bmkgRow({
    tsunami: true,
    felt: false,
    feltReport: 'II Kota',
    depthKm: null,
  });
  const other = bmkgRow({ stableId: 'bmkg-other' });
  const merged = mergeBmkgRows([a], [b, other]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].tsunami, true);
  assert.equal(merged[0].felt, true);
  assert.equal(merged[0].feltReport, 'II Kota');
  assert.equal(merged[0].depthKm, 3);
  assert.equal(a.tsunami, false);
});

test('mergeEarthquakeProviders matches within 60 s and 30 km', () => {
  const u = usgs({ time: bmkgRow().time + 60_000, lat: 2.57 + 0.27 });
  const out = mergeEarthquakeProviders([u], [bmkgRow()], { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, 'BMKG');
  assert.deepEqual(out[0].providers, ['BMKG', 'USGS']);
  assert.equal(out[0].usgsId, 'us1');
  assert.equal(out[0].bmkgId, bmkgRow().stableId);
});

test('mergeEarthquakeProviders keeps non-matches', () => {
  const t = bmkgRow().time;
  const options = { now: NOW };
  const apart = mergeEarthquakeProviders(
    [usgs({ time: t + 120_000 })],
    [bmkgRow()],
    options,
  );
  assert.equal(apart.length, 2);
  const distant = mergeEarthquakeProviders(
    [usgs({ lat: 2.57 + 1.4 })],
    [bmkgRow()],
    options,
  );
  assert.equal(distant.length, 2);
  const noTime = mergeEarthquakeProviders(
    [usgs({ time: null })],
    [bmkgRow()],
    options,
  );
  assert.equal(noTime.length, 2);
  assert.equal(noTime[1].time, null);
});

test('each USGS row matches at most once', () => {
  const t = bmkgRow().time;
  const a = bmkgRow();
  const b = bmkgRow({ stableId: 'bmkg-b', bmkgId: 'bmkg-b', time: t + 5000 });
  const out = mergeEarthquakeProviders(
    [usgs({ stableId: 'u-near', usgsId: 'u-near', time: t + 4000 })],
    [a, b],
    { now: NOW },
  );
  assert.equal(out.length, 2);
  assert.equal(out.filter((r) => r.providers.length === 2).length, 1);
  assert.equal(out.find((r) => r.providers.length === 2).stableId, a.stableId);
  assert.equal(new Set(out.map((r) => r.stableId)).size, 2);
});

test('mergeEarthquakeProviders drops BMKG rows outside the window', () => {
  const old = bmkgRow({ stableId: 'old', time: NOW - 86_400_001 });
  const future = bmkgRow({ stableId: 'future', time: NOW + 3_600_001 });
  const edge = bmkgRow({ stableId: 'edge', time: NOW + 3_600_000 });
  const out = mergeEarthquakeProviders([], [old, future, edge], { now: NOW });
  assert.deepEqual(
    out.map((r) => r.stableId),
    ['edge'],
  );
});

test('mergeEarthquakeProviders adds USGS defaults, sorts and does not mutate', () => {
  const u1 = usgs({ stableId: 'u1', time: NOW - 5000 });
  const u2 = usgs({ stableId: 'u2', time: null, lat: -40 });
  const u3 = usgs({ stableId: 'u3', time: NOW - 1000, lat: -30 });
  const b = bmkgRow({ stableId: 'b1', time: NOW - 3000, lat: 10, lon: 10 });
  const inputs = structuredClone([[u1, u2, u3], [b]]);
  const out = mergeEarthquakeProviders([u1, u2, u3], [b], { now: NOW });
  assert.deepEqual([[u1, u2, u3], [b]], inputs);
  assert.deepEqual(
    out.map((r) => r.stableId),
    ['u3', 'b1', 'u1', 'u2'],
  );
  const first = out[0];
  assert.equal(first.provider, 'USGS');
  assert.deepEqual(first.providers, ['USGS']);
  assert.equal(first.bmkgId, null);
  assert.equal(first.tsunami, false);
  assert.equal(first.felt, false);
  assert.equal(first.feltReport, null);
  assert.equal(first.potential, null);
  assert.equal('provider' in u1, false);
});

// BMKG source

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

test('BMKG source merges feeds and survives one failing feed', async () => {
  const urls = [];
  const source = createBmkgEarthquakeSource({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === BMKG_FEED_URLS.recent) return jsonResponse({}, 500);
      if (url === BMKG_FEED_URLS.felt)
        return jsonResponse(wrap([item({ Dirasakan: 'II Kota' })]));
      return jsonResponse(wrap(item()));
    },
  });
  const rows = await source.getSnapshot({});
  assert.equal(urls.length, 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].felt, true);
});

test('BMKG source throws the first error when every feed fails', async () => {
  const source = createBmkgEarthquakeSource({
    fetchImpl: async () => jsonResponse({}, 503),
  });
  await assert.rejects(source.getSnapshot({}), /BMKG HTTP 503/);
  const malformed = createBmkgEarthquakeSource({
    fetchImpl: async () => jsonResponse({}),
  });
  await assert.rejects(malformed.getSnapshot({}), /Malformed BMKG response/);
});

test('BMKG source rethrows an abort', async () => {
  const abort = new AbortController();
  const source = createBmkgEarthquakeSource({
    fetchImpl: async () => {
      abort.abort();
      return jsonResponse(wrap(item()));
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

// Composite source

function composite(t) {
  const state = {
    clock: NOW,
    usgs: [usgs({ time: NOW - 60_000 })],
    bmkg: [bmkgRow({ stableId: 'b1', time: NOW - 30_000, lat: -7, lon: 110 })],
  };
  const provider = (key) => ({
    async getSnapshot() {
      if (state[key] instanceof Error) throw state[key];
      return state[key];
    },
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const source = createCompositeEarthquakeSource({
    usgs: provider('usgs'),
    bmkg: provider('bmkg'),
    now: () => state.clock,
  });
  return { state, source, warn };
}

test('composite merges both providers', async (t) => {
  const { source } = composite(t);
  assert.deepEqual(source.getProviderStatus(), { usgs: 'idle', bmkg: 'idle' });
  const rows = await source.getSnapshot({});
  assert.equal(rows.length, 2);
  assert.deepEqual(source.getProviderStatus(), { usgs: 'ok', bmkg: 'ok' });
});

test('composite serves USGS alone when BMKG is down and warns', async (t) => {
  const { state, source, warn } = composite(t);
  state.bmkg = new Error('BMKG HTTP 500');
  const rows = await source.getSnapshot({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'USGS');
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(
    warn.mock.calls[0].arguments[0],
    '[Data:Earthquakes] BMKG unavailable:',
  );
  assert.equal(warn.mock.calls[0].arguments[1], 'BMKG HTTP 500');
  assert.deepEqual(source.getProviderStatus(), { usgs: 'ok', bmkg: 'down' });
});

test('composite falls back to cached rows younger than six hours', async (t) => {
  const { state, source } = composite(t);
  await source.getSnapshot({});
  state.usgs = new Error('USGS HTTP 500');
  state.clock = NOW + 5 * 3_600_000;
  state.bmkg = [];
  let rows = await source.getSnapshot({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usgsId, 'us1');
  assert.equal(source.getProviderStatus().usgs, 'cached');
  state.clock = NOW + 6 * 3_600_000;
  state.bmkg = [bmkgRow({ stableId: 'b2', time: state.clock })];
  rows = await source.getSnapshot({});
  assert.equal(source.getProviderStatus().usgs, 'down');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'b2');
});

test('composite throws when both providers are down with no cache', async (t) => {
  const { state, source } = composite(t);
  state.usgs = new Error('USGS HTTP 500');
  state.bmkg = new Error('BMKG HTTP 500');
  await assert.rejects(source.getSnapshot({}), /USGS HTTP 500/);
  assert.deepEqual(source.getProviderStatus(), { usgs: 'down', bmkg: 'down' });
});

test('composite propagates an abort', async (t) => {
  const { source } = composite(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
