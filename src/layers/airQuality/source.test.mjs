import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCompositeAirQualitySource,
  createEcccAirQualitySource,
  createSipongiAirQualitySource,
} from './source.js';

const NOW = Date.parse('2026-09-24T18:30:00Z');
const HOUR = 60 * 60 * 1000;
const station = (id) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-79.38, 43.65] },
  properties: { location_id: id, location_name_en: id },
});
const observation = (id, at = NOW, aqhi = 3) => ({
  type: 'Feature',
  properties: {
    location_id: id,
    aqhi,
    observation_datetime: new Date(at - 10 * 60_000).toISOString(),
  },
});
const json = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** A fetch that serves the station catalog and observations from mutable state. */
function feed() {
  const state = {
    clock: NOW,
    stations: [station('A')],
    stationIds: null,
    urls: [],
  };
  state.source = createEcccAirQualitySource({
    now: () => state.clock,
    fetchImpl: async (url) => {
      state.urls.push(url);
      return json({
        type: 'FeatureCollection',
        // Every known station reports ten minutes before the current clock.
        features: url.includes('aqhi-stations')
          ? state.stations
          : (state.stationIds || ['A']).map((id) =>
              observation(id, state.clock),
            ),
      });
    },
  });
  state.stationRequests = () =>
    state.urls.filter((url) => url.includes('aqhi-stations')).length;
  return state;
}

test('the station catalog is cached for twelve hours, then refetched', async () => {
  const state = feed();
  await state.source.getSnapshot();
  state.clock = NOW + 12 * HOUR;
  await state.source.getSnapshot();
  assert.equal(state.stationRequests(), 1, 'within the TTL the cache serves');
  state.clock = NOW + 12 * HOUR + 1;
  await state.source.getSnapshot();
  assert.equal(
    state.stationRequests(),
    2,
    'past the TTL the catalog refreshes',
  );
});

test('an empty catalog refresh keeps the previous catalog', async () => {
  const state = feed();
  await state.source.getSnapshot();
  state.stations = [];
  state.clock = NOW + 13 * HOUR;
  const readings = await state.source.getSnapshot();
  assert.deepEqual(
    readings.map((reading) => reading.stationId),
    ['A'],
  );
  // The empty refresh did not count as fresh, so the next call retries it.
  await state.source.getSnapshot();
  assert.equal(state.stationRequests(), 3);
});

test('an empty first catalog is an error, not an empty layer', async () => {
  const state = feed();
  state.stations = [];
  await assert.rejects(state.source.getSnapshot(), /No AQHI stations/);
});

test('requests ask for JSON, the latest observations only, and a bounded page', async () => {
  const state = feed();
  await state.source.getSnapshot();
  const [stations, observations] = state.urls.map((url) => new URL(url));
  assert.equal(stations.pathname, '/collections/aqhi-stations/items');
  assert.equal(stations.searchParams.get('f'), 'json');
  assert.equal(stations.searchParams.get('limit'), '500');
  assert.equal(
    observations.pathname,
    '/collections/aqhi-observations-realtime/items',
  );
  // Without latest=true the collection returns the full history (~2,000 rows).
  assert.equal(observations.searchParams.get('latest'), 'true');
  assert.equal(observations.searchParams.get('limit'), '500');
});

test('rows past the requested limit are ignored', async () => {
  const state = feed();
  state.stations = Array.from({ length: 600 }, (_, index) =>
    station(`S${String(index).padStart(3, '0')}`),
  );
  state.stationIds = state.stations.map((row) => row.properties.location_id);
  const readings = await state.source.getSnapshot();
  assert.equal(readings.length, 500);
});

test('a malformed catalog and HTTP errors reject', async () => {
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => json({ features: 'no' }),
    }).getSnapshot(),
    /Malformed AQHI station/,
  );
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => json({}, { status: 503 }),
    }).getSnapshot(),
    /ECCC HTTP 503/,
  );
});

test('an oversized response is refused before it is parsed', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024 + 1);
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () =>
        new Response(new Blob([big]).stream(), {
          headers: { 'content-type': 'application/json' },
        }),
    }).getSnapshot(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () =>
        json({}, { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    }).getSnapshot(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
});

