import { msg } from '../../i18n/marker.js';
import { MAGMA_LEVELS } from './magma.js';

// Pure presentation helpers for the volcano layer: styles, labels, ordering,
// counts and analyst records. No Cesium and no i18n catalogs, so they run in
// Node; the layer object translates the marked English strings these return.

export const VOLCANO_LAYER_ID = 'volcanoes';
export const VOLCANO_OVERLAY_SOURCE_ID = 'volcanoes';
export const VOLCANO_OVERLAY_COHORT_LIMIT = 64;
export const VOLCANO_OVERLAY_COLLISION_CAPACITY = 32;
/** A snapshot whose proxy fetch is older than this is reported stale. */
export const VOLCANO_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
/** Ring diameter is the triangle size plus this many pixels. */
export const VOLCANO_RING_EXTRA_PX = 12;
/** Elevated volcanoes listed in the row. */
export const VOLCANO_LIST_LIMIT = 30;
/** Neutral grey shared with the other Indonesian layers. */
export const VOLCANO_QUIET_COLOR = '#6b7785';

const LEVEL_STYLE = Object.freeze({
  1: {
    color: VOLCANO_QUIET_COLOR,
    sizePx: 8,
    alpha: 0.6,
    blurb: msg('Normal activity'),
  },
  2: {
    color: '#c4b5fd',
    sizePx: 12,
    alpha: 0.95,
    blurb: msg('Advisory. Above normal'),
  },
  3: {
    color: '#a855f7',
    sizePx: 16,
    alpha: 1,
    blurb: msg('Watch. Eruption possible'),
  },
  4: {
    color: '#f5f3ff',
    sizePx: 22,
    alpha: 1,
    blurb: msg('Warning. Eruption imminent'),
    outlineColor: '#a855f7',
  },
});

/**
 * The four PVMBG levels with their marker style, in level order.
 * `color` is both the marker fill and the legend / list / label accent.
 */
export const VOLCANO_LEVELS = Object.freeze(
  MAGMA_LEVELS.map((entry) =>
    Object.freeze({
      level: entry.level,
      roman: entry.roman,
      name: entry.label,
      ...LEVEL_STYLE[entry.level],
    }),
  ),
);

/** VONA aviation colour codes, lowest rank first. */
export const VONA_COLORS = Object.freeze([
  Object.freeze({
    color: 'GREEN',
    hex: '#2ecc71',
    rank: 0,
    blurb: msg('No ash expected'),
  }),
  Object.freeze({
    color: 'YELLOW',
    hex: '#ffd43b',
    rank: 1,
    blurb: msg('Ash emission, low risk'),
  }),
  Object.freeze({
    color: 'ORANGE',
    hex: '#ff8c1a',
    rank: 2,
    blurb: msg('Ash to flight levels, caution'),
  }),
  Object.freeze({
    color: 'RED',
    hex: '#e5383b',
    rank: 3,
    blurb: msg('Significant ash. Avoid area'),
  }),
]);

const VONA_BY_COLOR = new Map(VONA_COLORS.map((entry) => [entry.color, entry]));

/** Level 1..4, or null when the volcano has no MAGMA level. */
export function knownLevel(volcano) {
  const level = volcano?.level;
  return Number.isInteger(level) && level >= 1 && level <= 4 ? level : null;
}

/** Level used for styling and ordering: an unknown level reads as Level I. */
export function effectiveLevel(volcano) {
  return knownLevel(volcano) ?? 1;
}

/** Level descriptor (VOLCANO_LEVELS entry) for a volcano. */
export function levelInfo(volcano) {
  return VOLCANO_LEVELS[effectiveLevel(volcano) - 1];
}

/** VONA descriptor for a volcano's notice, or null. */
export function vonaInfo(volcano) {
  return VONA_BY_COLOR.get(volcano?.vona?.color) ?? null;
}

/**
 * Marker presentation for one volcano.
 * @param {object} volcano
 * @param {{showAviation?: boolean}} [options]
 * @returns {{level: object, known: boolean, vona: object|null,
 *   ringSizePx: number|null}} `vona` is null when there is no notice or
 *   aviation rings are switched off.
 */
export function volcanoView(volcano, { showAviation = true } = {}) {
  const level = levelInfo(volcano);
  const vona = showAviation ? vonaInfo(volcano) : null;
  return {
    level,
    known: knownLevel(volcano) !== null,
    vona,
    ringSizePx: vona ? level.sizePx + VOLCANO_RING_EXTRA_PX : null,
  };
}

/** Overlay label text, or null for Level I (no label). */
export function volcanoLabelTitle(volcano, options) {
  const view = volcanoView(volcano, options);
  if (view.level.level < 2) return null;
  const base = `${volcano.name} ${view.level.roman}`;
  return view.vona ? `${base} VONA ${view.vona.color}` : base;
}

/** Label priority: level x 1000 + VONA rank x 100. */
export function volcanoPriority(volcano, options) {
  const view = volcanoView(volcano, options);
  return view.level.level * 1000 + (view.vona ? view.vona.rank * 100 : 0);
}

/**
 * Build the shared overlay-label entry for one volcano.
 * @param {object} input
 * @param {string} input.id
 * @param {object} input.position Cesium.Cartesian3 anchor.
 * @param {string} input.title
 * @param {string} input.accent
 * @param {number} input.priority
 * @returns {object}
 */
