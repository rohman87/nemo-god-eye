import assert from 'node:assert/strict';
import test from 'node:test';
import { createPetaBencanaSource } from './source.js';

const NOW = Date.parse('2026-10-30T06:00:00Z');
const report = (pkey = '1') => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [106.82, -6.2] },
  properties: {
    pkey,
    created_at: new Date(NOW - 3_600_000).toISOString(),
    disaster_type: 'flood',
    tags: { city: 'Jakarta' },
  },
});
const json = (data, init) =>
  new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const make = (fetchImpl, options = {}) =>
  createPetaBencanaSource({ fetchImpl, now: () => NOW, ...options });

test('requests seven days of geojson without a format parameter', async () => {
  let seen;
  const source = make(async (url, init) => {
    seen = { url, init };
    return json({ statusCode: 200, result: { features: [report()] } });
  });
  const rows = await source.getSnapshot();
  assert.equal(
    seen.url,
    'https://data.petabencana.id/reports?timeperiod=604800&geoformat=geojson',
  );
  assert.ok(!new URL(seen.url).searchParams.has('format'));
  assert.equal(seen.init.headers.Accept, 'application/json');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].city, 'Jakarta');
});

test('honours a custom endpoint', async () => {
  let url;
  const source = make(
    async (u) => {
      url = u;
      return json({ result: { features: [] } });
    },
    { endpoint: 'https://example.test/r' },
  );
  assert.deepEqual(await source.getSnapshot(), []);
  assert.ok(url.startsWith('https://example.test/r?'));
});

test('HTTP errors name the status', async () => {
  const source = make(async () => new Response('no', { status: 503 }));
  await assert.rejects(source.getSnapshot(), {
    message: 'Disaster reports HTTP 503',
  });
});

test('malformed bodies throw a stable message', async () => {
  for (const response of [
    () => json({ result: { features: 'x' } }),
    () => json([]),
    () => new Response('<html>', { status: 200 }),
  ]) {
    const source = make(async () => response());
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed disaster report response',
    });
  }
});

test('an oversize body is rejected', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const source = make(async () => new Response(big, { status: 200 }));
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.equal(error.code, 'RESPONSE_TOO_LARGE');
    return true;
  });
});

test('times out a stalled request', async () => {
  const source = make(
    (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
    { timeoutMs: 10 },
  );
  await assert.rejects(source.getSnapshot(), {
    message: 'Disaster reports request timed out',
  });
});

test('the caller signal aborts the request', async () => {
  const controller = new AbortController();
  const source = make(
    (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  );
  const pending = source.getSnapshot({ signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, { message: 'stop' });
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), {
    message: 'stop',
  });
});
