/**
 * @module layers/disasterReports/model
 *
 * Crowd-sourced PetaBencana.id disaster reports for Indonesia. Pure — no
 * Cesium, no network, no DOM at import time.
 *
 * Reports are untrusted, anonymous and unverified: every field is validated,
 * clamped and stripped of control characters, report images are never used,
 * and only https links survive.
 */
// A portable export (package.json): no i18n here. The labels stay English data;
// the row (index.js) shows them translated.
const msg = (text) => text;

export const DISASTER_REPORTS_OVERLAY_SOURCE_ID = 'disaster-reports';
/** One label per type at most, so six is the whole budget. */
export const DISASTER_REPORTS_OVERLAY_COHORT_LIMIT = 6;
export const DISASTER_REPORTS_OVERLAY_COLLISION_CAPACITY = 6;

/** Report types the layer shows, in legend order. */
export const DISASTER_TYPES = Object.freeze([
  Object.freeze({ id: 'flood', label: msg('Flood'), color: '#3b82f6' }),
  Object.freeze({ id: 'fire', label: msg('Fire'), color: '#ff7a1a' }),
  Object.freeze({ id: 'haze', label: msg('Haze'), color: '#a8a29e' }),
  Object.freeze({ id: 'wind', label: msg('Wind'), color: '#2dd4bf' }),
  Object.freeze({
    id: 'earthquake',
    label: msg('Earthquake'),
    color: '#e8eef5',
  }),
  Object.freeze({ id: 'volcano', label: msg('Volcano'), color: '#9d6b53' }),
]);

const TYPE_BY_ID = new Map(DISASTER_TYPES.map((type) => [type.id, type]));

/** Outline shared by every dot (spec §0: text-white). */
export const DISASTER_DOT_OUTLINE = '#e8eef5';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Window chips, single-select. */
export const DISASTER_WINDOWS = Object.freeze([
  Object.freeze({ id: '24h', label: msg('24 h'), ms: DAY_MS }),
  Object.freeze({ id: '3d', label: msg('3 d'), ms: 3 * DAY_MS }),
  Object.freeze({ id: '7d', label: msg('7 d'), ms: 7 * DAY_MS }),
]);
export const DISASTER_DEFAULT_WINDOW_ID = '3d';

/** The upstream's whole look-back; the window chip only filters client-side. */
export const DISASTER_MAX_AGE_MS = 7 * DAY_MS;
/** Reports dated further ahead than this are clock errors, not news. */
const FUTURE_TOLERANCE_MS = HOUR_MS;
/** Reports older than this fade (spec §3). */
export const DISASTER_FADE_AFTER_MS = 6 * HOUR_MS;
export const DISASTER_ALPHA = 0.9;
export const DISASTER_FADED_ALPHA = 0.6;

export const DISASTER_MAX_REPORTS = 500;
const TEXT_MAX = 280;
const TITLE_MAX = 120;
const CITY_MAX = 60;
const SOURCE_MAX = 40;
const REGION_MAX = 24;
const URL_MAX = 300;
const FLOOD_DEPTH_MAX_CM = 1000;
const ID_PATTERN = /^[\w-]{1,40}$/;

/** Indonesia, S -11.5 N 6.5 W 94 E 141.5. */
const BOUNDS = Object.freeze({
  south: -11.5,
  north: 6.5,
  west: 94,
  east: 141.5,
});

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** An https link, or null. Anything else (javascript:, http:, data:) is dropped. */
function safeHttpsUrl(raw) {
  if (typeof raw !== 'string' || raw.length > URL_MAX * 2) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return parsed.href.length <= URL_MAX ? parsed.href : null;
}

function compareNewest(a, b) {
  return b.createdMs - a.createdMs || String(a.id).localeCompare(String(b.id));
}

/**
 * Validate a PetaBencana `/reports` GeoJSON body into rows, newest first.
 *
 * Returns null when the body is not the expected shape, so the caller keeps
 * its last good data; individual bad features are skipped.
 *
 * @param {unknown} body - `{statusCode, result: FeatureCollection}`.
 * @param {number} [now=Date.now()]
 * @returns {Array<object>|null}
 */