test('a caller abort cancels the request and detaches its listener', async () => {
  const caller = new AbortController();
  let requestSignal = null;
  const source = createEcccAirQualitySource({
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const pending = source.getSnapshot({ signal: caller.signal });
  caller.abort(new Error('layer disabled'));
  await assert.rejects(pending, /layer disabled/);
  assert.equal(requestSignal.aborted, true);
  const already = new AbortController();
  already.abort(new Error('before start'));
  let calls = 0;
  await assert.rejects(
    createEcccAirQualitySource({
      fetchImpl: async () => {
        calls += 1;
        return json({ features: [] });
      },
    }).getSnapshot({ signal: already.signal }),
    /before start/,
  );
  assert.equal(calls, 0);
});

test('a request that outlives its deadline is aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = createEcccAirQualitySource({
    timeoutMs: 1_000,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  const pending = source.getSnapshot();
  t.mock.timers.tick(1_000);
  await assert.rejects(pending, /ECCC request timed out/);
});

const ispuRow = (overrides = {}) => ({
  id: '-6.2088,106.8456',
  name: 'Jakarta Pusat',
  province: 'DKI Jakarta',
  lat: -6.2088,
  lon: 106.8456,
  value: 42,
  observedMs: NOW - HOUR,
  ...overrides,
});

test('the SiPongi source requests the same-origin proxy and returns ISPU readings', async () => {
  const calls = [];
  const source = createSipongiAirQualitySource({
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return json({
        stations: [
          ispuRow({ id: 'a', value: 30 }),
          ispuRow({ id: 'b', value: 160 }),
        ],
      });
    },
  });
  const readings = await source.getSnapshot();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/air-quality/indonesia');
  assert.equal(calls[0][1].headers.Accept, 'application/json');
  assert.deepEqual(
    readings.map((reading) => [reading.id, reading.provider, reading.band]),
    [
      ['klhk:b', 'klhk', 'high'],
      ['klhk:a', 'klhk', 'low'],
    ],
  );
});

test('the SiPongi source drops readings past the observation age limit', async () => {
  const source = createSipongiAirQualitySource({
    now: () => NOW,
    fetchImpl: async () =>
      json({
        stations: [
          ispuRow({ id: 'old', observedMs: NOW - 7 * HOUR }),
          ispuRow({ id: 'new' }),
        ],
      }),
  });
  const readings = await source.getSnapshot();
  assert.deepEqual(
    readings.map((reading) => reading.stationId),
    ['new'],
  );
});

test('the SiPongi source rejects HTTP errors and malformed bodies', async () => {
  await assert.rejects(
    createSipongiAirQualitySource({
      fetchImpl: async () => json({}, { status: 502 }),
    }).getSnapshot(),
    /ISPU HTTP 502/,
  );
  await assert.rejects(
    createSipongiAirQualitySource({
      fetchImpl: async () => json({ stations: 'no' }),
    }).getSnapshot(),
    /Malformed ISPU response/,
  );
});

test('the SiPongi source refuses an oversized response', async () => {
  await assert.rejects(
    createSipongiAirQualitySource({
      fetchImpl: async () =>
        json({}, { headers: { 'content-length': String(2 * 1024 * 1024) } }),
    }).getSnapshot(),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
});

test('the SiPongi source honours a caller abort and a deadline', async (t) => {
  const already = new AbortController();
  already.abort(new Error('before start'));
  let calls = 0;
  await assert.rejects(
    createSipongiAirQualitySource({
      fetchImpl: async () => {
        calls += 1;
        return json({ stations: [] });
      },
    }).getSnapshot({ signal: already.signal }),
    /before start/,
  );
  assert.equal(calls, 0);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = createSipongiAirQualitySource({
    timeoutMs: 1_000,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  const pending = source.getSnapshot();
  t.mock.timers.tick(1_000);
  await assert.rejects(pending, /ISPU request timed out/);
});

const reading = (id, band, value, overrides = {}) => ({
  id,
  provider: 'eccc',
  band,
  value,
  stationId: id,
  observedMs: NOW - HOUR,
  ...overrides,
});
const stub = (impl) => ({ getSnapshot: impl });
const quiet = (t) => t.mock.method(console, 'warn', () => {});

test('the composite source merges providers and sorts worst first', async () => {
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => [reading('a', 'low', 2), reading('b', 'high', 8)]),
      stub(async () => [
        reading('c', 'very-high', 250, { provider: 'klhk' }),
        reading('d', 'moderate', 60, { provider: 'klhk' }),
      ]),
    ],
    { now: () => NOW },
  );
  const merged = await composite.getSnapshot();
  assert.deepEqual(
    merged.map((r) => r.id),
    ['c', 'b', 'd', 'a'],
  );
});

test('the composite source passes the caller signal to every source', async () => {
  const signals = [];
  const caller = new AbortController();
  const capture = async ({ signal }) => {
    signals.push(signal);
    return [];
  };
  await createCompositeAirQualitySource([stub(capture), stub(capture)], {
    now: () => NOW,
  }).getSnapshot({ signal: caller.signal });
  assert.deepEqual(signals, [caller.signal, caller.signal]);
});

