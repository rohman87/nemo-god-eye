/**
 * Pure helpers for the forest-alerts imagery layer: the Global Forest Watch
 * tile endpoints, the integrated-alert pixel encoding and the display colours.
 * No DOM or Cesium, so everything here runs under `node:test`.
 */

export const FOREST_ALERTS_LAYER_ID = 'forest-alerts';

/** Indonesia only: Global Forest Watch tiles are requested inside this box. */
export const INDONESIA_BOUNDS = Object.freeze({
  west: 94,
  south: -11.5,
  east: 141.5,
  north: 6.5,
});

/** Data-encoded integrated alerts (GLAD-L, GLAD-S2, RADD), Web Mercator XYZ. */
export const ALERTS_TILE_URL =
  'https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png';
/** Peatland extent, Web Mercator XYZ. */
export const PEAT_TILE_URL =
  'https://tiles.globalforestwatch.org/gfw_peatlands/latest/default/{z}/{x}/{y}.png';

export const TILE_MINIMUM_LEVEL = 0;
/** Beyond this Cesium overzooms the last level instead of requesting more. */
export const TILE_MAXIMUM_LEVEL = 12;

export const WINDOW_DAYS = Object.freeze([30, 90]);
export const DEFAULT_WINDOW_DAYS = 90;

/** Alerts count days since this date (UTC). */
export const ALERT_EPOCH_MS = Date.UTC(2015, 0, 1);
const MS_PER_DAY = 86_400_000;

export const CONFIDENCE_COLORS = Object.freeze({
  lower: '#c06a94',
  high: '#ff4f9a',
  highest: '#ffe0ee',
});
export const PEAT_COLOR = '#a1704a';
export const PEAT_ALPHA = 0.35;

/** Age fade: alerts up to `maxAge` days old draw at `alpha`. Fixed steps. */
export const AGE_STEPS = Object.freeze([
  { maxAge: 30, alpha: 0.95 },
  { maxAge: 60, alpha: 0.7 },
  { maxAge: 90, alpha: 0.45 },
]);

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const CONFIDENCE_RGB = Object.freeze({
  lower: hexToRgb(CONFIDENCE_COLORS.lower),
  high: hexToRgb(CONFIDENCE_COLORS.high),
  highest: hexToRgb(CONFIDENCE_COLORS.highest),
});
const PEAT_RGBA = Object.freeze([
  ...hexToRgb(PEAT_COLOR),
  Math.round(PEAT_ALPHA * 255),
]);

/** Whole days since 2015-01-01 UTC for a millisecond timestamp. */
export function dayIndexFor(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return NaN;
  return Math.floor((value - ALERT_EPOCH_MS) / MS_PER_DAY);
}

/** A window other than the offered ones falls back to the default. */
export function normalizeWindow(days) {
  return WINDOW_DAYS.includes(Number(days))
    ? Number(days)
    : DEFAULT_WINDOW_DAYS;
}

/**
 * Decode one integrated-alert pixel. R and G hold the alert day (R * 255 + G),
 * B the confidence (100 lower, 200 high, 255 highest) and A the intensity, 0
 * meaning there is no alert. Returns null for a pixel that carries no alert.
 * @returns {{ dayIndex: number, confidence: 'lower' | 'high' | 'highest' } | null}
 */
export function decodeAlertPixel(r, g, b, a) {
  if (![r, g, b, a].every(Number.isFinite)) return null;
  if (a <= 0 || b <= 0) return null;
  const confidence = b >= 250 ? 'highest' : b >= 150 ? 'high' : 'lower';
  return { dayIndex: r * 255 + g, confidence };
}

/**
 * Display colour for a decoded alert, or null when it is outside the window.
 * An alert dated at most a day ahead of the local clock (UTC skew) counts as
 * today; anything further ahead is not trusted.
 * @returns {[number, number, number, number] | null} RGBA bytes
 */
export function alertPixelColor(decoded, nowDayIndex, windowDays) {
  if (!decoded || !Number.isFinite(nowDayIndex)) return null;
  const age = nowDayIndex - decoded.dayIndex;
  if (age < -1) return null;
  const days = Math.max(0, age);
  if (days > normalizeWindow(windowDays)) return null;
  const step = AGE_STEPS.find((candidate) => days <= candidate.maxAge);
  const rgb = CONFIDENCE_RGB[decoded.confidence];
  if (!step || !rgb) return null;
  return [rgb[0], rgb[1], rgb[2], Math.round(step.alpha * 255)];
}

/**
 * Recolour a tile's RGBA bytes in place; pixels outside the window become
 * transparent. Returns the number of alert pixels left visible.
 */
export function recolorAlertPixels(data, nowDayIndex, windowDays) {
  let visible = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const color = alertPixelColor(
      decodeAlertPixel(data[i], data[i + 1], data[i + 2], data[i + 3]),
      nowDayIndex,
      windowDays,
    );
    if (color) {
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = color[3];
      visible++;
    } else data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
  }
  return visible;
}

/** Tint every non-transparent peat pixel in place. Returns the pixels tinted. */
export function recolorPeatPixels(data) {
  let tinted = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] > 0) {
      data[i] = PEAT_RGBA[0];
      data[i + 1] = PEAT_RGBA[1];
      data[i + 2] = PEAT_RGBA[2];
      data[i + 3] = PEAT_RGBA[3];
      tinted++;
    } else data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
  }
  return tinted;
}
