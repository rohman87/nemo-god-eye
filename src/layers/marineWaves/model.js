/**
 * @module layers/marineWaves/model
 *
 * Wave heights at Indonesian ferry and shipping straits, normalized from the
 * Open-Meteo Marine API. Pure — no Cesium, no network, no DOM.
 *
 * Open-Meteo's `wave_direction` is the direction waves come FROM (meteorological
 * convention). The map arrow points where they travel TO, so the bearing is
 * turned 180 degrees; every piece of text keeps saying "from".
 */
// A portable export (package.json): no i18n here. The labels stay English data;
// the Weather card (index.js) shows them translated.
const msg = (text) => text;

export const MARINE_WAVES_OVERLAY_SOURCE_ID = 'marine-waves';
export const MARINE_WAVES_OVERLAY_COHORT_LIMIT = 16;
export const MARINE_WAVES_OVERLAY_COLLISION_CAPACITY = 16;

/** Colour of a strait with no usable reading (matches AIR_QUALITY_UNKNOWN_COLOR). */
export const MARINE_UNKNOWN_COLOR = '#6b7785';

/** Newest observation older than this means the feed is no longer current. */
export const MARINE_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

const MAX_HEIGHT_M = 30;
const MAX_PERIOD_S = 30;
/** Hourly samples read per strait: two forecast days is 48. */
const MAX_HOURLY_SAMPLES = 96;
const HOUR_MS = 60 * 60 * 1000;

/** The fixed set of straits, in request order. */
export const MARINE_STRAITS = Object.freeze(
  [
    ['sunda', 'Selat Sunda', 'Merak–Bakauheni', -5.9, 105.85],
    ['bali', 'Selat Bali', 'Ketapang–Gilimanuk', -8.15, 114.42],
    ['lombok', 'Selat Lombok', 'Padangbai–Lembar', -8.65, 115.75],
    ['alas', 'Selat Alas', 'Kayangan–Pototano', -8.55, 116.85],
    ['madura', 'Selat Madura', 'Ujung–Kamal', -7.18, 112.72],
    ['makassar', 'Selat Makassar', 'Shipping lane', -2.0, 118.5],
    ['bangka', 'Selat Bangka', 'Tanjung Api-Api–Muntok', -2.3, 105.6],
    ['malacca', 'Selat Malaka', 'Shipping lane', 2.0, 101.5],
    ['karimata', 'Selat Karimata', 'Shipping lane', -2.0, 108.5],
    ['sape', 'Selat Sape', 'Sape–Labuan Bajo', -8.55, 119.15],
  ].map(([id, name, route, lat, lon]) =>
    Object.freeze({ id, name, route, lat, lon }),
  ),
);

/**
 * BMKG wave categories, ascending. `min` is inclusive and the next band's
 * `min` is the exclusive upper bound. `local` is the Indonesian name, a proper
 * name that is never translated.
 */
export const WAVE_BANDS = Object.freeze(
  [
    ['calm', msg('Calm'), 'Tenang', '0–0.5 m', 0, '#4a90c2', null],
    ['low', msg('Low'), 'Rendah', '0.5–1.25 m', 0.5, '#2ec4b6', null],
    [
      'moderate',
      msg('Moderate'),
      'Sedang',
      '1.25–2.5 m',
      1.25,
      '#a3d95b',
      msg('Small fishing boats at risk'),
    ],
    [
      'high',
      msg('High'),
      'Tinggi',
      '2.5–4 m',
      2.5,
      '#ffd43b',
      msg('Ferries at risk'),
    ],
    [
      'very-high',
      msg('Very high'),
      'Sangat tinggi',
      '4–6 m',
      4,
      '#ff8c1a',
      msg('Large ships at risk'),
    ],
    ['extreme', msg('Extreme'), 'Ekstrem', '6–9 m', 6, '#e5383b', null],
    [
      'very-extreme',
      msg('Very extreme'),
      'Sangat ekstrem',
      '>9 m',
      9,
      '#b5179e',
      null,
    ],
  ].map(([id, label, local, range, min, color, risk]) =>
    Object.freeze({ id, label, local, range, min, color, risk }),
  ),
);

