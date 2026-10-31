import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capText,
  circleDegrees,
  depthBand,
  earthquakeLabelPriority,
  earthquakeRadiusM,
  relativeAge,
  selectEarthquakeList,
  createEarthquakeOverlayEntry,
} from './model.js';
import { createEarthquakesLayer } from './index.js';

const NOW = Date.now();
const quake = (over = {}) => ({
  stableId: 'q1',
  usgsId: 'q1',
  bmkgId: null,
  provider: 'USGS',
  providers: ['USGS'],
  lon: 120,
  lat: -2,
  depthKm: 10,
  mag: 4,
  place: 'Fixture',
  time: NOW - 5 * 60_000,
  tsunami: false,
  felt: false,
  feltReport: null,
  potential: null,
  ...over,
});

test('radius floors felt reports at 8 km only', () => {
  assert.equal(earthquakeRadiusM(5), 32_000);
  assert.equal(earthquakeRadiusM(1.8), Math.pow(2, 1.8) * 1000);
  assert.equal(earthquakeRadiusM(1.8, true), 8000);
  assert.equal(earthquakeRadiusM(5, true), 32_000);
});

test('label priority: tsunami boost, felt below M5, plain unchanged', () => {
  assert.equal(earthquakeLabelPriority(4, {}), 4000);
  assert.equal(earthquakeLabelPriority(7.1, { tsunami: true }), 107_100);
  assert.equal(earthquakeLabelPriority(3.2, { felt: true }), 3700);
  assert.ok(earthquakeLabelPriority(4.9, { felt: true }) < 5000);
  assert.equal(earthquakeLabelPriority(5.5, { felt: true }), 6000);
});

test('overlay entry accepts a suffix and priority without changing defaults', () => {
  const plain = createEarthquakeOverlayEntry({
    id: 'a',
    position: null,
    magnitude: 7.12,
    accent: '#f00',
  });
  assert.equal(plain.title, 'M7.1');
  assert.equal(plain.priority, 7120);
  const flagged = createEarthquakeOverlayEntry({
    id: 'a',
    position: null,
    magnitude: 7.12,
    accent: '#f00',
    suffix: 'Tsunami potential',
    priority: 107_120,
  });
  assert.equal(flagged.title, 'M7.1 Tsunami potential');
  assert.equal(flagged.priority, 107_120);
});

test('circleDegrees is a closed 64-segment ring at the right distance', () => {
  const ring = circleDegrees(120, -2, 50_000);
  assert.equal(ring.length, 65 * 2);
  assert.deepEqual(ring.slice(0, 2), ring.slice(-2));
  const north = ring.slice(0, 2);
  assert.ok(Math.abs(north[1] - (-2 + 50 / 111.19)) < 0.01);
  assert.ok(Math.abs(north[0] - 120) < 1e-6);
});

test('depth bands and relative age', () => {
  assert.equal(depthBand(null), 'shallow');
  assert.equal(depthBand(69.9), 'shallow');
  assert.equal(depthBand(70), 'intermediate');
  assert.equal(depthBand(300), 'deep');
  assert.deepEqual(relativeAge(NOW - 30_000, NOW), {
    value: -30,
    unit: 'second',
  });
  assert.deepEqual(relativeAge(NOW - 5 * 60_000, NOW), {
    value: -5,
    unit: 'minute',
  });
  assert.deepEqual(relativeAge(NOW - 3 * 3_600_000, NOW), {
    value: -3,
    unit: 'hour',
  });
  assert.deepEqual(relativeAge(NOW - 2 * 86_400_000, NOW), {
    value: -2,
    unit: 'day',
  });
  assert.equal(relativeAge(null, NOW), null);
});

test('capText', () => {
  assert.equal(capText('short', 80), 'short');
  const capped = capText('x'.repeat(200), 80);
  assert.equal(capped.length, 80);
  assert.ok(capped.endsWith('…'));
});

test('list keeps the newest 8 Indonesian events', () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    quake({ stableId: `id${i}`, time: NOW - i * 60_000 }),
  );
  rows.push(quake({ stableId: 'abroad', lat: 61, lon: -150, time: NOW }));
  rows.push(
    quake({
      stableId: 'bmkg-offshore',
      lat: 20,
      lon: 150,
      providers: ['BMKG'],
      time: NOW - 30_000,
    }),
  );
  const list = selectEarthquakeList(rows);
  assert.equal(list.length, 8);
  assert.equal(list[0].stableId, 'id0');
  assert.equal(list[1].stableId, 'bmkg-offshore');
  assert.ok(!list.some((r) => r.stableId === 'abroad'));
});

