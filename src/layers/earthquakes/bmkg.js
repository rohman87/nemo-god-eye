const FEED_ROOT = 'https://data.bmkg.go.id/DataMKG/TEWS';

/** BMKG (Indonesian met agency) earthquake feeds; CORS-open, no key. */
export const BMKG_FEED_URLS = Object.freeze({
  latest: `${FEED_ROOT}/autogempa.json`,
  recent: `${FEED_ROOT}/gempaterkini.json`,
  felt: `${FEED_ROOT}/gempadirasakan.json`,
});

const MAX_ITEMS = 100;
const DAY_MS = 86_400_000;
const FUTURE_SLACK_MS = 3_600_000;
const MATCH_TIME_MS = 90_000;
const MATCH_DISTANCE_KM = 100;
const EARTH_RADIUS_KM = 6371;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
const MAGNITUDE = /^\d+(\.\d+)?$/;
const DEPTH = /^(\d+(?:\.\d+)?)\s*km$/i;
// C0/C1 controls, zero-width marks and bidi overrides: none belong in a label.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Clean upstream text: no control characters, single-spaced, length-capped. */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeItem(item, felt) {
  if (!isPlainObject(item)) return null;
  const dateTime =
    typeof item.DateTime === 'string' ? item.DateTime.trim() : '';
  if (!DATE_TIME.test(dateTime)) return null;
  const time = Date.parse(dateTime);
  if (!Number.isFinite(time)) return null;

  if (typeof item.Coordinates !== 'string') return null;
  const parts = item.Coordinates.split(',');
  if (parts.length !== 2 || parts.some((part) => part.trim() === ''))
    return null;
  const lat = Number(parts[0].trim());
  const lon = Number(parts[1].trim());
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;

  const magnitudeText =
    typeof item.Magnitude === 'string' ? item.Magnitude.trim() : '';
  if (!MAGNITUDE.test(magnitudeText)) return null;
  const mag = Number(magnitudeText);
  if (!Number.isFinite(mag) || mag > 10) return null;

  const depthMatch =
    typeof item.Kedalaman === 'string'
      ? DEPTH.exec(item.Kedalaman.trim())
      : null;
  const depthKm = depthMatch ? Number(depthMatch[1]) : null;

  const place = cleanText(item.Wilayah, 160) || null;
  const potential = cleanText(item.Potensi, 160) || null;
  const feltReport = cleanText(item.Dirasakan, 240) || null;
  const tsunami =
    potential !== null &&
    /berpotensi\s+tsunami/i.test(potential) &&
    !/tidak\s+berpotensi/i.test(potential);
  const stableId = `bmkg-${time}-${lat.toFixed(2)},${lon.toFixed(2)}`;
  return {
    stableId,
    usgsId: null,
    bmkgId: stableId,
    provider: 'BMKG',
    providers: ['BMKG'],
    lon,
    lat,
    depthKm,
    mag,
    place,
    time,
    tsunami,
    felt: felt || feltReport !== null,
    feltReport,
    potential,
  };
}

/**
 * Validate one BMKG feed. `Infogempa.gempa` is a single object (autogempa) or
 * an array (gempaterkini, gempadirasakan). Bad items are skipped; a bad
 * structure returns null so the caller keeps its last good snapshot.
 * @param {unknown} payload
 * @param {{felt?: boolean}} [options] - `felt` marks every row as felt.
 * @returns {Array<object>|null}
 */
export function normalizeBmkgEvents(payload, { felt = false } = {}) {
  const gempa = payload?.Infogempa?.gempa;
  let items;
  if (Array.isArray(gempa)) items = gempa;
  else if (isPlainObject(gempa)) items = [gempa];
  else return null;
  const rows = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    const row = normalizeItem(item, felt);
    if (row) rows.push(row);
  }
  return rows;
}

const firstNonNull = (a, b) => a ?? b;

/** Merge BMKG rows from several feeds, deduplicated by stableId. */
export function mergeBmkgRows(...rowArrays) {
  const byId = new Map();
  for (const rows of rowArrays) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const existing = byId.get(row.stableId);
      if (!existing) {
        byId.set(row.stableId, { ...row });
        continue;
      }
      existing.tsunami = Boolean(existing.tsunami || row.tsunami);
      existing.felt = Boolean(existing.felt || row.felt);
      for (const key of [
        'depthKm',
        'place',
        'feltReport',
        'potential',
        'usgsId',
      ])
        existing[key] = firstNonNull(existing[key], row[key] ?? null);
    }
  }
  return [...byId.values()];
}

function haversineKm(latA, lonA, latB, lonB) {
  const rad = Math.PI / 180;
  const dLat = (latB - latA) * rad;
  const dLon = (lonB - lonA) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * rad) * Math.cos(latB * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Combine USGS and BMKG rows into one list. A BMKG row that matches a USGS row
 * (within 90 s and 100 km) replaces it and carries both provider names.
 * Inputs are never mutated.
 */
export function mergeEarthquakeProviders(
  usgsRows,
  bmkgRows,
  { now = Date.now(), windowMs = DAY_MS } = {},
) {
  const usgs = (Array.isArray(usgsRows) ? usgsRows : []).map((row) => ({
    provider: 'USGS',
    providers: ['USGS'],
    bmkgId: null,
    tsunami: false,
    felt: false,
    feltReport: null,
    potential: null,
    ...row,
  }));
  const matched = new Set();
  const out = [];
  const bmkg = (Array.isArray(bmkgRows) ? bmkgRows : []).filter(
    (row) =>
      Number.isFinite(row?.time) &&
      row.time >= now - windowMs &&
      row.time <= now + FUTURE_SLACK_MS,
  );
  for (const row of bmkg) {
    let best = -1;
    let bestDelta = Infinity;
    usgs.forEach((candidate, index) => {
      if (matched.has(index) || !Number.isFinite(candidate.time)) return;
      const delta = Math.abs(candidate.time - row.time);
      if (delta > MATCH_TIME_MS || delta >= bestDelta) return;
      if (
        haversineKm(row.lat, row.lon, candidate.lat, candidate.lon) >
        MATCH_DISTANCE_KM
      )
        return;
      best = index;
      bestDelta = delta;
    });
    if (best >= 0) {
      matched.add(best);
      out.push({
        ...row,
        usgsId: usgs[best].usgsId ?? null,
        providers: ['BMKG', 'USGS'],
      });
    } else {
      out.push({ ...row });
    }
  }
  usgs.forEach((row, index) => {
    if (!matched.has(index)) out.push(row);
  });
  // A duplicate stableId would collide as a Cesium entity id; keep the first.
  const seen = new Set();
  const unique = out.filter((row) => {
    if (seen.has(row.stableId)) return false;
    seen.add(row.stableId);
    return true;
  });
  return unique.sort((a, b) => {
    const aOk = Number.isFinite(a.time);
    const bOk = Number.isFinite(b.time);
    if (aOk && bOk) return b.time - a.time;
    if (aOk) return -1;
    if (bOk) return 1;
    return 0;
  });
}
