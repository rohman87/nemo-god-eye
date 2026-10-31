import assert from 'node:assert/strict';
import test from 'node:test';
import { volcanoesIndonesiaProxy } from './volcanoesIndonesia.js';

const LEVELS_URL = 'https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas';
const VONA_URL = 'https://magma.esdm.go.id/vona';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 30, 12);

const levelsHtml = () =>
  `<a href="#">Level III (Siaga)</a>
<tr><td> Merapi - Jawa Tengah <a href="https://magma.esdm.go.id/v1/gunung-api/laporan/x">L</a></td></tr>
<a href="#">Level II (Waspada)</a>
<tr><td> Marapi - Sumatera Barat <a href="https://magma.esdm.go.id/v1/gunung-api/laporan/y">L</a></td></tr>`;
const vonaHtml = () => `
<p class="timeline-title"><span class="square-10 bg-warning mg-r-5"></span>
<a href="https://magma.esdm.go.id/vona?code=MAR">Marapi - 20261030/1148Z</a></p>
<p class="timeline-text">Eruption at 1148 UTC.</p>`;
const html = (body, init) =>
  new Response(body, { headers: { 'content-type': 'text/html' }, ...init });
const down = () => new Response('down', { status: 500 });

const okScript = (url) =>
  url === LEVELS_URL ? html(levelsHtml()) : html(vonaHtml());

// Drives the plugin through its middleware hook with a fake clock, a scripted
// upstream and fake req/res objects. `script(url, callNumber)` runs per fetch.
function setup(script = okScript) {
  const state = { now: NOW, calls: [] };
  let handler;
  let prefix;
  volcanoesIndonesiaProxy({
    now: () => state.now,
    fetchImpl: async (url, init) => {
      state.calls.push({ url, init });
      return script(url, state.calls.length);
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
  const upstreamRounds = () => state.calls.length / 2;
  return { state, request, prefix: () => prefix, upstreamRounds };
}

/** Succeeds on the first round (calls 1-2), then applies `later`. */
const thenFail = (later) => (url, call) =>
  call <= 2 ? okScript(url) : later(url);

test('GET serves levels and notices with a 200', async () => {
  const { state, request, prefix } = setup();
  const res = await request();
  assert.equal(prefix(), '/api/volcanoes/indonesia');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Data-Stale'], undefined);
  assert.equal(res.body.fetchedAt, NOW);
  assert.equal(res.body.stale, false);
  assert.equal(res.body.noticesStale, false);
  assert.deepEqual(
    res.body.levels.map(({ name, level }) => [name, level]),
    [
      ['Merapi', 3],
      ['Marapi', 2],
    ],
  );
  assert.equal(res.body.notices[0].code, 'MAR');
  assert.equal(res.body.notices[0].color, 'ORANGE');
  // Both fixed origins, no redirects followed, bounded by a deadline.
  assert.deepEqual(state.calls.map((c) => c.url).sort(), [
    LEVELS_URL,
    VONA_URL,
  ]);
  for (const call of state.calls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers.Accept, 'text/html');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test('the preview server is wired to the same route', () => {
  let prefix;
  volcanoesIndonesiaProxy().configurePreviewServer({
    middlewares: { use: (path) => (prefix = path) },
  });
  assert.equal(prefix, '/api/volcanoes/indonesia');
  assert.equal(volcanoesIndonesiaProxy().name, 'volcanoes-indonesia');
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
  assert.equal(state.calls.length, 0);
  assert.equal((await request({ url: '/?x=1' })).status, 200);
});

test('a fresh cache is served without refetching for thirty minutes', async () => {
  const { state, request, upstreamRounds } = setup();
  await request();
  state.now = NOW + 30 * MINUTE - 1;
  const hit = await request();
  assert.equal(hit.body.fetchedAt, NOW);
  assert.equal(upstreamRounds(), 1);
  state.now = NOW + 30 * MINUTE;
  const refreshed = await request();
  assert.equal(upstreamRounds(), 2);
  assert.equal(refreshed.body.fetchedAt, NOW + 30 * MINUTE);
});

test('concurrent requests share one upstream round', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { upstreamRounds, request } = setup(async (url) => {
    await gate;
    return okScript(url);
  });
  const first = request();
  const second = request({ remoteAddress: '10.0.0.2' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(upstreamRounds(), 1);
  assert.deepEqual(a.body, b.body);
});

test('a levels failure serves the cached snapshot as stale', async () => {
  const { state, request } = setup(thenFail(() => down()));
  const fresh = await request();
  state.now = NOW + 30 * MINUTE;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.fetchedAt, NOW);
  assert.deepEqual(stale.body.levels, fresh.body.levels);
});

test('a snapshot older than six hours is no longer served as stale', async () => {
  const { state, request } = setup(thenFail(() => down()));
  await request();
  state.now = NOW + 6 * HOUR;
  const edge = await request();
  assert.equal(edge.status, 200);
  assert.equal(edge.body.stale, true);
  state.now = NOW + 6 * HOUR + 1 + MINUTE;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.deepEqual(gone.body, { error: 'volcanoes_unavailable' });
});

test('a levels failure with no cache is a 502, as is a network error', async () => {
  const failed = await setup(() => down()).request();
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'volcanoes_unavailable' });
  assert.equal(failed.headers['X-Data-Stale'], undefined);
  const network = await setup(() => {
    throw new TypeError('fetch failed');
  }).request();
  assert.equal(network.status, 502);
});

test('an unparseable levels page is an error and keeps the previous cache', async () => {
  const bad = [
    () => html('<html>oops</html>'),
    () => html(''),
    () => html('<a>Level III (Siaga)</a>'),
  ];
  for (const page of bad) {
    const { state, request } = setup((url, call) =>
      call <= 2 || url !== LEVELS_URL ? okScript(url) : page(),
    );
    const first = await request();
    state.now = NOW + 30 * MINUTE;
    const res = await request();
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, true);
    assert.deepEqual(res.body.levels, first.body.levels);
  }
  const first = await setup(() => html('<html>oops</html>')).request();
  assert.equal(first.status, 502);
});

test('a failed refresh backs off for sixty seconds', async () => {
  const { state, request } = setup(() => down());
  assert.equal((await request()).status, 502);
  const rounds = state.calls.length;
  state.now = NOW + MINUTE - 1;
  assert.equal((await request()).status, 502);
  assert.equal(state.calls.length, rounds, 'no refetch inside the backoff');
  state.now = NOW + MINUTE;
  await request();
  assert.ok(state.calls.length > rounds, 'the origin is retried after it');
});

test('the backoff serves a cached snapshot as stale without refetching', async () => {
  const { state, request } = setup(thenFail(() => down()));
  await request();
  state.now = NOW + 30 * MINUTE;
  await request();
  const calls = state.calls.length;
  state.now = NOW + 30 * MINUTE + 30_000;
  const res = await request();
  assert.equal(state.calls.length, calls);
  assert.equal(res.body.stale, true);
});

test('a successful refresh after a failure clears the backoff', async () => {
  let failing = true;
  const { state, request } = setup((url) => (failing ? down() : okScript(url)));
  assert.equal((await request()).status, 502);
  failing = false;
  state.now = NOW + MINUTE;
  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.stale, false);
});

test('a VONA-only failure serves fresh levels with no notices', async () => {
  const { request } = setup((url) =>
    url === VONA_URL ? down() : okScript(url),
  );
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.stale, false);
  assert.equal(res.headers['X-Data-Stale'], undefined);
  assert.equal(res.body.levels.length, 2);
  assert.deepEqual(res.body.notices, []);
  assert.equal(res.body.noticesStale, true);
});

