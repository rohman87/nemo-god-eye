import { normalizeEarthquakeSnapshot } from './records.js';
import {
  BMKG_FEED_URLS,
  mergeBmkgRows,
  mergeEarthquakeProviders,
  normalizeBmkgEvents,
} from './bmkg.js';
const API_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
/** Request and validate a complete USGS snapshot before it can replace displayed events. */
export function createUsgsEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEarthquakeSnapshot(payload);
      if (!rows) throw new Error('Malformed USGS response');
      return rows;
    },
  };
}

/**
 * Request the three BMKG feeds; one failing feed does not blank the others.
 * Each feed has its own deadline, so a hung BMKG host cannot hold back the
 * USGS rows the composite source waits on alongside it.
 */
export function createBmkgEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  const getFeed = async (key, url, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('BMKG request timed out')),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`BMKG HTTP ${response.status}`);
      const payload = await response.json();
      controller.signal.throwIfAborted();
      const rows = normalizeBmkgEvents(payload, { felt: key === 'felt' });
      if (!rows) throw new Error('Malformed BMKG response');
      return rows;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  return {
    async getSnapshot({ signal } = {}) {
      const results = await Promise.allSettled(
        Object.entries(BMKG_FEED_URLS).map(([key, url]) =>
          getFeed(key, url, signal),
        ),
      );
      signal?.throwIfAborted();
      const ok = results.filter((result) => result.status === 'fulfilled');
      if (ok.length === 0) throw results[0].reason;
      return mergeBmkgRows(...ok.map((result) => result.value));
    },
  };
}

/**
 * Merge USGS and BMKG into one snapshot. A provider that fails falls back on
 * its last good rows while they are younger than maxCacheAgeMs; the snapshot
 * only fails when neither provider has anything to offer.
 */
export function createCompositeEarthquakeSource({
  usgs,
  bmkg,
  now = () => Date.now(),
  maxCacheAgeMs = 6 * 3_600_000,
}) {
  if (typeof usgs?.getSnapshot !== 'function')
    throw new TypeError('Composite earthquakes require a USGS source');
  if (typeof bmkg?.getSnapshot !== 'function')
    throw new TypeError('Composite earthquakes require a BMKG source');
  const providers = { usgs, bmkg };
  const lastGood = { usgs: null, bmkg: null };
  let status = { usgs: 'idle', bmkg: 'idle' };
  return {
    async getSnapshot({ signal } = {}) {
      const keys = Object.keys(providers);
      const results = await Promise.allSettled(
        keys.map((key) => providers[key].getSnapshot({ signal })),
      );
      signal?.throwIfAborted();
      const at = now();
      const rows = {};
      const errors = {};
      const next = {};
      keys.forEach((key, index) => {
        const result = results[index];
        if (result.status === 'fulfilled') {
          const value = Array.isArray(result.value) ? result.value : [];
          lastGood[key] = { rows: value, at };
          rows[key] = value;
          next[key] = 'ok';
          return;
        }
        errors[key] = result.reason;
        console.warn(
          `[Data:Earthquakes] ${key.toUpperCase()} unavailable:`,
          result.reason?.message || result.reason,
        );
        const cached = lastGood[key];
        if (cached && at - cached.at < maxCacheAgeMs) {
          rows[key] = cached.rows;
          next[key] = 'cached';
        } else {
          lastGood[key] = null;
          next[key] = 'down';
        }
      });
      status = next;
      if (!rows.usgs && !rows.bmkg) throw errors.usgs ?? errors.bmkg;
      return mergeEarthquakeProviders(rows.usgs ?? [], rows.bmkg ?? [], {
        now: at,
      });
    },
    getProviderStatus() {
      return { ...status };
    },
  };
}
