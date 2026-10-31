import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { fishingIndonesiaProxy } from './fishingIndonesia.js';

const UPSTREAM =
  'https://gateway.api.globalfishingwatch.org/v3/events?offset=0&limit=500';
const FISHING_DATASET = 'public-global-fishing-events:latest';
const GAPS_DATASET = 'public-global-gaps-events:latest';
const TOKEN = 'tok-SECRET-0123456789';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 30, 12);

const rawEntry = (id, over = {}) => ({
  id,
  type: 'fishing',
  start: '2026-10-25T00:00:00Z',
  end: '2026-10-25T03:00:00Z',
  position: { lat: 3.5, lon: 108.2 },
  vessel: {
    id: 'vessel-id-1',
    name: 'KM Sinar Laut',
    ssvid: '525123456',
    flag: 'IDN',
    type: 'fishing',
  },
  regions: { eez: ['8492'] },
  distances: { startDistanceFromPortKm: 12 },
  boundingBox: [108, 3, 109, 4],
  ...over,
});
const page = (entries, over = {}) => ({
  entries,
  limit: 500,
  metadata: {},
  nextOffset: null,
  offset: 0,
  total: entries.length,
  ...over,
});
const json = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const down = () => new Response('down', { status: 500 });
const datasetOf = (init) => JSON.parse(init.body).datasets[0];

const okScript = (init) =>
  datasetOf(init) === FISHING_DATASET
    ? json(page([rawEntry('f1'), rawEntry('f2')]))
    : json(
        page([
          rawEntry('g1', {
            type: 'gap',
            gap: { durationHours: 14.2, intentionalDisabling: true },
          }),
        ]),
      );

// Drives the plugin through its middleware hook with a fake clock, a scripted
// upstream and fake req/res objects. `script(init, callNumber)` runs per fetch.
function setup(script = okScript, { token = TOKEN } = {}) {
  const state = { now: NOW, calls: [], token };
  let handler;
  let prefix;
  fishingIndonesiaProxy({
    now: () => state.now,
    getToken: () => state.token,
    fetchImpl: async (url, init) => {
      state.calls.push({ url, init });
      return script(init, state.calls.length);
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
        this.raw = body;
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
const thenFail = (later) => (init, call) =>
  call <= 2 ? okScript(init) : later(init);

test('GET serves normalised fishing and gap events', async () => {
  const { state, request, prefix } = setup();
  const res = await request();
  assert.equal(prefix(), '/api/fishing/indonesia');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Data-Stale'], undefined);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.fetchedAt, NOW);
  assert.equal(res.body.stale, false);
  assert.equal(res.body.windowEnd, '2026-10-30');
  assert.equal(res.body.windowStart, '2026-10-16');
  assert.deepEqual(res.body.truncated, { fishing: false, gaps: false });
  assert.deepEqual(
    res.body.fishing.map((e) => e.id),
    ['f1', 'f2'],
  );
  assert.equal(res.body.fishing[0].vesselName, 'KM Sinar Laut');
  assert.equal(res.body.fishing[0].flag, 'IDN');
  assert.equal(res.body.fishing[0].durationH, 3);
  assert.equal(res.body.gaps[0].durationH, 14.2);
  assert.equal(res.body.gaps[0].intentional, true);
  // Vessel identifiers never leave the server.
  assert.ok(!res.raw.includes('525123456'));
  assert.ok(!res.raw.includes('vessel-id-1'));
  assert.ok(!res.raw.includes(TOKEN));
  // Two parallel POSTs to the fixed origin, one per dataset.
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls.map((c) => datasetOf(c.init)).sort(), [
    FISHING_DATASET,
    GAPS_DATASET,
  ]);
  for (const call of state.calls) {
    assert.equal(call.url, UPSTREAM);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.ok(call.init.signal instanceof AbortSignal);
    const sent = JSON.parse(call.init.body);
    assert.deepEqual(sent.region, { dataset: 'public-eez-areas', id: 8492 });
    assert.equal(sent.startDate, '2026-10-16');
    assert.equal(sent.endDate, '2026-10-30');
  }
});

test('without a token it answers configured:false and never calls GFW', async () => {
  const { state, request } = setup(okScript, { token: '' });
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { configured: false });
  assert.equal(state.calls.length, 0);
  // Adding the token takes effect on the next request, with no restart.
  state.token = TOKEN;
  const next = await request();
  assert.equal(next.body.configured, true);
  assert.equal(state.calls.length, 2);
});

test('the default token reader follows GFW_API_TOKEN at request time', async () => {
  const saved = process.env.GFW_API_TOKEN;
  let handler;
  const calls = [];
  fishingIndonesiaProxy({
    fetchImpl: async (url, init) => {
      calls.push(url);
      return okScript(init);
    },
  }).configureServer({ middlewares: { use: (_p, h) => (handler = h) } });
  const ask = async () => {
    const res = {
      writeHead() {},
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method: 'GET', url: '/', socket: {} }, res);
    return res.body;
  };
  try {
    delete process.env.GFW_API_TOKEN;
    assert.deepEqual(await ask(), { configured: false });
    process.env.GFW_API_TOKEN = `  ${TOKEN}  `;
    assert.equal((await ask()).configured, true);
    assert.equal(calls.length, 2);
  } finally {
    if (saved === undefined) delete process.env.GFW_API_TOKEN;
    else process.env.GFW_API_TOKEN = saved;
  }
});

test('the preview server is wired to the same route', () => {
  let prefix;
  fishingIndonesiaProxy().configurePreviewServer({
    middlewares: { use: (path) => (prefix = path) },
  });
  assert.equal(prefix, '/api/fishing/indonesia');
  assert.equal(fishingIndonesiaProxy().name, 'fishing-indonesia');
});

test('non-GET methods get 405 and a sub-path 404, with no upstream call', async () => {
  const { state, request } = setup();
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const res = await request({ method });
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, 'GET');
  }
  assert.equal((await request({ url: '/extra' })).status, 404);
  assert.equal(state.calls.length, 0);
  assert.equal((await request({ url: '/?x=1' })).status, 200);
});

