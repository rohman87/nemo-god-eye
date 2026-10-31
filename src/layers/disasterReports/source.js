import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizePetaBencanaReports } from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Keyless and CORS-enabled. */
const DEFAULT_ENDPOINT = 'https://data.petabencana.id/reports';
/** Always the full seven days; the window chip filters on the client. The
 * upstream rejects a `format` parameter, so none is sent. */
const QUERY = 'timeperiod=604800&geoformat=geojson';
/** ~50 reports a week is tens of KB; this is a ceiling, not an expectation. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Request and validate a complete PetaBencana.id report snapshot.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for the request.
 * @param {string} [options.endpoint] - Reports endpoint, for tests.
 * @returns {{getSnapshot: Function}}
 */
export function createPetaBencanaSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
  endpoint = DEFAULT_ENDPOINT,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () =>
          controller.abort(
            new Error(msg('Disaster reports request timed out')),
          ),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(`${endpoint}?${QUERY}`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Disaster reports HTTP ${response.status}`);
        let payload;
        try {
          payload = await readResponseJsonCapped(
            response,
            MAX_RESPONSE_BYTES,
            controller.signal,
          );
        } catch (error) {
          // Unparseable JSON is a malformed response; an oversize body or an
          // abort keeps its own error.
          if (error instanceof SyntaxError)
            throw new Error(msg('Malformed disaster report response'));
          throw error;
        }
        const rows = normalizePetaBencanaReports(payload, now());
        if (!rows) throw new Error(msg('Malformed disaster report response'));
        return rows;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