export function createVolcanoOverlayEntry({
  id,
  position,
  title,
  accent,
  priority,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the highest-priority labels, with stable identity as the tie-break. */
export function selectVolcanoOverlayCohort(
  entries,
  limit = VOLCANO_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(VOLCANO_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Volcanoes to draw: Level I (and unknown) only when `showQuiet`. Ordered
 * lowest level and rank first so the most important markers draw last.
 */
export function drawableVolcanoes(
  volcanoes,
  { showQuiet = true, showAviation = true } = {},
) {
  return (Array.isArray(volcanoes) ? volcanoes : [])
    .filter((volcano) => showQuiet || effectiveLevel(volcano) >= 2)
    .sort(
      (a, b) =>
        volcanoPriority(a, { showAviation }) -
          volcanoPriority(b, { showAviation }) ||
        String(a.id).localeCompare(String(b.id)),
    );
}

/** Level >= II volcanoes, highest level first, then by name. */
export function elevatedVolcanoes(volcanoes, limit = VOLCANO_LIST_LIMIT) {
  return (Array.isArray(volcanoes) ? volcanoes : [])
    .filter((volcano) => effectiveLevel(volcano) >= 2)
    .sort(
      (a, b) =>
        effectiveLevel(b) - effectiveLevel(a) ||
        String(a.name).localeCompare(String(b.name)),
    )
    .slice(0, limit);
}

/**
 * Legend counts. Volcanoes with no MAGMA level count under Level I, matching
 * the Level I styling they are drawn with.
 * @returns {{levels: Record<number, number>, vona: Record<string, number>}}
 */
export function volcanoCounts(volcanoes) {
  const levels = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const vona = { GREEN: 0, YELLOW: 0, ORANGE: 0, RED: 0 };
  for (const volcano of Array.isArray(volcanoes) ? volcanoes : []) {
    levels[effectiveLevel(volcano)] += 1;
    const notice = vonaInfo(volcano);
    if (notice) vona[notice.color] += 1;
  }
  return { levels, vona };
}

/** True when the proxy fetch time is more than two hours old. */
export function volcanoesAreStale(fetchedAt, now = Date.now()) {
  if (!Number.isFinite(fetchedAt)) return false;
  return now - fetchedAt > VOLCANO_STALE_AFTER_MS;
}

/**
 * JSON-safe analyst record (analyst query engine seam).
 * @returns {{id: string, name: string|null, province: string|null,
 *   lat: number|null, lon: number|null, elevationM: number|null,
 *   level: number|null, levelName: string|null, vonaColor: string|null,
 *   vonaIssuedMs: number|null}}
 */
export function mapAnalystRecord(volcano, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const value = String(v ?? '').trim();
    return value || null;
  };
  const level = knownLevel(volcano);
  const notice = vonaInfo(volcano);
  return {
    id: text(volcano?.id) || `VOLCANO-${String(index).padStart(4, '0')}`,
    name: text(volcano?.name),
    province: text(volcano?.province),
    lat: num(volcano?.lat),
    lon: num(volcano?.lon),
    elevationM: num(volcano?.elevationM),
    level,
    levelName: level ? VOLCANO_LEVELS[level - 1].name : null,
    vonaColor: notice ? notice.color : null,
    vonaIssuedMs: notice ? num(volcano.vona.issuedAt) : null,
  };
}

// ---- Sprites --------------------------------------------------------------

const SPRITE_PX = 64;
const OUTLINE_DARK = '#0b0f14';

function defaultCreateCanvas() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_PX;
  canvas.height = SPRITE_PX;
  return canvas;
}

function trianglePath(context, inset) {
  context.beginPath();
  context.moveTo(SPRITE_PX / 2, inset);
  context.lineTo(SPRITE_PX - inset, SPRITE_PX - inset);
  context.lineTo(inset, SPRITE_PX - inset);
  context.closePath();
}

const SPRITE_PAINTERS = Object.freeze({
  // White body with a dark outline: tinted by Billboard.color, the outline
  // stays near-black and the body takes the level colour.
  triangle(context) {
    trianglePath(context, 6);
    context.fillStyle = '#ffffff';
    context.fill();
    context.lineWidth = 4;
    context.lineJoin = 'round';
    context.strokeStyle = OUTLINE_DARK;
    context.stroke();
  },
  // Level IV bakes its colours (near-white body, violet outline); draw it with
  // a white Billboard.color.
  triangleAwas(context) {
    trianglePath(context, 8);
    context.fillStyle = LEVEL_STYLE[4].color;
    context.fill();
    context.lineWidth = 8;
    context.lineJoin = 'round';
    context.strokeStyle = LEVEL_STYLE[4].outlineColor;
    context.stroke();
  },
  // Hollow white ring, tinted to the VONA colour.
  ring(context) {
    context.beginPath();
    context.arc(
      SPRITE_PX / 2,
      SPRITE_PX / 2,
      SPRITE_PX / 2 - 4,
      0,
      Math.PI * 2,
    );
    context.lineWidth = 5;
    context.strokeStyle = '#ffffff';
    context.stroke();
  },
});

/** Shapes the sprite cache can draw. */
export const VOLCANO_SPRITE_SHAPES = Object.freeze(
  Object.keys(SPRITE_PAINTERS),
);

/**
 * Lazily drawn sprite canvases, one cached per shape.
 * @param {{createCanvas?: () => object|null}} [options] Canvas factory; the
 *   default uses `document` and returns null where there is none (Node).
 * @returns {{get(shape: string): object|null, clear(): void}}
 */
export function createVolcanoSprites({
  createCanvas = defaultCreateCanvas,
} = {}) {
  const cache = new Map();
  return {
    get(shape) {
      const painter = SPRITE_PAINTERS[shape];
      if (!painter) return null;
      if (cache.has(shape)) return cache.get(shape);
      const canvas = createCanvas();
      const context = canvas?.getContext?.('2d');
      if (!context) return null;
      painter(context);
      cache.set(shape, canvas);
      return canvas;
    },
    clear() {
      cache.clear();
    },
  };
}
