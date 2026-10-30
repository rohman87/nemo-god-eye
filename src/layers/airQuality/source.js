import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  OBSERVATION_MAX_AGE_MS,
  compareReadingSeverity,
  normalizeAqhiStations,
  normalizeAqhiObservations,
} from './model.js';
import { ispuReadings } from './ispu.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel and the Weather card show them translated.
const msg = (text) => text;

const COLLECTIONS_ROOT = 'https://api.weather.gc.ca/collections';
const STATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-stations/items`;
const OBSERVATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-observations-realtime/items`;
/** Same-origin proxy of KLHK's SiPongi AQMS feed, which sends no CORS header. */
const ISPU_URL = '/api/air-quality/indonesia';
/** The proxy returns ~108 stations, a few tens of KB. */
const ISPU_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Comfortably above Canada's ~134 stations without inviting a huge page. */
const STATION_LIMIT = 500;
const OBSERVATION_LIMIT = 500;
/** Station geometry is near-static — a few changes a year. Refetch twice a day. */
const STATION_TTL_MS = 12 * 60 * 60 * 1000;
/** A full 500-row GeoJSON page is a few hundred KB; anything past this is not a page. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Request and validate a complete ECCC AQHI snapshot before it can replace
 * displayed readings. The first registered air-quality provider.
 *
 * Two collections are involved. `aqhi-stations` is the catalog — it supplies
 * every reading its coordinates and is cached for twelve hours because it
 * barely changes. `aqhi-observations-realtime` is the hourly reading feed,
 * requested with `latest=true` so the response is current values rather than
 * the full observation history, which is roughly 2,000 rows nationally.
 *
 * The station catalog is only replaced when a refresh actually returns
 * stations, so a transient empty response cannot blank the layer.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for each request.
 * @returns {{getSnapshot: Function}}
 */
export function createEcccAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  /** @type {Map<string, object>} */
  let stations = new Map();
  let stationsFetchedAt = 0;

  /** One bounded GeoJSON page: deadline, caller abort, byte cap, row cap. */
  const getJson = async (url, limit, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(msg('ECCC request timed out'))),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ECCC HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal,
      );
      // The server's `limit` is a request, not a guarantee.
      if (Array.isArray(payload?.features) && payload.features.length > limit)
        return { ...payload, features: payload.features.slice(0, limit) };
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  return {
    async getSnapshot({ signal } = {}) {
      const clock = now();
      if (stations.size === 0 || clock - stationsFetchedAt > STATION_TTL_MS) {
        const payload = await getJson(
          `${STATIONS_URL}?f=json&limit=${STATION_LIMIT}`,
          STATION_LIMIT,
          signal,
        );
        const next = normalizeAqhiStations(payload);
        if (!next) throw new Error(msg('Malformed AQHI station response'));
        // An empty refresh must not wipe a good catalog.
        if (next.size > 0) {
          stations = next;
          stationsFetchedAt = clock;
        }
      }
      if (stations.size === 0)
        throw new Error(msg('No AQHI stations available'));

      const payload = await getJson(
        `${OBSERVATIONS_URL}?f=json&latest=true&limit=${OBSERVATION_LIMIT}`,
        OBSERVATION_LIMIT,
        signal,
      );
      const readings = normalizeAqhiObservations(payload, stations, clock);
      if (!readings)
        throw new Error(msg('Malformed AQHI observation response'));
      return readings;
    },
  };
}

/**
 * Request and validate a complete KLHK ISPU snapshot from the same-origin
 * proxy. The proxy owns upstream caching, so this source is stateless.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for the request.
 * @returns {{getSnapshot: Function}}
 */
export function createSipongiAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(msg('ISPU request timed out'))),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(ISPU_URL, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`ISPU HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          ISPU_MAX_RESPONSE_BYTES,
          controller.signal,
        );
        const readings = ispuReadings(payload, now());
        if (!readings) throw new Error(msg('Malformed ISPU response'));
        return readings;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

/**
 * Merge several air-quality sources into one snapshot. A provider that fails
 * does not blank the others, and does not blank itself either: its last good
 * readings stand in, minus any that have aged past OBSERVATION_MAX_AGE_MS.
 * Only when every provider fails with nothing to fall back on does the
 * snapshot fail, with a neutral error that names no single provider.
 *
 * @param {Array<{getSnapshot: Function}>} sources
 * @param {{now?: Function}} [options] - Clock seam for tests.
 * @returns {{getSnapshot: Function}}
 */
export function createCompositeAirQualitySource(
  sources,
  { now = Date.now } = {},
) {
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.some((source) => typeof source?.getSnapshot !== 'function')
  )
    throw new TypeError('Composite air quality requires snapshot sources');
  const lastGood = sources.map(() => null);
  return {
    async getSnapshot({ signal } = {}) {
      const results = await Promise.allSettled(
        sources.map((source) => source.getSnapshot({ signal })),
      );
      signal?.throwIfAborted();
      const at = now();
      const merged = [];
      const failures = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const readings = Array.isArray(result.value) ? result.value : [];
          lastGood[index] = readings;
          merged.push(...readings);
          return;
        }
        failures.push(result.reason);
        console.warn(
          '[Data:AirQuality] Provider failed:',
          result.reason?.message || result.reason,
        );
        const fallback = (lastGood[index] || []).filter(
          (reading) => at - reading.observedMs <= OBSERVATION_MAX_AGE_MS,
        );
        lastGood[index] = fallback.length ? fallback : null;
        merged.push(...fallback);
      });
      if (failures.length === results.length && merged.length === 0)
        throw new Error(msg('Air quality request failed'), {
          cause: failures,
        });
      return merged.sort(compareReadingSeverity);
    },
  };
}
