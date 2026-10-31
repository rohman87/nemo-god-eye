import assert from 'node:assert/strict';
import test from 'node:test';
import { createMagmaVolcanoSource } from './source.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const json = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const body = () => ({
  fetchedAt: NOW,
  levels: [{ name: 'Merapi', province: 'Jawa Tengah', level: 3 }],
  notices: [],
});

test('the source requests the same-origin proxy and returns the snapshot', async () => {
  const calls = [];
  const source = createMagmaVolcanoSource({
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json(body());
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(calls[0].url, '/api/volcanoes/indonesia');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(snapshot.volcanoes.find((v) => v.id === 'merapi').level, 3);
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(snapshot.noticesStale, false);
});

test('the source honours a custom endpoint, HTTP errors and bad bodies', async () => {
  const urls = [];
  const make = (response) =>
    createMagmaVolcanoSource({
      endpoint: '/custom',
      now: () => NOW,
      fetchImpl: async (url) => {
        urls.push(url);
        return response;
      },
    });
  await assert.rejects(
    make(new Response('x', { status: 502 })).getSnapshot(),
    /Volcano HTTP 502/,
  );
  await assert.rejects(
    make(json({ levels: 'no' })).getSnapshot(),
    /Malformed volcano response/,
  );
  assert.deepEqual(urls, ['/custom', '/custom']);
});

test('an aborted caller signal rejects before fetching', async () => {
  let called = false;
  const source = createMagmaVolcanoSource({
    fetchImpl: async () => {
      called = true;
      return json(body());
    },
  });
  await assert.rejects(
    source.getSnapshot({ signal: AbortSignal.abort(new Error('stop')) }),
    /stop/,
  );
  assert.equal(called, false);
});
