import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { volcanoRowsFromPayload } from './magma.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Same-origin proxy of PVMBG's MAGMA pages, which send no CORS header. */
const VOLCANO_URL = '/api/volcanoes/indonesia';
/** The proxy returns ~70 level rows and up to 50 notices, a few tens of KB. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Request and validate a MAGMA volcano snapshot from the same-origin proxy. The
 * proxy owns upstream caching, so this source is stateless.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {string} [options.endpoint] - Proxy route, overridable for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for the request.
 * @returns {{getSnapshot: Function}}
 */
export function createMagmaVolcanoSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = VOLCANO_URL,
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(msg('Volcano request timed out'))),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(endpoint, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Volcano HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          controller.signal,
        );
        const snapshot = volcanoRowsFromPayload(payload, now());
        if (!snapshot) throw new Error(msg('Malformed volcano response'));
        return snapshot;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
