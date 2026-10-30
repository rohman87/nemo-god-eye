/**
 * @module layers/airQuality/ispu
 *
 * Indonesian ISPU (Indeks Standar Pencemar Udara) stations, published by the
 * Ministry of Environment and Forestry (KLHK) through SiPongi. Pure — no Cesium,
 * no network.
 *
 * Two entry points share one station shape. `normalizeIspuStations` validates
 * the upstream GeoJSON on the server; `ispuReadings` re-validates the proxy's
 * answer on the client and turns it into provider-shaped readings. Neither
 * trusts the other: each side treats the payload it receives as untrusted.
 */
import {
  OBSERVATION_MAX_AGE_MS,
  bandForValue,
  valueLabel,
  bandRiskText,
  airQualityColor,
  compareReadingSeverity,
} from './model.js';

/** Upper bound on stations kept from one upstream pull (~108 are published). */
export const ISPU_MAX_STATIONS = 500;

const HOUR_MS = 60 * 60 * 1000;
/** A reading dated further ahead than this was parsed in the wrong zone. */
const MAX_FUTURE_SKEW_MS = HOUR_MS;

const CITY_MAX = 80;
const PROVINCE_MAX = 80;
const ADDRESS_MAX = 160;
const ID_MAX = 32;

/** Indonesia's bounding box, degrees. */
const BOUNDS = Object.freeze({
  south: -11.5,
  north: 6.5,
  west: 94,
  east: 141.5,
});

const set = (...names) => new Set(names.map((name) => name.toLowerCase()));

/** Provinces on Waktu Indonesia Timur, UTC+9. */
const WIT_PROVINCES = set(
  'Maluku',
  'Maluku Utara',
  'Papua',
  'Papua Barat',
  'Papua Barat Daya',
  'Papua Tengah',
  'Papua Pegunungan',
  'Papua Selatan',
);

/** Provinces on Waktu Indonesia Tengah, UTC+8. */
const WITA_PROVINCES = set(
  'Bali',
  'Nusa Tenggara Barat',
  'Nusa Tenggara Timur',
  'Kalimantan Selatan',
  'Kalimantan Timur',
  'Kalimantan Utara',
  'Sulawesi Utara',
  'Sulawesi Tengah',
  'Sulawesi Selatan',
  'Sulawesi Tenggara',
  'Sulawesi Barat',
  'Gorontalo',
);

/** Common abbreviations of WITA provinces. */
const WITA_ALIASES = set('NTB', 'NTT', 'Kaltim', 'Kalsel', 'Kaltara');

/** Provinces on Waktu Indonesia Barat, UTC+7. */
const WIB_PROVINCES = set(
  'Aceh',
  'Sumatera Utara',
  'Sumatera Barat',
  'Sumatera Selatan',
  'Riau',
  'Kepulauan Riau',
  'Kep Riau',
  'Jambi',
  'Bengkulu',
  'Lampung',
  'Bangka Belitung',
  'Kepulauan Bangka Belitung',
  'DKI Jakarta',
  'Jakarta',
  'Banten',
  'Jawa Barat',
  'Jawa Tengah',
  'Jawa Timur',
  'DI Yogyakarta',
  'Yogyakarta',
  'Kalimantan Barat',
  'Kalimantan Tengah',
);

const TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
// C0/C1 controls, zero-width marks and bidi overrides: none belong in a label.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
const NUMERIC_TEXT = /^\d+(\.\d+)?$/;

/**
 * UTC offset of a province's time zone: 9 (WIT), 8 (WITA) or 7 (WIB).
 * An unknown or misspelt province falls back on longitude. The zone borders do
 * not follow meridians, so that is only a rough guide.
 * @param {string} province
 * @param {number} [lon]
 * @returns {number} Hours east of UTC.
 */
export function ispuUtcOffsetHours(province, lon) {
  const key = String(province ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (WIT_PROVINCES.has(key)) return 9;
  if (WITA_PROVINCES.has(key) || WITA_ALIASES.has(key)) return 8;
  if (WIB_PROVINCES.has(key)) return 7;
  if (Number.isFinite(lon)) {
    if (lon >= 127) return 9;
    if (lon >= 115) return 8;
  }
  return 7;
}

/**
 * Parse a station-local `waktu` stamp into epoch ms. The upstream publishes
 * local wall time with no zone, so the province decides the offset.
 * An explicit zone in the stamp (`Z`, `+07:00`) wins over the province.
 * @param {string} waktu - `YYYY-MM-DD HH:mm[:ss[.fff]][zone]`.
 * @param {string} province
 * @param {number} [lon] - Used when the province is unknown.
 * @returns {number|null} Epoch ms, or null when malformed.
 */
export function parseIspuTime(waktu, province, lon) {
  if (typeof waktu !== 'string') return null;
  const match = TIME_PATTERN.exec(waktu.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(utc)) return null;
  // Date.UTC rolls 30 February over into March; reject it instead.
  if (new Date(utc).getUTCDate() !== day) return null;
  const zone = match[7];
  if (zone === 'Z') return utc;
  if (zone) {
    const digits = zone.replace(':', '');
    const sign = digits[0] === '-' ? -1 : 1;
    const minutes =
      Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5));
    if (minutes > 14 * 60) return null;
    return utc - sign * minutes * 60 * 1000;
  }
  return utc - ispuUtcOffsetHours(province, lon) * HOUR_MS;
}