/** Selectable vessel classes: waves at or above `limitM` are unsafe for them. */
export const VESSEL_LIMITS = Object.freeze(
  [
    ['fishing', msg('Fishing boat'), 1.25],
    ['barge', msg('Barge'), 1.5],
    ['ferry', msg('Ferry'), 2.5],
    ['ship', msg('Large ship'), 4],
  ].map(([id, label, limitM]) => Object.freeze({ id, label, limitM })),
);
export const DEFAULT_VESSEL_ID = 'ferry';

const BAND_BY_ID = new Map(WAVE_BANDS.map((band) => [band.id, band]));

/**
 * The band a wave height falls in, or null for a non-finite or negative value.
 * @param {number} heightM
 * @returns {object|null}
 */
export function waveBand(heightM) {
  const height = Number(heightM);
  if (
    heightM === null ||
    heightM === '' ||
    !Number.isFinite(height) ||
    height < 0
  )
    return null;
  for (let i = WAVE_BANDS.length - 1; i >= 0; i--) {
    if (height >= WAVE_BANDS[i].min) return WAVE_BANDS[i];
  }
  return null;
}

/** Position of a band in the ascending ramp; -1 for an unknown band. */
export function bandRank(band) {
  const id = typeof band === 'string' ? band : band?.id;
  return WAVE_BANDS.findIndex((entry) => entry.id === id);
}

/**
 * Arrow edge length in pixels: 20 for Calm / Low, 26 for Moderate / High,
 * 32 for Very high and above. Unknown band: 20.
 * @param {object|string|null} band - A band or a band id.
 * @returns {number}
 */
export function arrowSizePx(band) {
  const rank = bandRank(band);
  if (rank >= 4) return 32;
  if (rank >= 2) return 26;
  return 20;
}

/**
 * Where the waves travel to, given where they come from (degrees clockwise
 * from north). Null when the direction is unknown.
 * @param {number} fromDeg
 * @returns {number|null}
 */
export function travelBearing(fromDeg) {
  if (fromDeg === null || fromDeg === undefined || fromDeg === '') return null;
  const from = Number(fromDeg);
  if (!Number.isFinite(from)) return null;
  return (((from + 180) % 360) + 360) % 360;
}

/** 16-point compass name for a bearing, e.g. 225 is "SW". */
export function compassPoint(deg) {
  const value = Number(deg);
  if (deg === null || deg === undefined || !Number.isFinite(value)) return null;
  const points = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  return points[Math.round((((value % 360) + 360) % 360) / 22.5) % 16];
}

export function vesselById(id) {
  return (
    VESSEL_LIMITS.find((vessel) => vessel.id === id) ||
    VESSEL_LIMITS.find((vessel) => vessel.id === DEFAULT_VESSEL_ID)
  );
}