test('a VONA-only failure keeps the previous notices for under six hours', async () => {
  let vonaDown = false;
  const { state, request } = setup((url) =>
    url === VONA_URL && vonaDown ? down() : okScript(url),
  );
  const first = await request();
  vonaDown = true;
  state.now = NOW + 30 * MINUTE;
  const carried = await request();
  assert.equal(carried.body.stale, false);
  assert.equal(carried.body.noticesStale, true);
  assert.deepEqual(carried.body.notices, first.body.notices);
  // Notices are bounded by their own age, not by the latest levels pull.
  state.now = NOW + 5 * HOUR;
  assert.equal((await request()).body.notices.length, 1);
  state.now = NOW + 6 * HOUR;
  const expired = await request();
  assert.deepEqual(expired.body.notices, []);
  assert.equal(expired.body.noticesStale, true);
});

test('a recovered VONA page clears noticesStale', async () => {
  let vonaDown = true;
  const { state, request } = setup((url) =>
    url === VONA_URL && vonaDown ? down() : okScript(url),
  );
  assert.equal((await request()).body.noticesStale, true);
  vonaDown = false;
  state.now = NOW + 30 * MINUTE;
  const res = await request();
  assert.equal(res.body.noticesStale, false);
  assert.equal(res.body.notices.length, 1);
});

test('a client is limited to sixty requests a minute', async () => {
  const { upstreamRounds, request } = setup();
  for (let index = 0; index < 60; index += 1)
    assert.equal((await request()).status, 200, `request ${index + 1}`);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.deepEqual(limited.body, { error: 'rate_limited' });
  assert.equal((await request({ remoteAddress: '10.0.0.9' })).status, 200);
  assert.equal(upstreamRounds(), 1);
});
