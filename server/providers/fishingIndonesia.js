import { normalizeGfwEvents } from '../../src/layers/fishingActivity/model.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Global Fishing Watch Events API v3: apparent fishing events and AIS-gap
// events inside Indonesia's EEZ. Needs a free, non-commercial API token
// (GFW_API_TOKEN, server-side only). The token is sent to GFW alone and never
// reaches the browser, a log line or a response.
const UPSTREAM =
  'https://gateway.api.globalfishingwatch.org/v3/events?offset=0&limit=500';
const FISHING_DATASET = 'public-global-fishing-events:latest';
const GAPS_DATASET = 'public-global-gaps-events:latest';
/** Marine Regions MRGID of the Indonesian EEZ, as GFW's `public-eez-areas` id. */
const EEZ_REGION = { dataset: 'public-eez-areas', id: 8492 };

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** GFW data lags 3-5 days, so the window reaches two weeks back. */
const WINDOW_DAYS = 14;
/** Events change slowly and the API is quota-limited; refresh a few times a day. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
/** After a failed refresh, leave the origin alone for this long. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** A rejected token will not fix itself; retry rarely. */
const REJECTED_BACKOFF_MS = 60 * 60 * 1000;
const KEY = 'indonesia';
const TOKEN_REJECTED = 'gfw_token_rejected';
const UNAVAILABLE = 'fishing_unavailable';

const failure = (code) => Object.assign(new Error(code), { code });

/** The configured token, read per request so adding it needs no restart. */
const envToken = () => String(process.env.GFW_API_TOKEN || '').trim();

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Fixed-origin, bounded Global Fishing Watch route for dev and preview. */
export function fishingIndonesiaProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  getToken = envToken,
} = {}) {
  /** @type {{value: object, savedAt: number}|null} */
  let entry = null;
  /** @type {{at: number, backoffMs: number, code: string, token: string}|null} */
  let lastFailure = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function logRejection(response, token, signal) {
    try {
      const body = await readResponseJsonCapped(response, 64 * 1024, signal);
      const text = JSON.stringify(body?.messages ?? null)
        .split(token)
        .join('[token]')
        .slice(0, 500);
      console.warn('[Data:Fishing] GFW rejected the request (422):', text);
    } catch {
      console.warn('[Data:Fishing] GFW rejected the request (422)');
    }
  }

  async function fetchDataset(dataset, token, window) {
    const signal = AbortSignal.timeout(20_000);
    const response = await fetchImpl(UPSTREAM, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        datasets: [dataset],
        startDate: window.startDate,
        endDate: window.endDate,
        region: EEZ_REGION,
      }),
      signal,
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw failure(TOKEN_REJECTED);
    }
    if (response.status === 422) {
      await logRejection(response, token, signal);
      throw failure(UNAVAILABLE);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(UNAVAILABLE);
    }
    return readResponseJsonCapped(response, 8 * MIB, signal);
  }

  async function fetchSnapshot(token) {
    const at = now();
    const window = {
      startDate: isoDay(at - WINDOW_DAYS * DAY_MS),
      endDate: isoDay(at),
    };
    const results = await Promise.allSettled([
      fetchDataset(FISHING_DATASET, token, window),
      fetchDataset(GAPS_DATASET, token, window),
    ]);
    // A rejected token outranks any other failure.
    const rejected = results.find(
      (result) =>
        result.status === 'rejected' && result.reason?.code === TOKEN_REJECTED,
    );
    if (rejected) throw rejected.reason;
    if (results.some((result) => result.status === 'rejected'))
      throw failure(UNAVAILABLE);
    const fishing = normalizeGfwEvents(results[0].value, 'fishing');
    const gaps = normalizeGfwEvents(results[1].value, 'gaps');
    // A malformed page must not replace a good cache.
    if (!fishing || !gaps) throw failure(UNAVAILABLE);
    return {
      fetchedAt: at,
      windowStart: window.startDate,
      windowEnd: window.endDate,
      fishing: fishing.items,
      gaps: gaps.items,
      truncated: { fishing: fishing.truncated, gaps: gaps.truncated },
    };
  }

  async function acquire(token) {
    const previous = entry;
    if (previous && now() - previous.savedAt < TTL_MS)
      return { value: previous.value, stale: false };
    const servable = previous && now() - previous.savedAt <= STALE_MAX_MS;
    const serveStale = () => {
      if (servable) return { value: previous.value, stale: true };
      throw failure(lastFailure?.code ?? UNAVAILABLE);
    };
    // A new token is not bound by the backoff earned by the old one.
    if (
      lastFailure !== null &&
      lastFailure.token === token &&
      now() - lastFailure.at < lastFailure.backoffMs
    ) {
      if (lastFailure.code === TOKEN_REJECTED) throw failure(TOKEN_REJECTED);
      return serveStale();
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, KEY, async () => {
        try {
          const value = await fetchSnapshot(token);
          entry = { value, savedAt: now() };
          lastFailure = null;
          return value;
        } catch (error) {
          const code =
            error?.code === TOKEN_REJECTED ? TOKEN_REJECTED : UNAVAILABLE;
          lastFailure = {
            at: now(),
            backoffMs:
              code === TOKEN_REJECTED
                ? REJECTED_BACKOFF_MS
                : FAILURE_BACKOFF_MS,
            code,
            token,
          };
          throw failure(code);
        }
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (error?.code === TOKEN_REJECTED) throw error;
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
    const token = getToken();
    // Without a token there is nothing to ask GFW and nothing to cache.
    if (!token) return json(200, { configured: false });
    try {
      const { value, stale } = await acquire(token);
      json(
        200,
        {
          configured: true,
          fetchedAt: value.fetchedAt,
          stale,
          windowStart: value.windowStart,
          windowEnd: value.windowEnd,
          fishing: value.fishing,
          gaps: value.gaps,
          truncated: value.truncated,
        },
        stale,
      );
    } catch (error) {
      json(502, {
        error: error?.code === TOKEN_REJECTED ? TOKEN_REJECTED : UNAVAILABLE,
      });
    }
  }

  return {
    name: 'fishing-indonesia',
    configureServer({ middlewares }) {
      middlewares.use('/api/fishing/indonesia', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fishing/indonesia', handler);
    },
  };
}
