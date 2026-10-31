import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FISHING_BOUNDS,
  cleanText,
  compareFishing,
  compareGaps,
  createFishingOverlayEntry,
  eezLineStyle,
  fishingSnapshot,
  longestGaps,
  mapAnalystRecord,
  normalizeGfwEvent,
  normalizeGfwEvents,
  snapshotIsStale,
  wholeHours,
} from './model.js';
import { INDONESIA_EEZ_LINES } from './eezBoundary.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const HOUR = 60 * 60 * 1000;
const NUL = String.fromCharCode(0);
const BIDI_OVERRIDE = String.fromCharCode(0x202e);

const entry = (over = {}) => ({
  id: 'abc123:def-4',
  type: 'fishing',
  start: '2026-10-25T00:00:00Z',
  end: '2026-10-25T03:30:00Z',
  position: { lat: 3.5, lon: 108.2 },
  vessel: {
    id: 'vessel-secret-id',
    name: 'KM Sinar Laut',
    ssvid: '525123456',
    flag: 'idn',
    type: 'fishing',
  },
  ...over,
});
const gapEntry = (over = {}) =>
  entry({
    type: 'gap',
    gap: { durationHours: 14.26, intentionalDisabling: true },
    ...over,
  });
const item = (over = {}) => ({
  id: 'e1',
  lat: 3.5,
  lon: 108.2,
  startMs: NOW - 3 * HOUR,
  endMs: NOW - HOUR,
  vesselName: 'KM Bahari',
  flag: 'IDN',
  durationH: 2,
  ...over,
});