const inBounds = (lat, lon) =>
  lat >= BOUNDS.south &&
  lat <= BOUNDS.north &&
  lon >= BOUNDS.west &&
  lon <= BOUNDS.east;

/** A finite number from a number or numeric string, else null. */
function coordinate(raw) {
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
  } else if (typeof raw !== 'number') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Clean upstream text: no control characters, single-spaced, length-capped. */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** An ISPU value: integer 0..1000 from a number or plain decimal string. */
function ispuValue(raw) {
  let value;
  if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'string' && NUMERIC_TEXT.test(raw.trim()))
    value = Number(raw.trim());
  else return null;
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= 1000 ? rounded : null;
}

/**
 * Validate the SiPongi AQMS FeatureCollection into station rows.
 *
 * Atomic on structure, forgiving on content: a response whose `features` is not
 * an array returns null so the caller keeps its last good snapshot. One feature
 * with bad properties, coordinates, value or time is merely skipped. Stations
 * that share a city get their address appended so their labels differ.
 *
 * @param {object} geojson - Upstream `/api/aqms` body.
 * @returns {Array<object>|null} Stations, or null when malformed.
 */
export function normalizeIspuStations(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const byId = new Map();
  for (const feature of geojson.features.slice(0, ISPU_MAX_STATIONS)) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      continue;
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lon = coordinate(coordinates[0]);
    const lat = coordinate(coordinates[1]);
    if (lon === null || lat === null || !inBounds(lat, lon)) continue;

    const value = ispuValue(properties.val ?? properties.nilai);
    if (value === null) continue;
    const province = cleanText(properties.provinsi, PROVINCE_MAX);
    const observedMs = parseIspuTime(properties.waktu, province, lon);
    if (observedMs === null) continue;

    const id = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const previous = byId.get(id);
    if (previous && previous.observedMs >= observedMs) continue;
    const city = cleanText(properties.kota, CITY_MAX);
    byId.set(id, {
      id,
      name: city || province || id,
      city,
      province,
      address: cleanText(properties.alamat, ADDRESS_MAX),
      lat,
      lon,
      value,
      observedMs,
    });
  }
  const stations = [...byId.values()];
  const perName = new Map();
  for (const station of stations)
    perName.set(station.name, (perName.get(station.name) || 0) + 1);
  for (const station of stations)
    if (perName.get(station.name) > 1 && station.address)
      station.name =
        `${station.name} · ${station.address.split(',')[0].trim().slice(0, 32)}`.slice(
          0,
          CITY_MAX,
        );
  return stations;
}

/**
 * Turn the proxy's `{ stations }` body into provider-shaped readings.
 *
 * Rows are re-validated rather than trusted: the client cannot assume the
 * proxy (or whatever answers on that path) honoured its contract. Readings older
 * than OBSERVATION_MAX_AGE_MS are dropped, as are those dated more than an hour
 * ahead, which means the station's time zone was misread.
 *
 * @param {object} payload - Proxy body.
 * @param {number} [now=Date.now()] - Clock seam for tests.
 * @returns {Array<object>|null} Readings, or null when the payload is malformed.
 */
export function ispuReadings(payload, now = Date.now()) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.stations)
  )
    return null;
  const byId = new Map();
  for (const row of payload.stations.slice(0, ISPU_MAX_STATIONS)) {
    if (!row || typeof row !== 'object') continue;
    const { id, name, province, lat, lon, value, observedMs } = row;
    if (typeof id !== 'string' || id === '' || id.length > ID_MAX) continue;
    if (cleanText(id, ID_MAX) !== id) continue;
    if (typeof name !== 'string' || typeof province !== 'string') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!inBounds(lat, lon)) continue;
    if (!Number.isInteger(value) || value < 0 || value > 1000) continue;
    if (!Number.isFinite(observedMs)) continue;
    if (now - observedMs > OBSERVATION_MAX_AGE_MS) continue;
    if (observedMs - now > MAX_FUTURE_SKEW_MS) continue;
    // A duplicate id would collide as an entity id; keep the newest reading.
    if (byId.get(id)?.observedMs >= observedMs) continue;

    const band = bandForValue('klhk', value);
    byId.set(id, {
      id: `klhk:${id}`,
      provider: 'klhk',
      scale: 'ISPU',
      value,
      band,
      stationId: id,
      name: cleanText(name, CITY_MAX),
      zone: cleanText(province, PROVINCE_MAX),
      lat,
      lon,
      observedMs,
      color: airQualityColor(band),
      label: valueLabel('klhk', value),
      risk: bandRiskText(band),
      note: null,
    });
  }
  return [...byId.values()].sort(compareReadingSeverity);
}
