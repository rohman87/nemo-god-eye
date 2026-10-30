import assert from 'node:assert/strict';
import test from 'node:test';
import { airQualityIndonesiaProxy } from './airQualityIndonesia.js';

const UPSTREAM = 'https://opsroom.sipongidata.my.id/api/aqms';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 30, 12);

const feature = (lon, lat, overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    val: 42,
    waktu: '2026-10-30 19:00:00',
    kota: 'Jakarta Pusat',
    provinsi: 'DKI Jakarta',
    alamat: 'Jl. Medan Merdeka',
    ...overrides,
  },
});
const upstreamBody = () => ({
  type: 'FeatureCollection',
  features: [feature(106.8456, -6.2088), feature(107.6, -6.9, { val: 120 })],
});
const jsonResponse = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const okResponse = () => jsonResponse(upstreamBody());

// Drives the plugin through its middleware hook with a fake clock, a scripted
// upstream and fake req/res objects. `script` is called once per upstream fetch.
function setup(script = okResponse) {
  const state = { now: NOW, calls: [] };
  let handler;
  let prefix;
  airQualityIndonesiaProxy({
    now: () => state.now,
    fetchImpl: async (url, init) => {
      state.calls.push({ url, init });
      return script(state.calls.length);
    },
  }).configureServer({
    middlewares: {
      use: (path, h) => {
        prefix = path;
        handler = h;
      },
    },
  });
  const request = async ({
    method = 'GET',
    url = '/',
    remoteAddress = '10.0.0.1',
  } = {}) => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method, url, socket: { remoteAddress } }, res);
    return res;
  };
  return { state, request, prefix: () => prefix };
}

test('GET serves normalized stations with a 200', async () => {
  const { state, request, prefix } = setup();
  const res = await request();
  assert.equal(prefix(), '/api/air-quality/indonesia');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Data-Stale'], undefined);
  assert.equal(res.body.fetchedAt, NOW);
  assert.equal(res.body.stale, false);
  assert.deepEqual(
    res.body.stations.map(({ id, value, province }) => ({
      id,
      value,
      province,
    })),
    [
      { id: '-6.2088,106.8456', value: 42, province: 'DKI Jakarta' },
      { id: '-6.9000,107.6000', value: 120, province: 'DKI Jakarta' },
    ],
  );
  // Fixed origin, no redirects followed, bounded by a deadline.
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, UPSTREAM);
  assert.equal(state.calls[0].init.redirect, 'error');
  assert.ok(state.calls[0].init.signal instanceof AbortSignal);
});

test('the preview server is wired to the same route', () => {
  let prefix;
  airQualityIndonesiaProxy().configurePreviewServer({
    middlewares: { use: (path) => (prefix = path) },
  });
  assert.equal(prefix, '/api/air-quality/indonesia');
  assert.equal(airQualityIndonesiaProxy().name, 'air-quality-indonesia');
});

test('non-GET methods get 405 and never reach the upstream', async () => {
  const { state, request } = setup();
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const res = await request({ method });
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, 'GET');
    assert.deepEqual(res.body, { error: 'method_not_allowed' });
  }
  assert.equal(state.calls.length, 0);
});

test('a sub-path is an unknown route and ignores the query string', async () => {
  const { state, request } = setup();
  const unknown = await request({ url: '/extra' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'unknown_route' });
  assert.equal(state.calls.length, 0);
  assert.equal((await request({ url: '/?x=1' })).status, 200);
});

test('a fresh cache is served without refetching for ten minutes', async () => {
  const { state, request } = setup();
  await request();
  state.now = NOW + 10 * MINUTE - 1;
  const hit = await request();
  assert.equal(hit.status, 200);
  assert.equal(hit.body.stale, false);
  assert.equal(hit.body.fetchedAt, NOW);
  assert.equal(state.calls.length, 1);
  state.now = NOW + 10 * MINUTE;
  const refreshed = await request();
  assert.equal(state.calls.length, 2);
  assert.equal(refreshed.body.fetchedAt, NOW + 10 * MINUTE);
});

test('concurrent requests share one upstream call', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { state, request } = setup(async () => {
    await gate;
    return okResponse();
  });
  const first = request();
  const second = request({ remoteAddress: '10.0.0.2' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(state.calls.length, 1);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body, b.body);
});

