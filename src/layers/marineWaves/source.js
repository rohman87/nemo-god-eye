import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { MARINE_STRAITS, normalizeMarinePayload } from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel and the Weather card show them translated.
const msg = (text) => text;

const MARINE_ENDPOINT = 'https://marine-api.open-meteo.com/v1/marine';
/** Ten points with 48 hourly samples each is a few tens of KB. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Request and validate a complete Open-Meteo Marine snapshot: one GET for every
 * strait, answered with an array in request order.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for the request.
 * @param {string} [options.endpoint] - Marine API URL, for tests.
 * @returns {{getSnapshot: Function}}
 */
export function createOpenMeteoMarineSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
  endpoint = MARINE_ENDPOINT,
} = {}) {
  const url =
    `${endpoint}?latitude=${MARINE_STRAITS.map((s) => s.lat).join(',')}` +
    `&longitude=${MARINE_STRAITS.map((s) => s.lon).join(',')}` +
    '&current=wave_height,wave_direction,wave_period' +
    '&hourly=wave_height&forecast_days=2&timezone=GMT';
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(msg('Marine request timed out'))),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Marine HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          controller.signal,
        );
        const rows = normalizeMarinePayload(payload, MARINE_STRAITS, now());
        if (!rows) throw new Error(msg('Malformed marine response'));
        return rows;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
