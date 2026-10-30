import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { firmsProxy } from './firms.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
// Regional files carry no `instrument` column.
const CSV = `${HEADER}\n-6.2,106.8,330.1,0.4,0.4,2026-10-30,1100,N,n,2.0NRT,290.0,5.5,D\n`;
const REGIONAL_URLS = [
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_24h.csv',
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_SouthEast_Asia_24h.csv',
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv',
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_SouthEast_Asia_24h.csv',
];

// The plugin reads and writes `.gev-cache/firms.json` under process.cwd(), so
// every test runs in a throwaway cwd, with fetch, Date.now and the key stubbed.
function setup(t, { fetchImpl }) {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalKey = process.env.FIRMS_MAP_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firms-proxy-test-'));
  const state = { now: NOW, urls: [] };
  process.chdir(dir);
  delete process.env.FIRMS_MAP_KEY;
  Date.now = () => state.now;
  globalThis.fetch = async (url) => {
    state.urls.push(String(url));
    return fetchImpl(String(url));
  };
  t.mock.method(console, 'warn', () => {});
  t.after(() => {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (originalKey === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = originalKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let handler;
  firmsProxy().configureServer({
    middlewares: {
      use: (_prefix, h) => {
        handler = h;
      },
    },
  });
  const request = async (url = '/') => {
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url }, res);
    return res;
  };
  return { state, dir, request };
}

const csvResponse = () => new Response(CSV, { status: 200 });
const downResponse = () => new Response('down', { status: 500 });

function seedCache(dir, entry) {
  fs.mkdirSync(path.join(dir, '.gev-cache'));
  fs.writeFileSync(
    path.join(dir, '.gev-cache', 'firms.json'),
    JSON.stringify(entry),
  );
}

const seededFire = {
  lat: 1,
  lon: 2,
  acqDate: '2026-10-30',
  acqTime: '1100',
  frp: 1,
};

test('keyless /api/firms fetches only the regional CSVs and fills instrument', async (t) => {
  const { state, request } = setup(t, { fetchImpl: async () => csvResponse() });
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.deepEqual(state.urls, REGIONAL_URLS);
  assert.ok(state.urls.every((url) => !url.includes('/api/area/')));
  assert.equal(res.body.coverage, 'southeast-asia');
  assert.equal(res.body.stale, false);
  assert.equal(res.body.count, 4);
  assert.deepEqual(
    res.body.fires.map((fire) => fire.instrument),
    ['VIIRS', 'VIIRS', 'VIIRS', 'MODIS'],
  );
});

test('keyless refresh writes a southeast-asia tagged disk cache in the cwd', async (t) => {
  const { dir, request } = setup(t, { fetchImpl: async () => csvResponse() });
  await request('/');
  const cache = JSON.parse(
    fs.readFileSync(path.join(dir, '.gev-cache', 'firms.json'), 'utf8'),
  );
  assert.equal(cache.coverage, 'southeast-asia');
});

test('keyless /api/firms/status reports coverage, null transactions and no upstream call', async (t) => {
  const { state, request } = setup(t, { fetchImpl: async () => csvResponse() });
  const res = await request('/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.hasKey, false);
  assert.equal(res.body.transactions, null);
  assert.equal(res.body.coverage, 'southeast-asia');
  assert.equal(res.body.lastFetch, null);
  assert.deepEqual(state.urls, []);
});

test('a legacy untagged (world) disk cache is not served keyless', async (t) => {
  const { dir, state, request } = setup(t, {
    fetchImpl: async () => csvResponse(),
  });
  seedCache(dir, { at: NOW - 1000, sources: [], fires: [seededFire] });
  const status = await request('/status');
  assert.equal(status.body.lastFetch, null);
  assert.equal(status.body.count, null);
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.coverage, 'southeast-asia');
  assert.deepEqual(state.urls, REGIONAL_URLS);
  assert.ok(res.body.fires.every((fire) => fire.lat !== 1));
});

test('a southeast-asia disk cache is served keyless without fetching', async (t) => {
  const { dir, state, request } = setup(t, {
    fetchImpl: async () => csvResponse(),
  });
  seedCache(dir, {
    at: NOW - 1000,
    coverage: 'southeast-asia',
    sources: [],
    fires: [seededFire],
  });
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.coverage, 'southeast-asia');
  assert.equal(res.body.count, 1);
  assert.deepEqual(state.urls, []);
});

test('failed refresh backs off with doubling delay: 30 s, then 60 s', async (t) => {
  const { state, request } = setup(t, {
    fetchImpl: async () => downResponse(),
  });
  const first = await request('/');
  assert.equal(first.status, 502);
  assert.equal(state.urls.length, 4);

  const second = await request('/');
  assert.equal(second.status, 502);
  assert.equal(state.urls.length, 4, 'no upstream calls while backing off');

  state.now += 29_000;
  await request('/');
  assert.equal(state.urls.length, 4, 'still inside the 30 s window');

  state.now += 2_000;
  assert.equal((await request('/')).status, 502);
  assert.equal(state.urls.length, 8, 'refetches once the backoff elapsed');

  // Second failure doubles the delay to 60 s.
  state.now += 31_000;
  await request('/');
  assert.equal(state.urls.length, 8);
  state.now += 30_000;
  await request('/');
  assert.equal(state.urls.length, 12);
});

test('during backoff a stale cache is served as 200 stale:true', async (t) => {
  let fail = false;
  const { state, request } = setup(t, {
    fetchImpl: async () => (fail ? downResponse() : csvResponse()),
  });
  const ok = await request('/');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stale, false);

  // Past the 30 min TTL but the CSV row is still inside the trailing 24 h.
  state.now += 31 * 60_000;
  fail = true;
  state.urls.length = 0;
  const stale = await request('/');
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.coverage, 'southeast-asia');
  assert.equal(state.urls.length, 4);

  const backoff = await request('/');
  assert.equal(backoff.status, 200);
  assert.equal(backoff.body.stale, true);
  assert.equal(state.urls.length, 4, 'no upstream calls while backing off');
});

test('a successful refresh resets the backoff', async (t) => {
  let fail = true;
  const { state, request } = setup(t, {
    fetchImpl: async () => (fail ? downResponse() : csvResponse()),
  });
  assert.equal((await request('/')).status, 502);
  fail = false;
  state.now += 31_000;
  const ok = await request('/');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stale, false);
  assert.equal(state.urls.length, 8);
});
