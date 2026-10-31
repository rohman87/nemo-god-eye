import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { fishingSnapshot } from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** Same-origin proxy of Global Fishing Watch, which needs a server-side token. */
const FISHING_URL = '/api/fishing/indonesia';
/** Up to 500 + 500 slim events, a few hundred KB at most. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** An error body is a few bytes. */
const MAX_ERROR_BYTES = 4 * 1024;

export const GFW_TOKEN_REJECTED_MESSAGE = msg(
  'Global Fishing Watch rejected the API token',
);

/**
 * Request and validate a Global Fishing Watch snapshot from the same-origin
 * proxy. The proxy owns upstream caching, so this source is stateless.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {string} [options.endpoint] - Proxy route.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for the request.
 * @returns {{getSnapshot: Function}}
 */
export function createGfwFishingSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = FISHING_URL,
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(msg('Fishing request timed out'))),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(endpoint, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          let code = null;
          if (response.status === 502) {
            try {
              code = (
                await readResponseJsonCapped(
                  response,
                  MAX_ERROR_BYTES,
                  controller.signal,
                )
              )?.error;
            } catch {
              code = null;
            }
          }
          if (code === 'gfw_token_rejected')
            throw new Error(GFW_TOKEN_REJECTED_MESSAGE);
          throw new Error(`Fishing HTTP ${response.status}`);
        }
        const payload = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          controller.signal,
        );
        const snapshot = fishingSnapshot(payload, now());
        if (!snapshot) throw new Error(msg('Malformed fishing response'));
        return snapshot;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