test('a fresh cache is served for six hours', async () => {
  const { state, request, upstreamRounds } = setup();
  await request();
  state.now = NOW + 6 * HOUR - 1;
  const hit = await request();
  assert.equal(hit.body.fetchedAt, NOW);
  assert.equal(upstreamRounds(), 1);
  state.now = NOW + 6 * HOUR;
  const refreshed = await request();
  assert.equal(upstreamRounds(), 2);
  assert.equal(refreshed.body.fetchedAt, NOW + 6 * HOUR);
});

test('concurrent requests share one upstream round', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { upstreamRounds, request } = setup(async (init) => {
    await gate;
    return okScript(init);
  });
  const first = request();
  const second = request({ remoteAddress: '10.0.0.2' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(upstreamRounds(), 1);
  assert.deepEqual(a.body, b.body);
});

test('either dataset failing fails the refresh and serves the cache as stale', async () => {
  for (const failing of [FISHING_DATASET, GAPS_DATASET]) {
    const { state, request } = setup(
      thenFail((init) =>
        datasetOf(init) === failing ? down() : okScript(init),
      ),
    );
    const fresh = await request();
    state.now = NOW + 6 * HOUR;
    const stale = await request();
    assert.equal(stale.status, 200);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.headers['X-Data-Stale'], 'true');
    assert.equal(stale.body.fetchedAt, NOW);
    assert.deepEqual(stale.body.fishing, fresh.body.fishing);
    assert.deepEqual(stale.body.gaps, fresh.body.gaps);
  }
});

test('with no cache a failure is a 502 fishing_unavailable', async () => {
  const failed = await setup(() => down()).request();
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'fishing_unavailable' });
  const network = await setup(() => {
    throw new TypeError('fetch failed');
  }).request();
  assert.equal(network.status, 502);
  assert.deepEqual(network.body, { error: 'fishing_unavailable' });
  const malformed = await setup(() => json({ nope: true })).request();
  assert.equal(malformed.status, 502);
});

