// Pure model for the fishing-activity layer. No Cesium, no DOM and no i18n, so
// the Node proxy (server/providers/fishingIndonesia.js) and the tests can use it.

export const FISHING_OVERLAY_SOURCE_ID = 'fishing-activity';
export const FISHING_OVERLAY_COHORT_LIMIT = 5;
export const FISHING_OVERLAY_COLLISION_CAPACITY = 8;

export const EEZ_COLOR = '#8fb3c9';
export const FISHING_COLOR = '#5eead4';
export const GAP_COLOR = '#e8eef5';
export const OUTLINE_COLOR = '#0b0f14';

/** Gaps listed and labelled: the longest few, not every one. */
export const GAP_HIGHLIGHT_COUNT = 5;
/** The proxy pulls one page of 500 per dataset. */
export const MAX_EVENTS_PER_KIND = 500;
/** The proxy refreshes every 6 h; past this its upstream pulls are failing. */
export const SNAPSHOT_STALE_MS = 7 * 60 * 60 * 1000;

/** Wider than the land bounds: the EEZ reaches far offshore. */
export const FISHING_BOUNDS = Object.freeze({
  south: -15,
  north: 10,
  west: 90,
  east: 145,
});

const ID_MAX = 64;
const NAME_MAX = 60;
const DURATION_MAX_H = 2000;
const HOUR_MS = 60 * 60 * 1000;
const ID_PATTERN = /^[\w:-]+$/;
const FLAG_PATTERN = /^[A-Z]{2,3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// C0/C1 controls, zero-width marks and bidi overrides: none belong in a label.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Clean upstream text: no control characters, single-spaced, length-capped. */
export function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const inBounds = (lat, lon) =>
  lat >= FISHING_BOUNDS.south &&
  lat <= FISHING_BOUNDS.north &&
  lon >= FISHING_BOUNDS.west &&
  lon <= FISHING_BOUNDS.east;

const roundTenth = (value) => Math.round(value * 10) / 10;

/** Whole hours, clamped to the range the layer accepts. */
function clampHours(value) {
  if (!Number.isFinite(value)) return null;
  return roundTenth(Math.min(DURATION_MAX_H, Math.max(0, value)));
}

/**
 * Normalise one raw GFW event into a layer item, or null when unusable.
 * Vessel ids and MMSI/SSVID are deliberately not carried over.
 * @param {object} entry - One `entries[]` element of /v3/events.
 * @param {'fishing'|'gaps'} kind
 * @returns {object|null}
 */
export function normalizeGfwEvent(entry, kind) {
  if (!entry || typeof entry !== 'object') return null;
  const { id, position, vessel } = entry;
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX)
    return null;
  if (!ID_PATTERN.test(id)) return null;
  const lat = position?.lat;
  const lon = position?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inBounds(lat, lon)) return null;
  if (typeof entry.start !== 'string') return null;
  const startMs = Date.parse(entry.start);
  if (!Number.isFinite(startMs) || startMs <= 0) return null;
  const parsedEnd =
    typeof entry.end === 'string' ? Date.parse(entry.end) : Number.NaN;
  const endMs =
    Number.isFinite(parsedEnd) && parsedEnd >= startMs ? parsedEnd : startMs;
  const span = (endMs - startMs) / HOUR_MS;
  let hours = null;
  if (kind === 'gaps') {
    const reported = entry.gap?.durationHours;
    if (typeof reported === 'number') hours = clampHours(reported);
  }
  const durationH = hours ?? clampHours(span);
  const flag =
    typeof vessel?.flag === 'string' ? vessel.flag.trim().toUpperCase() : '';
  const item = {
    id,
    lat,
    lon,
    startMs,
    endMs,
    vesselName: cleanText(vessel?.name, NAME_MAX),
    flag: FLAG_PATTERN.test(flag) ? flag : '',
    durationH,
  };
  if (kind === 'gaps') {
    const flagged = entry.gap?.intentionalDisabling;
    item.intentional = typeof flagged === 'boolean' ? flagged : null;
  }
  return item;
}

/**
 * Normalise one /v3/events page.
 * @param {object} payload - `{entries, total, nextOffset, ...}`.
 * @param {'fishing'|'gaps'} kind
 * @returns {{items: Array<object>, truncated: boolean}|null} Null when the page is malformed.
 */
export function normalizeGfwEvents(payload, kind) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.entries)
  )
    return null;
  const byId = new Map();
  for (const entry of payload.entries.slice(0, MAX_EVENTS_PER_KIND)) {
    const item = normalizeGfwEvent(entry, kind);
    if (item && !byId.has(item.id)) byId.set(item.id, item);
  }
  const total = Number(payload.total);
  const truncated =
    payload.entries.length > MAX_EVENTS_PER_KIND ||
    (Number.isFinite(total) && total > payload.entries.length) ||
    (payload.nextOffset !== null && payload.nextOffset !== undefined);
  return { items: [...byId.values()], truncated };
}

