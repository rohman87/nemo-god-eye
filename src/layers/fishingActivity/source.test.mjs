import assert from 'node:assert/strict';
import test from 'node:test';
import { createGfwFishingSource } from './source.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const json = (body, init) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const item = (id) => ({
  id,
  lat: 3.5,
  lon: 108.2,
  startMs: NOW - 5_000_000,
  endMs: NOW - 1_000_000,
  vesselName: 'KM Bahari',
  flag: 'IDN',
  durationH: 1.1,
});
const body = () => ({
  configured: true,
  fetchedAt: NOW,
  windowStart: '2026-10-16',
  windowEnd: '2026-10-30',
  fishing: [item('f1')],
  gaps: [{ ...item('g1'), intentional: null }],
});

test('the snapshot comes from the proxy route and is validated', async () => {
  const calls = [];
  const source = createGfwFishingSource({
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json({ ...body(), fishing: [item('f1'), { id: 'bad id' }] });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(calls[0].url, '/api/fishing/indonesia');
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.fishing.length, 1);
  assert.equal(snapshot.gaps.length, 1);
  assert.equal(snapshot.windowEnd, '2026-10-30');
});

test('an unconfigured proxy yields an empty configured:false snapshot', async () => {
  const source = createGfwFishingSource({
    now: () => NOW,
    fetchImpl: async () => json({ configured: false }),
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.configured, false);
  assert.deepEqual(snapshot.fishing, []);
  assert.deepEqual(snapshot.gaps, []);
});

test('a rejected token has its own message', async () => {
  const source = createGfwFishingSource({
    fetchImpl: async () =>
      json({ error: 'gfw_token_rejected' }, { status: 502 }),
  });
  await assert.rejects(
    source.getSnapshot(),
    /Global Fishing Watch rejected the API token/,
  );
});

test('other failures report the HTTP status', async () => {
  const unavailable = createGfwFishingSource({
    fetchImpl: async () =>
      json({ error: 'fishing_unavailable' }, { status: 502 }),
  });
  await assert.rejects(unavailable.getSnapshot(), /^Error: Fishing HTTP 502$/);
  const limited = createGfwFishingSource({
    fetchImpl: async () => json({ error: 'rate_limited' }, { status: 429 }),
  });
  await assert.rejects(limited.getSnapshot(), /Fishing HTTP 429/);
  const garbled = createGfwFishingSource({
    fetchImpl: async () => new Response('<html>', { status: 502 }),
  });
  await assert.rejects(garbled.getSnapshot(), /Fishing HTTP 502/);
});

test('a malformed body is an error', async () => {
  const source = createGfwFishingSource({
    fetchImpl: async () => json({ configured: true, fishing: 'x' }),
  });
  await assert.rejects(source.getSnapshot(), /Malformed fishing response/);
});

test('a caller abort and the deadline both cancel the request', async () => {
  const hang = (_url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  const aborted = new AbortController();
  const pending = createGfwFishingSource({ fetchImpl: hang }).getSnapshot({
    signal: aborted.signal,
  });
  aborted.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
  await assert.rejects(
    createGfwFishingSource({ fetchImpl: hang, timeoutMs: 5 }).getSnapshot(),
    /Fishing request timed out/,
  );
});
