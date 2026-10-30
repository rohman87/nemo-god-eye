import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';
import { readResponseTextCapped } from './common/http.js';

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) plus MODIS_NRT (combined Terra+Aqua,
 * ~1 km, numeric 0-100 confidence), fetched sequentially (quota courtesy)
 * with `days=2` (`days=1` means "current UTC day", nearly empty just after
 * 00:00Z) and clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS
 * quota is 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
 * TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/firms.json) prevents ANY upstream
 * fetch across dev-server restarts. Pattern mirrors celestrakProxy.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires, coverage}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions, coverage}
 *
 * Keyless fallback (no FIRMS_MAP_KEY): /api/firms serves NASA's public regional
 * "South-East Asia" 24 h CSVs (no key, no quota; covers Indonesia) instead of
 * the worldwide area API. The payload and status carry `coverage:
 * 'southeast-asia'` (`'world'` with a key); the regional files have no
 * `instrument` column, so it is derived from the source. Cache entries are
 * tagged with their coverage and a world cache never answers keyless requests
 * (or vice versa). Status keyless: {hasKey:false, transactions:null} —
 * mapkey_status is never called without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function firmsProxy() {
  const TTL_MS = 30 * 60_000;
  const STATUS_TTL_MS = 5 * 60_000;
  const SOURCES = [
    'VIIRS_NOAA20_NRT',
    'VIIRS_NOAA21_NRT',
    'VIIRS_SNPP_NRT',
    'MODIS_NRT',
  ];
  /** Public keyless NASA FIRMS regional (South-East Asia, ~24 h) CSVs. */
  const REGIONAL_BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire';
  const REGIONAL_FILES = {
    VIIRS_NOAA20_NRT: 'noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_24h.csv',
    VIIRS_NOAA21_NRT: 'noaa-21-viirs-c2/csv/J2_VIIRS_C2_SouthEast_Asia_24h.csv',
    VIIRS_SNPP_NRT:
      'suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv',
    MODIS_NRT: 'modis-c6.1/csv/MODIS_C6_1_SouthEast_Asia_24h.csv',
  };
  const REGIONAL_COVERAGE = 'southeast-asia';
  /**
   * Per-source body cap. A VIIRS world/2 pull is ~130k rows x ~100 B, about
   * 13 MB per satellite in heavy fire season (MODIS runs smaller), so this is a
   * bound, not a budget.
   */
  const FIRMS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
  /** Keyless regional 24 h files are a few MB; a tighter bound suffices. */
  const REGIONAL_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  /** First retry delay after a failed refresh; doubles per failure, capped at TTL. */
  const FAILURE_BACKOFF_MS = 30_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /** @type {?{at: number, sources: Array<object>, fires: Array<object>, coverage?: string}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, sources: Array<object>, fires: Array<object>, coverage: string}>} single-flight refresh */
  let inflight = null;
  /**
   * Failure backoff: keyless mode lets any client trigger upstream pulls, so a
   * failed refresh must not be retried on every request. Scoped to the
   * coverage that failed, so adding a key retries at once.
   */
  let failures = 0;
  let retryAt = 0;
  let retryCoverage = null;
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  /** Legacy disk entries have no `coverage`; they were worldwide pulls. */
  const entryCoverage = (entry) => entry?.coverage || 'world';

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.sources) &&
        Array.isArray(parsed?.fires)
      ) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[firms-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * Fetch + parse one FIRMS source. Throws on HTTP error or a non-CSV body
   * (FIRMS reports errors as HTML/plain text, never CSV). Without a key it
   * reads the public regional CSV instead of the area API. Never log the URL —
   * keyed URLs embed the MAP_KEY.
   */
  async function fetchSource(key, source) {
    const url = key
      ? `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`
      : `${REGIONAL_BASE}/${REGIONAL_FILES[source]}`;
    const signal = AbortSignal.timeout(60_000);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(
      await readResponseTextCapped(
        res,
        key ? FIRMS_MAX_RESPONSE_BYTES : REGIONAL_MAX_RESPONSE_BYTES,
        signal,
      ),
    );
    if (records === null) throw new Error('non-CSV upstream response');
    if (!key) {
      // The regional files have no `instrument` column; the client derives
      // the sensor from it.
      const instrument = source === 'MODIS_NRT' ? 'MODIS' : 'VIIRS';
      for (const record of records) {
        if (!record.instrument) record.instrument = instrument;
      }
    }
    return records;
  }

  /**
   * Refresh all sources sequentially (quota courtesy — never in parallel).
   * Partial success (≥1 source ok) still produces a cacheable entry with the
   * failed sources marked ok:false; total failure throws so the caller can
   * serve stale.
   */
  async function refreshUpstream(key) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of SOURCES) {
      try {
        const records = filterTrailing24h(await fetchSource(key, source), now);
        // NOT fires.push(...records): spread passes each record as an argument,
        // and a world/2 VIIRS pull exceeds V8's argument limit (~125k) at
        // ~131k records — RangeError, and the whole source is silently dropped.
        for (const record of records) fires.push(record);
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[firms-proxy] ${source} fetch failed:`,
          err?.message || err,
        );
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    return { at: now, sources, fires };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale) {
    const fires = filterTrailing24h(entry.fires, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      sources: entry.sources,
      count: fires.length,
      fires,
      coverage: entryCoverage(entry),
    };
  }

  /** mapkey_status transactions, cached 5 min, best-effort (null on failure). */
  function getTransactions(key) {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(statusCache.transactions);
    }
    if (!statusInflight) {
      statusInflight = (async () => {
        try {
          const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit)
            ? { used, limit }
            : null;
        } catch (err) {
          console.warn(
            '[firms-proxy] mapkey status failed:',
            err?.message || err,
          );
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => {
          statusInflight = null;
        });
    }
    return statusInflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/firms', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const key = mapKey();
        const coverage = key ? 'world' : REGIONAL_COVERAGE;
        await readDiskOnce();
        // A cache from the other coverage is treated as missing.
        const entry = mem && entryCoverage(mem) === coverage ? mem : null;

        if (subPath === '/status') {
          const transactions = key ? await getTransactions(key) : null;
          sendJson(200, {
            hasKey: Boolean(key),
            lastFetch: entry ? entry.at : null,
            count: entry ? entry.fires.length : null,
            stale: entry ? Date.now() - entry.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            transactions,
            coverage,
          });
          return;
        }

        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(entry, false));
          return;
        }
        // Stale or missing → refresh, single-flight (concurrent requests
        // share one upstream pass). Capture the promise locally BEFORE
        // awaiting: the .finally() nulls `inflight` the moment it settles.
        if (!inflight && retryCoverage === coverage && Date.now() < retryAt) {
          // Backing off after a failed refresh: serve what we have.
          if (entry) sendJson(200, buildPayload(entry, true));
          else sendJson(502, { error: 'firms fetch failed; retrying later' });
          return;
        }
        if (!inflight) {
          inflight = refreshUpstream(key)
            .then(async (fresh) => {
              const tagged = { ...fresh, coverage };
              failures = 0;
              retryAt = 0;
              retryCoverage = null;
              mem = tagged;
              await writeDisk(tagged);
              return tagged;
            })
            .catch((err) => {
              if (retryCoverage !== coverage) failures = 0;
              retryCoverage = coverage;
              failures += 1;
              retryAt =
                Date.now() +
                Math.min(TTL_MS, FAILURE_BACKOFF_MS * 2 ** (failures - 1));
              console.warn(
                `[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const pending = inflight;
        const result = await pending;
        // Key flipped mid-flight: a result of the other coverage is not ours.
        const fresh =
          result && entryCoverage(result) === coverage ? result : null;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'firms fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[firms-proxy] error:', err?.message || err);
        sendJson(500, { error: 'firms proxy error' });
      }
    });
  };
  return {
    name: 'firms-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