/** Re-validate one proxy item. The client does not trust the proxy. */
function sanitizeItem(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, lat, lon, startMs, endMs, vesselName, flag, durationH } = raw;
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX)
    return null;
  if (!ID_PATTERN.test(id)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inBounds(lat, lon)) return null;
  if (!Number.isFinite(startMs) || startMs <= 0) return null;
  if (!Number.isFinite(endMs) || endMs < startMs) return null;
  const hours = clampHours(durationH);
  if (hours === null) return null;
  const item = {
    id,
    lat,
    lon,
    startMs,
    endMs,
    vesselName: cleanText(vesselName, NAME_MAX),
    flag: typeof flag === 'string' && FLAG_PATTERN.test(flag) ? flag : '',
    durationH: hours,
  };
  if (kind === 'gaps')
    item.intentional =
      typeof raw.intentional === 'boolean' ? raw.intentional : null;
  return item;
}

function sanitizeItems(rows, kind) {
  if (!Array.isArray(rows)) return null;
  const byId = new Map();
  for (const row of rows.slice(0, MAX_EVENTS_PER_KIND)) {
    const item = sanitizeItem(row, kind);
    if (item && !byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/**
 * Re-validate a proxy body into the snapshot the layer renders.
 * @param {object} payload - Proxy body.
 * @param {number} [now=Date.now()]
 * @returns {{configured: boolean, fishing: Array<object>, gaps: Array<object>,
 *   windowStart: string|null, windowEnd: string|null, fetchedAt: number}|null}
 *   Null when the payload is malformed.
 */
export function fishingSnapshot(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.configured !== 'boolean') return null;
  const fetchedAt = Number.isFinite(payload.fetchedAt)
    ? payload.fetchedAt
    : now;
  if (!payload.configured)
    return {
      configured: false,
      fishing: [],
      gaps: [],
      windowStart: null,
      windowEnd: null,
      fetchedAt,
    };
  const fishing = sanitizeItems(payload.fishing, 'fishing');
  const gaps = sanitizeItems(payload.gaps, 'gaps');
  if (!fishing || !gaps) return null;
  const date = (value) =>
    typeof value === 'string' && DATE_PATTERN.test(value) ? value : null;
  return {
    configured: true,
    fishing,
    gaps,
    windowStart: date(payload.windowStart),
    windowEnd: date(payload.windowEnd),
    fetchedAt,
  };
}

/** Longest first, stable on id. */
export function compareGaps(a, b) {
  return b.durationH - a.durationH || a.id.localeCompare(b.id);
}

/** Newest first, stable on id. */
export function compareFishing(a, b) {
  return b.startMs - a.startMs || a.id.localeCompare(b.id);
}

/** The longest `count` gaps. */
export function longestGaps(gaps, count = GAP_HIGHLIGHT_COUNT) {
  if (!Array.isArray(gaps)) return [];
  return gaps.slice().sort(compareGaps).slice(0, Math.max(0, count));
}

/** Whole hours for a label, e.g. 14 for 13.6. */
export function wholeHours(durationH) {
  return Math.max(0, Math.round(Number(durationH) || 0));
}

/** A proxy snapshot older than the refresh cadence allows. */
export function snapshotIsStale(fetchedAt, now = Date.now()) {
  return Number.isFinite(fetchedAt) && now - fetchedAt > SNAPSHOT_STALE_MS;
}

/**
 * How one EEZ boundary kind is drawn. Spec: the 200 NM limit is solid; the
 * median, treaty and connection lines are dashed and fainter.
 * @param {string} kind
 * @returns {{dashed: boolean, width: number, alpha: number}}
 */
export function eezLineStyle(kind) {
  if (kind === '200 NM') return { dashed: false, width: 1.5, alpha: 0.85 };
  return { dashed: true, width: 1.5, alpha: 0.6 };
}

/** Overlay label for one long AIS gap; same shape as the earthquake entry. */
export function createFishingOverlayEntry({ id, position, title, durationH }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent: GAP_COLOR,
    priority: Math.round(Number(durationH) * 100),
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

/**
 * JSON-safe analyst record for one event (analyst query engine seam).
 * @param {object} item - A validated fishing or gap item.
 * @param {'fishing'|'ais-gap'} kind
 */
export function mapAnalystRecord(item, kind) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const record = {
    id: String(item?.id ?? ''),
    kind,
    vesselName: item?.vesselName || null,
    flag: item?.flag || null,
    lat: num(item?.lat),
    lon: num(item?.lon),
    startMs: num(item?.startMs),
    endMs: num(item?.endMs),
    durationH: num(item?.durationH),
  };
  if (kind === 'ais-gap')
    record.intentional =
      typeof item?.intentional === 'boolean' ? item.intentional : null;
  return record;
}