export function normalizePetaBencanaReports(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const features = body.result?.features;
  if (!Array.isArray(features)) return null;

  const byId = new Map();
  for (const feature of features) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object') continue;

    const coordinates = feature.geometry?.coordinates;
    if (feature.geometry?.type !== 'Point' || !Array.isArray(coordinates))
      continue;
    const [lon, lat] = coordinates;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (
      lat < BOUNDS.south ||
      lat > BOUNDS.north ||
      lon < BOUNDS.west ||
      lon > BOUNDS.east
    )
      continue;

    const type =
      typeof properties.disaster_type === 'string'
        ? properties.disaster_type.trim().toLowerCase()
        : '';
    if (!TYPE_BY_ID.has(type)) continue;

    const rawId = properties.pkey;
    if (typeof rawId !== 'string' && !Number.isSafeInteger(rawId)) continue;
    const id = String(rawId);
    if (!ID_PATTERN.test(id)) continue;

    if (typeof properties.created_at !== 'string') continue;
    const createdMs = Date.parse(properties.created_at);
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs - now > FUTURE_TOLERANCE_MS) continue;
    if (now - createdMs > DISASTER_MAX_AGE_MS) continue;

    const depth = properties.report_data?.flood_depth;
    const floodDepthCm =
      type === 'flood' &&
      typeof depth === 'number' &&
      Number.isFinite(depth) &&
      depth >= 0 &&
      depth <= FLOOD_DEPTH_MAX_CM
        ? Math.round(depth)
        : null;

    const row = {
      id,
      type,
      createdMs,
      lat,
      lon,
      city: cleanText(properties.tags?.city, CITY_MAX),
      regionCode: cleanText(properties.tags?.instance_region_code, REGION_MAX),
      source: cleanText(properties.source, SOURCE_MAX),
      title: cleanText(properties.title, TITLE_MAX),
      text: cleanText(properties.text, TEXT_MAX),
      url: safeHttpsUrl(properties.url),
      floodDepthCm,
    };
    const previous = byId.get(id);
    if (!previous || previous.createdMs < createdMs) byId.set(id, row);
  }
  return [...byId.values()].sort(compareNewest).slice(0, DISASTER_MAX_REPORTS);
}

/**
 * Rows created within the last `windowMs`.
 * @param {Array<object>} rows
 * @param {number} windowMs
 * @param {number} [now=Date.now()]
 * @returns {Array<object>}
 */
export function filterByWindow(rows, windowMs, now = Date.now()) {
  if (!Array.isArray(rows)) return [];
  if (!Number.isFinite(windowMs)) return [];
  const since = now - windowMs;
  return rows.filter((row) => row.createdMs >= since);
}

/** The window descriptor for an id, falling back to the default. */
export function disasterWindow(id) {
  return (
    DISASTER_WINDOWS.find((entry) => entry.id === id) ||
    DISASTER_WINDOWS.find((entry) => entry.id === DISASTER_DEFAULT_WINDOW_ID)
  );
}

/** Type descriptor for a row type id, or null. */
export function disasterType(id) {
  return TYPE_BY_ID.get(id) || null;
}

/** Report counts keyed by type id, zero-filled for every known type. */
export function countByType(rows) {
  const counts = Object.fromEntries(DISASTER_TYPES.map((type) => [type.id, 0]));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.type in counts) counts[row.type] += 1;
  }
  return counts;
}

/** The single newest report of each type, newest first. */
export function newestPerType(rows) {
  const newest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const current = newest.get(row.type);
    if (!current || compareNewest(row, current) < 0) newest.set(row.type, row);
  }
  return [...newest.values()].sort(compareNewest);
}

/** Dot alpha: reports older than six hours fade (spec §3). */
export function reportAlpha(createdMs, now = Date.now()) {
  return now - createdMs > DISASTER_FADE_AFTER_MS
    ? DISASTER_FADED_ALPHA
    : DISASTER_ALPHA;
}

/**
 * Source-owned presentation for the one label a type gets on the map.
 * @param {object} input
 * @returns {object}
 */
export function createDisasterReportOverlayEntry({
  id,
  position,
  title,
  accent,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority: 500,
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

/** Sprite box. The dot is 7 px; the rest is pick padding to a 12 px radius. */
export const DISASTER_SPRITE_SIZE = 24;
const DOT_RADIUS = 3.5;
const OUTLINE_WIDTH = 1.5;

/**
 * Draw one report dot: a type-coloured 7 px disc with a 1.5 px light outline,
 * inside a nearly transparent 12 px-radius disc. The faint disc is invisible
 * but opaque enough to the pick pass, so small dots stay tappable.
 *
 * @param {string} typeId
 * @param {() => object} makeCanvas - Canvas factory; the layer passes a DOM one.
 * @returns {object|null} The canvas, or null for an unknown type.
 */
export function drawDisasterDot(typeId, makeCanvas) {
  const type = TYPE_BY_ID.get(typeId);
  if (!type) return null;
  const canvas = makeCanvas();
  canvas.width = DISASTER_SPRITE_SIZE;
  canvas.height = DISASTER_SPRITE_SIZE;
  const ctx = canvas.getContext('2d');
  const centre = DISASTER_SPRITE_SIZE / 2;
  ctx.clearRect(0, 0, DISASTER_SPRITE_SIZE, DISASTER_SPRITE_SIZE);
  ctx.beginPath();
  ctx.arc(centre, centre, centre, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(centre, centre, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = type.color;
  ctx.fill();
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.strokeStyle = DISASTER_DOT_OUTLINE;
  ctx.stroke();
  return canvas;
}

/**
 * Map one row to a JSON-safe analyst record. Pure — no Cesium types.
 * @param {object|null|undefined} raw
 * @param {number} [index=0]
 * @returns {object}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const trimmed = String(v ?? '').trim();
    return trimmed || null;
  };
  return {
    id: text(raw?.id) || `DR-${String(index).padStart(4, '0')}`,
    type: text(raw?.type),
    createdMs: num(raw?.createdMs),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    city: text(raw?.city),
    title: text(raw?.title),
    text: text(raw?.text),
  };
}
