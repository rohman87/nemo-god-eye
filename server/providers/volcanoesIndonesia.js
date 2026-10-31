import {
  parseMagmaLevels,
  parseVonaNotices,
} from '../../src/layers/volcanoes/magma.js';
import { readResponseTextCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// PVMBG MAGMA Indonesia: volcano activity levels and VONA aviation notices
// (public, keyless HTML). The origin sends no CORS header, so the browser
// cannot read it, and the pages are scraped here rather than in the client.
const LEVELS_URL = 'https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas';
const VONA_URL = 'https://magma.esdm.go.id/vona';

const MIB = 1024 * 1024;
/** Levels change on the scale of days; half an hour is plenty fresh. */
const TTL_MS = 30 * 60 * 1000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 6 * 60 * 60 * 1000;
/** Longest the previous VONA notices stand in when only that page fails. */
const NOTICES_STALE_MAX_MS = 6 * 60 * 60 * 1000;
/** After a failed refresh, leave the origin alone for this long. */
const FAILURE_BACKOFF_MS = 60_000;
const KEY = 'volcanoes';

/** Fixed-origin, bounded MAGMA volcano route for dev and preview. */
export function volcanoesIndonesiaProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {{value: object, savedAt: number}|null} */
  let entry = null;
  let failedAt = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchHtml(url) {
    const signal = AbortSignal.timeout(20_000);
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html' },
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseTextCapped(response, MIB, signal);
  }

  async function fetchLevels() {
    const levels = parseMagmaLevels(await fetchHtml(LEVELS_URL));
    // An unparseable pull must not replace a good cache.
    if (!levels) throw new Error('invalid_snapshot');
    return levels;
  }

  async function fetchNotices() {
    return parseVonaNotices(await fetchHtml(VONA_URL));
  }

  async function fetchSnapshot(previous) {
    const [levelsResult, noticesResult] = await Promise.allSettled([
      fetchLevels(),
      fetchNotices(),
    ]);
    if (levelsResult.status === 'rejected') throw levelsResult.reason;
    const at = now();
    if (noticesResult.status === 'fulfilled')
      return {
        fetchedAt: at,
        levels: levelsResult.value,
        notices: noticesResult.value,
        noticesStale: false,
        noticesAt: at,
      };
    // VONA alone failed: keep the last notices a while rather than hide them.
    const carry =
      previous?.noticesAt != null &&
      at - previous.noticesAt < NOTICES_STALE_MAX_MS;
    return {
      fetchedAt: at,
      levels: levelsResult.value,
      notices: carry ? previous.notices : [],
      noticesStale: true,
      noticesAt: carry ? previous.noticesAt : null,
    };
  }

  async function acquire() {
    const previous = entry;
    if (previous && now() - previous.savedAt < TTL_MS)
      return { value: previous.value, stale: false };
    const servable = previous && now() - previous.savedAt <= STALE_MAX_MS;
    const serveStale = () => {
      if (servable) return { value: previous.value, stale: true };
      throw new Error('volcanoes_unavailable');
    };
    if (failedAt !== null && now() - failedAt < FAILURE_BACKOFF_MS)
      return serveStale();
    try {
      const { promise } = coalesceProxyRequest(inFlight, KEY, async () => {
        try {
          const value = await fetchSnapshot(entry?.value);
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
        {
          fetchedAt: value.fetchedAt,
          stale,
          levels: value.levels,
          notices: value.notices,
          noticesStale: value.noticesStale,
        },
        stale,
      );
    } catch {
      json(502, { error: 'volcanoes_unavailable' });
    }
  }

  return {
    name: 'volcanoes-indonesia',
    configureServer({ middlewares }) {
      middlewares.use('/api/volcanoes/indonesia', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/volcanoes/indonesia', handler);
    },
  };
}
