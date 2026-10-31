import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VOLCANO_LEVELS,
  VOLCANO_STALE_AFTER_MS,
  VONA_COLORS,
  createVolcanoOverlayEntry,
  createVolcanoSprites,
  drawableVolcanoes,
  effectiveLevel,
  elevatedVolcanoes,
  mapAnalystRecord,
  selectVolcanoOverlayCohort,
  volcanoCounts,
  volcanoLabelTitle,
  volcanoPriority,
  volcanoView,
  volcanoesAreStale,
} from './model.js';

const volcano = (id, level, color = null, extra = {}) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  province: 'Jawa Timur',
  lat: -8,
  lon: 112,
  elevationM: 3676,
  level,
  vona: color ? { color, issuedAt: 1000, text: 't', code: 'SMR' } : null,
  ...extra,
});

test('level styles follow the violet ramp', () => {
  assert.deepEqual(
    VOLCANO_LEVELS.map((l) => [l.roman, l.name, l.color, l.sizePx, l.alpha]),
    [
      ['I', 'Normal', '#6b7785', 8, 0.6],
      ['II', 'Waspada', '#c4b5fd', 12, 0.95],
      ['III', 'Siaga', '#a855f7', 16, 1],
      ['IV', 'Awas', '#f5f3ff', 22, 1],
    ],
  );
  assert.equal(VOLCANO_LEVELS[3].outlineColor, '#a855f7');
  assert.deepEqual(
    VONA_COLORS.map((c) => c.hex),
    ['#2ecc71', '#ffd43b', '#ff8c1a', '#e5383b'],
  );
});

test('an unknown level styles as Level I; rings are size + 12 px', () => {
  const unknown = volcanoView(volcano('agung', null));
  assert.equal(unknown.level.level, 1);
  assert.equal(unknown.known, false);
  assert.equal(unknown.ringSizePx, null);
  assert.equal(effectiveLevel(volcano('agung', 9)), 1);
  const ringed = volcanoView(volcano('semeru', 4, 'RED'));
  assert.equal(ringed.ringSizePx, 34);
  assert.equal(ringed.vona.hex, '#e5383b');
  const hidden = volcanoView(volcano('semeru', 4, 'RED'), {
    showAviation: false,
  });
  assert.equal(hidden.vona, null);
  assert.equal(hidden.ringSizePx, null);
});

test('labels cover level II and up, with the VONA suffix only when drawn', () => {
  assert.equal(
    volcanoLabelTitle(volcano('semeru', 4, 'RED')),
    'Semeru IV VONA RED',
  );
  assert.equal(
    volcanoLabelTitle(volcano('semeru', 4, 'RED'), { showAviation: false }),
    'Semeru IV',
  );
  assert.equal(volcanoLabelTitle(volcano('merapi', 3)), 'Merapi III');
  assert.equal(volcanoLabelTitle(volcano('agung', 1)), null);
  assert.equal(volcanoLabelTitle(volcano('agung', null)), null);
});

test('priority is level x 1000 plus VONA rank x 100', () => {
  assert.equal(volcanoPriority(volcano('a', 4, 'RED')), 4300);
  assert.equal(volcanoPriority(volcano('a', 2, 'GREEN')), 2000);
  assert.equal(volcanoPriority(volcano('a', 3)), 3000);
  assert.equal(
    volcanoPriority(volcano('a', 4, 'RED'), { showAviation: false }),
    4000,
  );
  assert.ok(
    volcanoPriority(volcano('a', 3, 'RED')) < volcanoPriority(volcano('b', 4)),
  );
});

test('overlay entries use the ambient label shape and the cohort is capped', () => {
  const entry = createVolcanoOverlayEntry({
    id: 7,
    position: {},
    title: 'Semeru IV',
    accent: '#f5f3ff',
    priority: 4000,
  });
  assert.equal(entry.id, '7');
  assert.equal(entry.variant, 'label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.placement, 'above');
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `v${i}`,
    priority: i % 5,
  }));
  const picked = selectVolcanoOverlayCohort(many);
  assert.equal(picked.length, 64);
  assert.equal(picked[0].priority, 4);
  assert.deepEqual(selectVolcanoOverlayCohort(null), []);
  assert.deepEqual(selectVolcanoOverlayCohort(many, 0), []);
});