test('a fishing event is normalised and carries no vessel identifiers', () => {
  const result = normalizeGfwEvent(entry(), 'fishing');
  assert.deepEqual(result, {
    id: 'abc123:def-4',
    lat: 3.5,
    lon: 108.2,
    startMs: Date.parse('2026-10-25T00:00:00Z'),
    endMs: Date.parse('2026-10-25T03:30:00Z'),
    vesselName: 'KM Sinar Laut',
    flag: 'IDN',
    durationH: 3.5,
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes('525123456'));
  assert.ok(!text.includes('vessel-secret-id'));
});

test('a gap reads durationHours and intentionalDisabling defensively', () => {
  const result = normalizeGfwEvent(gapEntry(), 'gaps');
  assert.equal(result.durationH, 14.3);
  assert.equal(result.intentional, true);
  const fallback = normalizeGfwEvent(gapEntry({ gap: undefined }), 'gaps');
  assert.equal(fallback.durationH, 3.5, 'falls back to end minus start');
  assert.equal(fallback.intentional, null);
  const odd = normalizeGfwEvent(
    gapEntry({ gap: { durationHours: 'x', intentionalDisabling: 'yes' } }),
    'gaps',
  );
  assert.equal(odd.durationH, 3.5);
  assert.equal(odd.intentional, null);
  assert.equal(
    normalizeGfwEvent(gapEntry({ gap: { durationHours: 99999 } }), 'gaps')
      .durationH,
    2000,
  );
  assert.equal(
    normalizeGfwEvent(gapEntry({ gap: { durationHours: -4 } }), 'gaps')
      .durationH,
    0,
  );
});

test('unusable events are skipped', () => {
  const bad = [
    null,
    'x',
    entry({ id: '' }),
    entry({ id: 'a'.repeat(65) }),
    entry({ id: 'has space' }),
    entry({ id: 'a/b' }),
    entry({ id: 7 }),
    entry({ position: null }),
    entry({ position: { lat: '3', lon: 108 } }),
    entry({ position: { lat: 3, lon: NaN } }),
    entry({ position: { lat: 20, lon: 108 } }),
    entry({ position: { lat: 3, lon: 80 } }),
    entry({ start: 'nope' }),
    entry({ start: 12345 }),
  ];
  for (const raw of bad) assert.equal(normalizeGfwEvent(raw, 'fishing'), null);
  // The bounds are the documented ones.
  assert.deepEqual(FISHING_BOUNDS, {
    south: -15,
    north: 10,
    west: 90,
    east: 145,
  });
  assert.ok(
    normalizeGfwEvent(entry({ position: { lat: -15, lon: 145 } }), 'fishing'),
  );
});

test('names are cleaned and flags restricted to letters', () => {
  const result = normalizeGfwEvent(
    entry({
      vessel: {
        name: `  KM${NUL} ${BIDI_OVERRIDE}Sinar\n   Laut ${'x'.repeat(100)}`,
        flag: 'I1',
      },
    }),
    'fishing',
  );
  assert.ok(result.vesselName.length <= 60);
  assert.ok(result.vesselName.startsWith('KM Sinar Laut'));
  assert.ok(!result.vesselName.includes(NUL));
  assert.ok(!result.vesselName.includes(BIDI_OVERRIDE));
  assert.equal(result.flag, '');
  assert.equal(
    normalizeGfwEvent(entry({ vessel: undefined }), 'fishing').vesselName,
    '',
  );
  assert.equal(cleanText(42, 10), '');
});

test('a missing or reversed end collapses to the start', () => {
  const noEnd = normalizeGfwEvent(entry({ end: undefined }), 'fishing');
  assert.equal(noEnd.endMs, noEnd.startMs);
  assert.equal(noEnd.durationH, 0);
  const reversed = normalizeGfwEvent(
    entry({ end: '2026-10-24T00:00:00Z' }),
    'fishing',
  );
  assert.equal(reversed.endMs, reversed.startMs);
});

test('a page is deduplicated, capped and flags truncation', () => {
  assert.equal(normalizeGfwEvents(null, 'fishing'), null);
  assert.equal(normalizeGfwEvents({ entries: 'x' }, 'fishing'), null);
  const page = normalizeGfwEvents(
    { entries: [entry(), entry(), entry({ id: 'b' }), { id: 1 }], total: 9 },
    'fishing',
  );
  assert.deepEqual(
    page.items.map((i) => i.id),
    ['abc123:def-4', 'b'],
  );
  assert.equal(page.truncated, true, 'total exceeds the entries returned');
  const full = normalizeGfwEvents(
    { entries: [entry()], total: 1, nextOffset: null },
    'fishing',
  );
  assert.equal(full.truncated, false);
  assert.equal(
    normalizeGfwEvents(
      { entries: [entry()], total: 1, nextOffset: 500 },
      'gaps',
    ).truncated,
    true,
  );
  const many = normalizeGfwEvents(
    {
      entries: Array.from({ length: 600 }, (_, n) => entry({ id: `e${n}` })),
      total: 600,
    },
    'fishing',
  );
  assert.equal(many.items.length, 500);
  assert.equal(many.truncated, true);
});

test('the client re-validates a proxy snapshot', () => {
  const snapshot = fishingSnapshot(
    {
      configured: true,
      fetchedAt: NOW,
      windowStart: '2026-10-16',
      windowEnd: '2026-10-30',
      fishing: [item(), item(), item({ id: 'bad id' }), item({ lat: 'x' })],
      gaps: [
        {
          ...item({ id: 'g1', durationH: 9999, flag: 'zz' }),
          intentional: 'no',
        },
        { ...item({ id: 'g2' }), intentional: false },
      ],
    },
    NOW,
  );
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.fishing.length, 1);
  assert.equal(snapshot.gaps[0].durationH, 2000);
  assert.equal(snapshot.gaps[0].flag, '');
  assert.equal(snapshot.gaps[0].intentional, null);
  assert.equal(snapshot.gaps[1].intentional, false);
  assert.equal(snapshot.windowStart, '2026-10-16');
  assert.equal(snapshot.fetchedAt, NOW);
  const odd = fishingSnapshot(
    {
      configured: true,
      fishing: [],
      gaps: [],
      windowStart: 'x',
      fetchedAt: 'y',
    },
    NOW,
  );
  assert.equal(odd.windowStart, null);
  assert.equal(odd.fetchedAt, NOW);
});

