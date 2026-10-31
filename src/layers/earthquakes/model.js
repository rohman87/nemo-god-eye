import * as Cesium from 'cesium';
export const EARTHQUAKE_OVERLAY_SOURCE_ID = 'earthquakes';
export const EARTHQUAKE_OVERLAY_COHORT_LIMIT = 96;
export const EARTHQUAKE_OVERLAY_COLLISION_CAPACITY = 48;
/** Tsunami-potential events always win the label budget. */
export const EARTHQUAKE_TSUNAMI_PRIORITY_BOOST = 100_000;
export const EARTHQUAKE_FELT_PRIORITY_BOOST = 500;
/** A felt M1.8 event must still be visible. */
export const EARTHQUAKE_FELT_MIN_RADIUS_M = 8000;
export const EARTHQUAKE_TSUNAMI_RING_SCALE = 1.6;
export const EARTHQUAKE_TSUNAMI_RING_SEGMENTS = 64;
export const EARTHQUAKE_FELT_COLOR = '#7dd3fc';
export const EARTHQUAKE_FELT_OUTLINE_COLOR = '#0b0f14';
export const EARTHQUAKE_LIST_LIMIT = 8;
export const EARTHQUAKE_FELT_REPORT_LIST_CHARS = 80;
/** Indonesia bounds, S -11.5 N 6.5 W 94 E 141.5. */
const INDONESIA = { south: -11.5, north: 6.5, west: 94, east: 141.5 };
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Color by depth:
 *  - Shallow (<70km): Red
 *  - Intermediate (70-300km): Orange
 *  - Deep (>300km): Yellow
 */
export function depthColor(depthKm) {
  if (depthKm < 70) return Cesium.Color.RED;
  if (depthKm < 300) return Cesium.Color.ORANGE;
  return Cesium.Color.YELLOW;
}

/**
 * Build the source-owned presentation for one ambient magnitude label.
 * Magnitude formatting deliberately remains here instead of moving into the
 * shared renderer.
 * @param {object} input
 * @param {string} input.id Stable USGS or deterministic fallback id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the pulse.
 * @param {number} input.magnitude USGS magnitude.
 * @param {string} input.accent Source-owned depth-band color.
 * @returns {object}
 */
export function createEarthquakeOverlayEntry({
  id,
  position,
  magnitude,
  accent,
  suffix = '',
  priority,
}) {
  const mag = Number(magnitude);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: suffix ? `M${mag.toFixed(1)} ${suffix}` : `M${mag.toFixed(1)}`,
    accent,
    priority: Number.isFinite(priority) ? priority : Math.round(mag * 1000),
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

/** Ground disc radius in metres: 2^M x 1000, with a floor for felt reports. */
export function earthquakeRadiusM(magnitude, felt = false) {
  const radius = Math.pow(2, Number(magnitude)) * 1000;
  return felt ? Math.max(radius, EARTHQUAKE_FELT_MIN_RADIUS_M) : radius;
}

/**
 * Label priority. Tsunami potential outranks everything; felt events sit just
 * above equal-magnitude silent ones but stay below any M5+.
 */
export function earthquakeLabelPriority(magnitude, { tsunami, felt } = {}) {
  const base = Math.round(Number(magnitude) * 1000);
  if (tsunami) return base + EARTHQUAKE_TSUNAMI_PRIORITY_BOOST;
  if (felt) {
    const boosted = base + EARTHQUAKE_FELT_PRIORITY_BOOST;
    return Number(magnitude) < 5 ? Math.min(boosted, 4999) : boosted;
  }
  return base;
}

/**
 * Flat [lon, lat, lon, lat, ...] degrees for a closed circle of the given
 * ground radius around a centre. Pure; the layer turns it into Cartesian3.
 */
export function circleDegrees(
  lon,
  lat,
  radiusM,
  segments = EARTHQUAKE_TSUNAMI_RING_SEGMENTS,
) {
  const rad = Math.PI / 180;
  const lat1 = lat * rad;
  const lon1 = lon * rad;
  const angular = radiusM / EARTH_RADIUS_M;
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = ((i % segments) / segments) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) +
        Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    out.push(((((lon2 / rad + 180) % 360) + 360) % 360) - 180, lat2 / rad);
  }
  return out;
}

/** 'shallow' (<70 km), 'intermediate' (<300 km) or 'deep'. Unknown depth is shallow. */
export function depthBand(depthKm) {
  const depth = depthKm || 0;
  if (depth < 70) return 'shallow';
  if (depth < 300) return 'intermediate';
  return 'deep';
}

/** Whether an event belongs in the Indonesian list: BMKG-reported or inside the bounds. */
export function isIndonesianEvent(row) {
  if (row?.providers?.includes('BMKG')) return true;
  return (
    row?.lat >= INDONESIA.south &&
    row.lat <= INDONESIA.north &&
    row.lon >= INDONESIA.west &&
    row.lon <= INDONESIA.east
  );
}

/** The newest Indonesian events, newest first (rows without a time sort last). */
export function selectEarthquakeList(rows, limit = EARTHQUAKE_LIST_LIMIT) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(isIndonesianEvent)
    .sort(
      (a, b) =>
        (Number.isFinite(b.time) ? b.time : -Infinity) -
          (Number.isFinite(a.time) ? a.time : -Infinity) ||
        String(a.stableId).localeCompare(String(b.stableId)),
    )
    .slice(0, limit);
}

/** Largest whole unit for an age: {value: -5, unit: 'minute'} for formatRelativeTime. */
export function relativeAge(timeMs, nowMs) {
  if (!Number.isFinite(timeMs) || !Number.isFinite(nowMs)) return null;
  const seconds = Math.max(0, Math.round((nowMs - timeMs) / 1000));
  if (seconds < 60) return { value: -seconds, unit: 'second' };
  if (seconds < 3600)
    return { value: -Math.floor(seconds / 60), unit: 'minute' };
  if (seconds < 86_400)
    return { value: -Math.floor(seconds / 3600), unit: 'hour' };
  return { value: -Math.floor(seconds / 86_400), unit: 'day' };
}

/** Cap text at `max` characters, ending in an ellipsis when cut. */
export function capText(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Keep the largest events, with stable identity as the tie-break. */
export function selectEarthquakeOverlayCohort(
  entries,
  limit = EARTHQUAKE_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(EARTHQUAKE_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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
 * Map one earthquake's raw plain values to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. Falls back to an index-based id
 * when the USGS event id is absent.
 * @param {Object|null|undefined} raw - Plain values pulled off the entity:
 *   {id, mag, place, time, depth, lat, lon}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id: string, magnitude: number|null, depthKm: number|null,
 *   lat: number|null, lon: number|null, timeMs: number|null, place: string|null, provider: string|null,
 *   tsunami: boolean, felt: boolean, potential: string|null,
 *   feltReport: string|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `QUAKE-${String(index).padStart(4, '0')}`,
    magnitude: num(raw?.mag),
    depthKm: num(raw?.depth),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.time), // USGS epoch ms
    place: text(raw?.place),
    provider: text(raw?.provider),
    tsunami: raw?.tsunami === true,
    felt: raw?.felt === true,
    potential: text(raw?.potential),
    feltReport: text(raw?.feltReport),
  };
}

export { normalizeEarthquakeSnapshot } from './records.js';