test('one provider failing on the first call does not blank the others', async (t) => {
  const warn = quiet(t);
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => {
        throw new Error('ECCC down');
      }),
      stub(async () => [reading('c', 'low', 10, { provider: 'klhk' })]),
    ],
    { now: () => NOW },
  );
  const merged = await composite.getSnapshot();
  assert.deepEqual(
    merged.map((r) => r.id),
    ['c'],
  );
  assert.equal(warn.mock.callCount(), 1);
});

test('a provider that succeeded then fails has its last good readings reused', async (t) => {
  quiet(t);
  let fail = false;
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => {
        if (fail) throw new Error('flaky');
        return [reading('a', 'moderate', 4)];
      }),
      stub(async () => [reading('c', 'low', 10, { provider: 'klhk' })]),
    ],
    { now: () => NOW },
  );
  assert.equal((await composite.getSnapshot()).length, 2);
  fail = true;
  const merged = await composite.getSnapshot();
  assert.deepEqual(
    merged.map((r) => r.id),
    ['a', 'c'],
  );
});

test('reused readings older than the observation limit are dropped', async (t) => {
  quiet(t);
  let clock = NOW;
  let fail = false;
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => {
        if (fail) throw new Error('flaky');
        return [
          reading('old', 'low', 2, { observedMs: NOW - 2 * HOUR }),
          reading('new', 'low', 1, { observedMs: NOW - HOUR }),
        ];
      }),
      stub(async () => [reading('c', 'low', 10, { provider: 'klhk' })]),
    ],
    { now: () => clock },
  );
  await composite.getSnapshot();
  fail = true;
  // 'old' is 6h + 1ms old; 'new' is 5h + 1ms old and still allowed.
  clock = NOW + 4 * HOUR + 1;
  let merged = await composite.getSnapshot();
  assert.deepEqual(merged.map((r) => r.id).sort(), ['c', 'new']);
  // Everything from the failing provider has aged out; the other still serves.
  clock = NOW + 6 * HOUR;
  merged = await composite.getSnapshot();
  assert.deepEqual(
    merged.map((r) => r.id),
    ['c'],
  );
  // Aged-out readings are not resurrected when the clock moves back.
  clock = NOW;
  merged = await composite.getSnapshot();
  assert.deepEqual(
    merged.map((r) => r.id),
    ['c'],
  );
});

test('every provider failing with nothing cached throws a neutral error', async (t) => {
  quiet(t);
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => {
        throw new Error('ECCC down');
      }),
      stub(async () => {
        throw new Error('ISPU down');
      }),
    ],
    { now: () => NOW },
  );
  await assert.rejects(composite.getSnapshot(), (error) => {
    assert.equal(error.message, 'Air quality request failed');
    assert.deepEqual(
      error.cause.map((cause) => cause.message),
      ['ECCC down', 'ISPU down'],
    );
    return true;
  });
});

test('every provider failing still serves fresh cached readings', async (t) => {
  quiet(t);
  let fail = false;
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => {
        if (fail) throw new Error('down');
        return [reading('a', 'low', 2)];
      }),
    ],
    { now: () => NOW },
  );
  await composite.getSnapshot();
  fail = true;
  assert.deepEqual(
    (await composite.getSnapshot()).map((r) => r.id),
    ['a'],
  );
});

test('every provider failing with only expired cache throws', async (t) => {
  quiet(t);
  let clock = NOW;
  let fail = false;
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => {
        if (fail) throw new Error('down');
        return [reading('a', 'low', 2)];
      }),
    ],
    { now: () => clock },
  );
  await composite.getSnapshot();
  fail = true;
  clock = NOW + 6 * HOUR;
  await assert.rejects(composite.getSnapshot(), /Air quality request failed/);
});

test('a provider returning a non-array counts as an empty success', async () => {
  const composite = createCompositeAirQualitySource(
    [stub(async () => null), stub(async () => [reading('a', 'low', 2)])],
    { now: () => NOW },
  );
  assert.deepEqual(
    (await composite.getSnapshot()).map((r) => r.id),
    ['a'],
  );
});

test('the composite source rejects when its signal is aborted', async () => {
  const caller = new AbortController();
  const composite = createCompositeAirQualitySource(
    [
      stub(async () => {
        caller.abort(new Error('layer disabled'));
        return [reading('a', 'low', 2)];
      }),
    ],
    { now: () => NOW },
  );
  await assert.rejects(
    composite.getSnapshot({ signal: caller.signal }),
    /layer disabled/,
  );
});

test('the composite source requires valid snapshot sources', () => {
  for (const bad of [
    [],
    null,
    undefined,
    'sources',
    [{}],
    [stub(async () => []), { getSnapshot: 'no' }],
    [null],
  ])
    assert.throws(
      () => createCompositeAirQualitySource(bad),
      (error) =>
        error instanceof TypeError &&
        /requires snapshot sources/.test(error.message),
    );
});