/** Does a height reach the vessel's limit? */
export function exceedsLimit(heightM, vessel) {
  return (
    Number.isFinite(heightM) &&
    heightM >= vesselById(vessel?.id ?? vessel).limitM
  );
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Open-Meteo times are GMT without a zone ("2026-10-30T16:45"): read as UTC.
 * @param {*} text
 * @returns {number|null} Epoch ms.
 */
export function parseGmtTime(text) {
  if (typeof text !== 'string' || text.length > 40) return null;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

/** Highest forecast height within the next 24 hours, current value included. */
function maxNext24h(hourly, heightM, now) {
  let max = heightM;
  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  const heights = Array.isArray(hourly?.wave_height) ? hourly.wave_height : [];
  const count = Math.min(times.length, heights.length, MAX_HOURLY_SAMPLES);
  for (let i = 0; i < count; i++) {
    const at = parseGmtTime(times[i]);
    const height = finiteOrNull(heights[i]);
    if (at === null || height === null || height < 0) continue;
    // The hourly sample that covers "now" starts up to an hour ago.
    if (at < now - HOUR_MS || at > now + 24 * HOUR_MS) continue;
    max = Math.max(max, clamp(height, 0, MAX_HEIGHT_M));
  }
  return max;
}

/**
 * Turn an Open-Meteo multi-point marine response into display rows.
 *
 * Returns null when the payload is structurally wrong (not an array, or not one
 * item per strait), so the caller keeps its last good data. A strait with no
 * usable wave height is skipped; that is a gap, not an error.
 *
 * @param {*} payload - Parsed JSON, one item per strait in request order.
 * @param {ReadonlyArray<object>} [straits=MARINE_STRAITS]
 * @param {number} [now=Date.now()]
 * @returns {Array<object>|null}
 */
export function normalizeMarinePayload(
  payload,
  straits = MARINE_STRAITS,
  now = Date.now(),
) {
  // A single-location request returns a bare object rather than a list.
  const items =
    straits.length === 1 &&
    payload &&
    !Array.isArray(payload) &&
    typeof payload === 'object'
      ? [payload]
      : payload;
  if (!Array.isArray(items) || items.length !== straits.length) return null;
  const rows = [];
  straits.forEach((strait, index) => {
    const current = items[index]?.current;
    if (!current || typeof current !== 'object') return;
    const raw = finiteOrNull(current.wave_height);
    if (raw === null || raw < 0) return;
    const validMs = parseGmtTime(current.time);
    if (validMs === null) return;
    const heightM = clamp(raw, 0, MAX_HEIGHT_M);
    const direction = finiteOrNull(current.wave_direction);
    const period = finiteOrNull(current.wave_period);
    rows.push({
      id: strait.id,
      name: strait.name,
      route: strait.route,
      lat: strait.lat,
      lon: strait.lon,
      heightM,
      directionFromDeg:
        direction === null ? null : ((direction % 360) + 360) % 360,
      periodS:
        period === null || period < 0 ? null : clamp(period, 0, MAX_PERIOD_S),
      maxNext24hM: maxNext24h(items[index].hourly, heightM, now),
      // A clock skewed ahead must not make a stale value look fresher than now.
      validMs: Math.min(validMs, now),
      band: waveBand(heightM).id,
    });
  });
  return rows;
}

/** Rows ordered tallest first; ties keep the strait order of MARINE_STRAITS. */
export function sortRowsByHeight(rows) {
  const order = new Map(MARINE_STRAITS.map((strait, i) => [strait.id, i]));
  return rows
    .slice()
    .sort(
      (a, b) =>
        b.heightM - a.heightM ||
        (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99),
    );
}

/** Newest `validMs` across rows, or null when there are none. */
export function newestValidMs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let newest = null;
  for (const row of rows) {
    const at = Number(row?.validMs);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** An empty set is stale: a refresh that kept no current reading has nothing live. */
export function marineRowsAreStale(rows, now = Date.now()) {
  const newest = newestValidMs(rows);
  if (newest === null) return true;
  return now - newest > MARINE_STALE_AFTER_MS;
}

/** One-decimal metres, e.g. "1.4 m". */
export function formatHeight(heightM) {
  return `${(Math.round(Number(heightM) * 10) / 10).toFixed(1)} m`;
}

/** Label text for a strait, e.g. "Selat Sunda 1.4 m". */
export function marineLabelTitle(row) {
  return `${row.name} ${formatHeight(row.heightM)}`;
}

/**
 * Build the overlay label entry for one strait. Rougher water wins the label
 * budget: band rank first, then height inside the band.
 * @param {object} input
 * @returns {object}
 */
export function createMarineOverlayEntry({
  id,
  position,
  title,
  accent,
  band,
  heightM,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority:
      (bandRank(band) + 1) * 1000 +
      Math.min(999, Math.max(0, Math.round((Number(heightM) || 0) * 100))),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * JSON-safe record for the analyst query engine.
 * @param {object} row
 * @returns {object}
 */
export function mapAnalystRecord(row) {
  const band = BAND_BY_ID.get(row.band);
  return {
    id: row.id,
    strait: row.name,
    route: row.route,
    waveHeightM: row.heightM,
    band: band ? band.label : row.band,
    directionFromDeg: row.directionFromDeg,
    periodS: row.periodS,
    maxNext24hM: row.maxNext24hM,
    validTimeMs: row.validMs,
    lat: row.lat,
    lon: row.lon,
  };
}