test('a snapshot older than 24 h is no longer served as stale', async () => {
  const { state, request } = setup(thenFail(() => down()));
  await request();
  state.now = NOW + 24 * HOUR;
  assert.equal((await request()).body.stale, true);
  state.now = NOW + 24 * HOUR + 6 * MINUTE;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.deepEqual(gone.body, { error: 'fishing_unavailable' });
});

test('a failed refresh backs off for five minutes', async () => {
  const { state, request } = setup(() => down());
  assert.equal((await request()).status, 502);
  const rounds = state.calls.length;
  state.now = NOW + 5 * MINUTE - 1;
  assert.equal((await request()).status, 502);
  assert.equal(state.calls.length, rounds, 'no refetch inside the backoff');
  state.now = NOW + 5 * MINUTE;
  await request();
  assert.ok(state.calls.length > rounds, 'retried after the backoff');
});

test('a rejected token is a 502 gfw_token_rejected and backs off for an hour', async () => {
  const { state, request } = setup((init) =>
    datasetOf(init) === FISHING_DATASET
      ? new Response('no', { status: 401 })
      : down(),
  );
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'gfw_token_rejected' });
  const rounds = state.calls.length;
  state.now = NOW + HOUR - 1;
  const inside = await request();
  assert.deepEqual(inside.body, { error: 'gfw_token_rejected' });
  assert.equal(state.calls.length, rounds);
  state.now = NOW + HOUR;
  await request();
  assert.ok(state.calls.length > rounds);
  // 403 counts the same.
  const forbidden = await setup(
    () => new Response('no', { status: 403 }),
  ).request();
  assert.deepEqual(forbidden.body, { error: 'gfw_token_rejected' });
});

test('a new token is not held back by the old one backoff', async () => {
  let accepting = false;
  const { state, request } = setup((init) =>
    accepting ? okScript(init) : new Response('no', { status: 401 }),
  );
  assert.equal((await request()).status, 502);
  accepting = true;
  state.now = NOW + MINUTE;
  assert.equal((await request()).status, 502, 'same token stays backed off');
  state.token = 'tok-another-token';
  assert.equal((await request()).status, 200);
});

test('a successful refresh after a failure clears the backoff', async () => {
  let failing = true;
  const { state, request } = setup((init) =>
    failing ? down() : okScript(init),
  );
  assert.equal((await request()).status, 502);
  failing = false;
  state.now = NOW + 5 * MINUTE;
  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.stale, false);
});

test('a truncated page is flagged', async () => {
  const { request } = setup((init) =>
    datasetOf(init) === FISHING_DATASET
      ? json(page([rawEntry('f1')], { total: 900, nextOffset: 500 }))
      : json(page([])),
  );
  const res = await request();
  assert.deepEqual(res.body.truncated, { fishing: true, gaps: false });
  assert.deepEqual(res.body.gaps, []);
});

test('the token never appears in a response or a log line', async () => {
  const logged = [];
  const warn = mock.method(console, 'warn', (...args) =>
    logged.push(args.map(String).join(' ')),
  );
  const log = mock.method(console, 'error', (...args) =>
    logged.push(args.map(String).join(' ')),
  );
  try {
    const bodies = [];
    const scripts = [
      okScript,
      () => new Response('no', { status: 401 }),
      () => down(),
      () => {
        throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
      },
      // GFW sometimes echoes request details in a 422.
      () =>
        json(
          {
            statusCode: 422,
            messages: [{ title: 'region', detail: `bad ${TOKEN} value` }],
          },
          { status: 422 },
        ),
    ];
    for (const script of scripts) {
      const res = await setup(script).request();
      bodies.push(res.raw);
    }
    for (const text of [...bodies, ...logged])
      assert.ok(!text.includes(TOKEN), `leaked in: ${text}`);
    const rejection = logged.find((line) => line.includes('422'));
    assert.ok(rejection, 'the 422 messages are logged');
    assert.ok(rejection.includes('[token]'));
  } finally {
    warn.mock.restore();
    log.mock.restore();
  }
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