// Layer integration

function harness(rows, source = {}) {
  const added = [];
  const labelCalls = [];
  const dataSources = [];
  const viewer = {
    dataSources: {
      add(value) {
        dataSources.push(value);
      },
      remove() {},
    },
  };
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => rows, ...source },
    overlayHost: {
      setEntries(...args) {
        labelCalls.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, dataSource: dataSources[0], labelCalls, added };
}

test('tsunami and felt rows get a ring entity, dot, floor radius and labels', async () => {
  const rows = [
    quake({ stableId: 't', mag: 7.1, tsunami: true, providers: ['BMKG'] }),
    quake({
      stableId: 'f',
      mag: 1.8,
      felt: true,
      feltReport: 'II Kota',
      lat: -3,
    }),
    quake({ stableId: 'p', mag: 4, lat: -4 }),
  ];
  const h = harness(rows);
  assert.equal(await h.layer.update(h.viewer), true);
  const byId = new Map(h.dataSource.entities.values.map((e) => [e.id, e]));
  assert.equal(byId.size, 4);
  const ring = byId.get('earthquake:t:tsunami');
  assert.ok(ring.polyline);
  assert.equal(ring.polyline.clampToGround.getValue(), true);
  assert.equal(byId.get('earthquake:t').ellipse.outlineWidth.getValue(), 3);
  const felt = byId.get('earthquake:f');
  assert.ok(felt.point);
  assert.equal(felt.ellipse.semiMajorAxis.getValue(), 8000);
  assert.equal(byId.get('earthquake:p').point, undefined);
  assert.equal(byId.get('earthquake:p:tsunami'), undefined);
  assert.equal(h.layer.getStats().count, 3);

  const entries = h.labelCalls.at(-1)[1];
  const title = (id) => entries.find((e) => e.id === id);
  assert.equal(title('t').title, 'M7.1 Tsunami potential');
  assert.equal(title('t').priority, 107_100);
  assert.equal(title('f').title, 'M1.8 Felt');
  assert.equal(title('p').title, 'M4.0');

  // Re-render with no tsunami: ring is removed with the parent.
  h.layer.destroy(h.viewer);
});

test('re-render removes stale tsunami rings', async () => {
  let rows = [quake({ stableId: 't', mag: 7, tsunami: true })];
  const h = harness(null, { getSnapshot: async () => rows });
  await h.layer.update(h.viewer);
  assert.equal(h.dataSource.entities.values.length, 2);
  rows = [quake({ stableId: 't', mag: 7 })];
  await h.layer.update(h.viewer);
  assert.equal(h.dataSource.entities.values.length, 1);
  h.layer.destroy(h.viewer);
});

test('row controls: five legend entries with counts, list lines, info', async () => {
  const rows = [
    quake({
      stableId: 't',
      mag: 7.1,
      tsunami: true,
      depthKm: 20,
      place: 'Banda Sea',
      providers: ['BMKG', 'USGS'],
    }),
    quake({
      stableId: 'f',
      mag: 3.2,
      felt: true,
      depthKm: 150,
      feltReport: 'II ' + 'x'.repeat(200),
      providers: ['BMKG'],
      time: NOW - 2 * 3_600_000,
    }),
    quake({ stableId: 'd', depthKm: 400, lat: 40, lon: 0 }),
  ];
  let status = { usgs: 'ok', bmkg: 'ok' };
  const h = harness(rows, { getProviderStatus: () => status });
  let notified = 0;
  h.layer.setRowControlsListener(() => notified++);
  await h.layer.update(h.viewer);
  assert.ok(notified > 0);
  const controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.legend.map((l) => [l.color, l.label, l.count]),
    [
      ['#ff0000', 'Shallow', 1],
      ['#ffa500', 'Intermediate', 1],
      ['#ffff00', 'Deep', 1],
      ['#ffffff', 'Tsunami potential', 1],
      ['#7dd3fc', 'Felt report', 1],
    ],
  );
  assert.equal(controls.info, undefined);
  const lines = controls.list.items;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].lead, 'M7.1');
  assert.match(
    lines[0].text,
    /^Banda Sea · .+ · BMKG\+USGS · Tsunami potential$/,
  );
  assert.equal(lines[0].accent, 'rgb(255,0,0)');
  assert.match(lines[1].text, / · BMKG · Felt: II x+…$/);
  assert.ok(lines[1].text.length < 200);
  status = { usgs: 'ok', bmkg: 'down' };
  assert.equal(
    h.layer.getRowControls().info,
    'BMKG unavailable. Showing USGS only.',
  );
  h.layer.destroy(h.viewer);
});