test('an unconfigured or malformed body', () => {
  assert.deepEqual(fishingSnapshot({ configured: false }, NOW), {
    configured: false,
    fishing: [],
    gaps: [],
    windowStart: null,
    windowEnd: null,
    fetchedAt: NOW,
  });
  assert.equal(fishingSnapshot(null, NOW), null);
  assert.equal(fishingSnapshot({}, NOW), null);
  assert.equal(fishingSnapshot({ configured: true, fishing: [] }, NOW), null);
  assert.equal(
    fishingSnapshot({ configured: true, fishing: {}, gaps: [] }, NOW),
    null,
  );
});

test('gaps rank longest first and fishing newest first', () => {
  const gaps = [
    item({ id: 'a', durationH: 6 }),
    item({ id: 'b', durationH: 30 }),
    item({ id: 'c', durationH: 30 }),
    item({ id: 'd', durationH: 12 }),
  ];
  assert.deepEqual(
    gaps
      .slice()
      .sort(compareGaps)
      .map((g) => g.id),
    ['b', 'c', 'd', 'a'],
  );
  assert.deepEqual(
    longestGaps(gaps, 2).map((g) => g.id),
    ['b', 'c'],
  );
  assert.deepEqual(longestGaps(null), []);
  assert.deepEqual(
    [item({ id: 'x', startMs: 1 }), item({ id: 'y', startMs: 2 })]
      .sort(compareFishing)
      .map((f) => f.id),
    ['y', 'x'],
  );
  assert.equal(wholeHours(13.6), 14);
  assert.equal(wholeHours(undefined), 0);
});

test('EEZ lines: 200 NM solid, the rest dashed and fainter', () => {
  assert.deepEqual(eezLineStyle('200 NM'), {
    dashed: false,
    width: 1.5,
    alpha: 0.85,
  });
  for (const kind of ['Median line', 'Treaty', 'Connection line'])
    assert.deepEqual(eezLineStyle(kind), {
      dashed: true,
      width: 1.5,
      alpha: 0.6,
    });
  assert.equal(INDONESIA_EEZ_LINES.length, 55);
  const kinds = ['200 NM', 'Treaty', 'Median line', 'Connection line'];
  for (const line of INDONESIA_EEZ_LINES) {
    assert.ok(
      line.coordinates.length >= 4 && line.coordinates.length % 2 === 0,
    );
    assert.ok(kinds.includes(line.kind));
  }
});

test('the gap label entry ranks by hours', () => {
  const label = createFishingOverlayEntry({
    id: 'gap:g1',
    position: { x: 1 },
    title: 'AIS gap 14 h',
    durationH: 14.3,
  });
  assert.equal(label.id, 'gap:g1');
  assert.equal(label.variant, 'label');
  assert.equal(label.accent, '#e8eef5');
  assert.equal(label.priority, 1430);
  assert.equal(label.collisionGroup, 'ambient-label');
});

test('analyst records are JSON-safe', () => {
  const gap = mapAnalystRecord({ ...item(), intentional: true }, 'ais-gap');
  assert.equal(gap.kind, 'ais-gap');
  assert.equal(gap.intentional, true);
  const fishing = mapAnalystRecord(item({ flag: '' }), 'fishing');
  assert.equal(fishing.kind, 'fishing');
  assert.equal(fishing.flag, null);
  assert.ok(!('intentional' in fishing));
  assert.deepEqual(JSON.parse(JSON.stringify(gap)), gap);
});

test('a snapshot is stale once the proxy has not refreshed for seven hours', () => {
  assert.equal(snapshotIsStale(NOW - 6 * HOUR, NOW), false);
  assert.equal(snapshotIsStale(NOW - 8 * HOUR, NOW), true);
  assert.equal(snapshotIsStale(null, NOW), false);
});
