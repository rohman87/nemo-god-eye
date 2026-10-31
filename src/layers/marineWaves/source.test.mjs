import assert from 'node:assert/strict';
import test from 'node:test';
import { MARINE_STRAITS } from './model.js';
import { createOpenMeteoMarineSource } from './source.js';

const NOW = Date.parse('2026-10-30T16:50:00Z');
const point = (height) => ({
  latitude: 0,
  longitude: 0,
  current: {
    time: '2026-10-30T16:45',
    interval: 900,
    wave_height: height,
    wave_direction: 200,
    wave_period: 7,
  },
  hourly: { time: ['2026-10-30T17:00'], wave_height: [height + 1] },
});
const json = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function build(respond) {
  const calls = [];
  const source = createOpenMeteoMarineSource({
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  });
  return { source, calls };
}

test('one GET carries every strait in order with the agreed query', async () => {
  const { source, calls } = build(() =>
    json(MARINE_STRAITS.map(() => point(1.4))),
  );
  const rows = await source.getSnapshot();
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(
    url.origin + url.pathname,
    'https://marine-api.open-meteo.com/v1/marine',
  );
  assert.equal(
    url.searchParams.get('latitude'),
    MARINE_STRAITS.map((s) => s.lat).join(','),
  );
  assert.equal(
    url.searchParams.get('longitude'),
    MARINE_STRAITS.map((s) => s.lon).join(','),
  );
  assert.equal(
    url.searchParams.get('current'),
    'wave_height,wave_direction,wave_period',
  );
  assert.equal(url.searchParams.get('hourly'), 'wave_height');
  assert.equal(url.searchParams.get('forecast_days'), '2');
  assert.equal(url.searchParams.get('timezone'), 'GMT');
  assert.equal(rows.length, 10);
  assert.equal(rows[0].id, 'sunda');
  assert.equal(rows[0].maxNext24hM, 2.4);
});

test('a custom endpoint is honoured', async () => {
  const calls = [];
  const source = createOpenMeteoMarineSource({
    endpoint: 'http://localhost:9/marine',
    now: () => NOW,
    fetchImpl: async (url) => {
      calls.push(url);
      return json(MARINE_STRAITS.map(() => point(1)));
    },
  });
  await source.getSnapshot();
  assert.ok(calls[0].startsWith('http://localhost:9/marine?latitude='));
});

test('straits without data are skipped, not an error', async () => {
  const { source } = build(() =>
    json(MARINE_STRAITS.map((_, i) => (i % 2 ? point(null) : point(2)))),
  );
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 5);
});

test('HTTP errors name the status', async () => {
  const { source } = build(() => new Response('no', { status: 429 }));
  await assert.rejects(source.getSnapshot(), /Marine HTTP 429/);
});

test('a non-array or short payload is malformed', async () => {
  for (const body of [{ error: true }, [point(1)], 'x', null]) {
    const { source } = build(() => json(body));
    await assert.rejects(source.getSnapshot(), /Malformed marine response/);
  }
});

test('the caller can abort and a stalled request times out', async () => {
  const { source } = build(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      ),
  );
  const controller = new AbortController();
  const pending = source.getSnapshot({ signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);

  const slow = createOpenMeteoMarineSource({
    timeoutMs: 10,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      ),
  });
  await assert.rejects(slow.getSnapshot(), /Marine request timed out/);
});

test('an already-aborted signal never reaches fetch', async () => {
  const { source, calls } = build(() => json([]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getSnapshot({ signal: controller.signal }));
  assert.equal(calls.length, 0);
});