test('drawableVolcanoes hides Level I on request and draws important marks last', () => {
  const all = [
    volcano('semeru', 4, 'RED'),
    volcano('agung', 1),
    volcano('unknown', null),
    volcano('merapi', 3),
  ];
  assert.deepEqual(
    drawableVolcanoes(all).map((v) => v.id),
    ['agung', 'unknown', 'merapi', 'semeru'],
  );
  assert.deepEqual(
    drawableVolcanoes(all, { showQuiet: false }).map((v) => v.id),
    ['merapi', 'semeru'],
  );
});

test('elevatedVolcanoes sorts by level desc then name', () => {
  const list = elevatedVolcanoes([
    volcano('merapi', 3),
    volcano('agung', 1),
    volcano('semeru', 4),
    volcano('batur', 3),
    volcano('ijen', 2),
    volcano('nolevel', null),
  ]);
  assert.deepEqual(
    list.map((v) => v.id),
    ['semeru', 'batur', 'merapi', 'ijen'],
  );
  assert.equal(
    elevatedVolcanoes([volcano('a', 3), volcano('b', 3)], 1).length,
    1,
  );
});

test('volcanoCounts counts unknown under Level I and active notices by colour', () => {
  const counts = volcanoCounts([
    volcano('a', 1),
    volcano('b', null),
    volcano('c', 3, 'ORANGE'),
    volcano('d', 4, 'RED'),
    volcano('e', 2, 'RED'),
  ]);
  assert.deepEqual(counts.levels, { 1: 2, 2: 1, 3: 1, 4: 1 });
  assert.deepEqual(counts.vona, { GREEN: 0, YELLOW: 0, ORANGE: 1, RED: 2 });
});

test('staleness needs a fetch time older than two hours', () => {
  const now = 10 * VOLCANO_STALE_AFTER_MS;
  assert.equal(volcanoesAreStale(null, now), false);
  assert.equal(volcanoesAreStale(undefined, now), false);
  assert.equal(volcanoesAreStale(now - VOLCANO_STALE_AFTER_MS, now), false);
  assert.equal(volcanoesAreStale(now - VOLCANO_STALE_AFTER_MS - 1, now), true);
});

test('analyst records are JSON-safe with nulls for missing fields', () => {
  assert.deepEqual(mapAnalystRecord(volcano('semeru', 4, 'RED')), {
    id: 'semeru',
    name: 'Semeru',
    province: 'Jawa Timur',
    lat: -8,
    lon: 112,
    elevationM: 3676,
    level: 4,
    levelName: 'Awas',
    vonaColor: 'RED',
    vonaIssuedMs: 1000,
  });
  const bare = mapAnalystRecord({}, 3);
  assert.equal(bare.id, 'VOLCANO-0003');
  assert.equal(bare.level, null);
  assert.equal(bare.levelName, null);
  assert.equal(bare.vonaColor, null);
  assert.equal(bare.vonaIssuedMs, null);
  assert.equal(bare.lat, null);
});

test('sprites are drawn lazily, cached per shape, and absent without a canvas', () => {
  let created = 0;
  const calls = [];
  const context = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
      set: () => true,
    },
  );
  const sprites = createVolcanoSprites({
    createCanvas: () => {
      created += 1;
      return { getContext: () => context };
    },
  });
  assert.equal(created, 0);
  const first = sprites.get('triangle');
  assert.ok(first);
  assert.equal(sprites.get('triangle'), first);
  assert.equal(created, 1);
  assert.ok(sprites.get('ring'));
  assert.ok(sprites.get('triangleAwas'));
  assert.equal(created, 3);
  assert.equal(sprites.get('nope'), null);
  assert.ok(calls.some(([name]) => name === 'arc'));
  assert.equal(createVolcanoSprites().get('triangle'), null);
  assert.equal(
    createVolcanoSprites({ createCanvas: () => null }).get('ring'),
    null,
  );
});
