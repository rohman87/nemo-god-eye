import { createMarineWavesLayer } from '../../layers/marineWaves/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire strait wave readings to the application overlay host. */
export function createApplicationMarineWaves(options) {
  return createMarineWavesLayer({ overlayHost, ...options });
}