test('an upstream failure serves the cached snapshot as stale', async () => {
  const { state, request } = setup((call) =>
    call === 1 ? okResponse() : new Response('down', { status: 500 }),
  );
  const fresh = await request();
  state.now = NOW + 10 * MINUTE;
  const stale = await request();
  assert.equal(state.calls.length, 2);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  // The stale answer still carries the original snapshot.
  assert.equal(stale.body.fetchedAt, NOW);
  assert.deepEqual(stale.body.stations, fresh.body.stations);
});

test('a snapshot older than three hours is no longer served as stale', async () => {
  const { state, request } = setup((call) =>
    call === 1 ? okResponse() : new Response('down', { status: 500 }),
  );
  await request();
  // Exactly three hours old is still servable.
  state.now = NOW + 3 * HOUR;
  const edge = await request();
  assert.equal(edge.status, 200);
  assert.equal(edge.body.stale, true);
  // One millisecond past, with the failure backoff elapsed, it is not.
  state.now = NOW + 3 * HOUR + 1 + MINUTE;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.deepEqual(gone.body, { error: 'air_quality_unavailable' });
});

test('an upstream failure with no cache is a 502', async () => {
  const { request } = setup(() => new Response('down', { status: 503 }));
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'air_quality_unavailable' });
  assert.equal(res.headers['X-Data-Stale'], undefined);
});

test('a network error from the upstream is a 502 too', async () => {
  const { request } = setup(() => {
    throw new TypeError('fetch failed');
  });
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'air_quality_unavailable' });
});

test('a failed refresh backs off for sixty seconds', async () => {
  const { state, request } = setup(() => new Response('x', { status: 500 }));
  assert.equal((await request()).status, 502);
  assert.equal(state.calls.length, 1);
  state.now = NOW + MINUTE - 1;
  assert.equal((await request()).status, 502);
  assert.equal(state.calls.length, 1, 'no refetch inside the backoff');
  state.now = NOW + MINUTE;
  await request();
  assert.equal(state.calls.length, 2, 'the origin is retried after it');
});

test('the backoff serves a cached snapshot as stale without refetching', async () => {
  const { state, request } = setup((call) =>
    call === 1 ? okResponse() : new Response('down', { status: 500 }),
  );
  await request();
  state.now = NOW + 10 * MINUTE;
  await request();
  assert.equal(state.calls.length, 2);
  state.now = NOW + 10 * MINUTE + 30_000;
  const res = await request();
  assert.equal(state.calls.length, 2);
  assert.equal(res.status, 200);
  assert.equal(res.body.stale, true);
});

test('a successful refresh after a failure clears the backoff', async () => {
  const { state, request } = setup((call) =>
    call === 1 ? new Response('x', { status: 500 }) : okResponse(),
  );
  assert.equal((await request()).status, 502);
  state.now = NOW + MINUTE;
  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.stale, false);
  assert.equal(state.calls.length, 2);
});

test('empty, invalid and non-JSON upstream bodies keep the previous cache', async () => {
  const bodies = [
    () => jsonResponse({ type: 'FeatureCollection', features: [] }),
    () => jsonResponse({}),
    () => jsonResponse({ features: 'no' }),
    // Every feature unusable: also an empty snapshot.
    () =>
      jsonResponse({
        features: [feature(-79, 43), feature(106, -6, { val: 'x' })],
      }),
    () => new Response('<html>oops</html>', { status: 200 }),
  ];
  for (const bad of bodies) {
    const { state, request } = setup((call) =>
      call === 1 ? okResponse() : bad(),
    );
    const first = await request();
    state.now = NOW + 10 * MINUTE;
    const res = await request();
    assert.equal(state.calls.length, 2);
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, true);
    assert.equal(res.headers['X-Data-Stale'], 'true');
    assert.deepEqual(res.body.stations, first.body.stations);
  }
});

test('an empty first pull is an error, not an empty layer', async () => {
  const { request } = setup(() => jsonResponse({ features: [] }));
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'air_quality_unavailable' });
});

test('a client is limited to sixty requests a minute', async () => {
  const { state, request } = setup();
  for (let index = 0; index < 60; index += 1)
    assert.equal((await request()).status, 200, `request ${index + 1}`);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.deepEqual(limited.body, { error: 'rate_limited' });
  // Another client is unaffected, and the cache absorbed every request.
  assert.equal((await request({ remoteAddress: '10.0.0.9' })).status, 200);
  assert.equal(state.calls.length, 1);
});
