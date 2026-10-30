import { normalizeIspuStations } from '../../src/layers/airQuality/ispu.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// KLHK SiPongi+ AQMS: ISPU readings for ~108 Indonesian stations (public,
// keyless). The origin sends no CORS header, so the browser cannot read it.
const UPSTREAM = 'https://opsroom.sipongidata.my.id/api/aqms';

const MIB = 1024 * 1024;
/** ISPU is published hourly; ten minutes keeps the layer fresh at one pull each. */
const TTL_MS = 10 * 60 * 1000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 3 * 60 * 60 * 1000;
/** After a failed refresh, leave the origin alone for this long. */
const FAILURE_BACKOFF_MS = 60_000;
const KEY = 'stations';

/** Fixed-origin, bounded KLHK ISPU route for dev and preview. */
export function airQualityIndonesiaProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {{value: {fetchedAt: number, stations: Array<object>}, savedAt: number}|null} */
  let entry = null;
  let failedAt = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchStations() {
    const signal = AbortSignal.timeout(20_000);
    const response = await fetchImpl(UPSTREAM, {
      headers: { Accept: 'application/json' },
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(response, 2 * MIB, signal);
    const stations = normalizeIspuStations(payload);
    // An empty pull must not replace a good cache.
    if (!stations || stations.length === 0) throw new Error('invalid_snapshot');
    return { fetchedAt: now(), stations };
  }

  async function acquire() {
    const previous = entry;
    if (previous && now() - previous.savedAt < TTL_MS)
      return { value: previous.value, stale: false };
    const servable = previous && now() - previous.savedAt <= STALE_MAX_MS;
    const serveStale = () => {
      if (servable) return { value: previous.value, stale: true };
      throw new Error('air_quality_unavailable');
    };
    if (failedAt !== null && now() - failedAt < FAILURE_BACKOFF_MS)
      return serveStale();
    try {
      const { promise } = coalesceProxyRequest(inFlight, KEY, async () => {
        try {
          const value = await fetchStations();
          entry = { value, savedAt: now() };
          failedAt = null;
          return value;
        } catch (error) {
          failedAt = now();
          throw error;
        }
      });
      return { value: await promise, stale: false };
    } catch {
      return serveStale();
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(
        200,
        { fetchedAt: value.fetchedAt, stale, stations: value.stations },
        stale,
      );
    } catch {
      json(502, { error: 'air_quality_unavailable' });
    }
  }

  return {
    name: 'air-quality-indonesia',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-quality/indonesia', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-quality/indonesia', handler);
    },
  };
}
