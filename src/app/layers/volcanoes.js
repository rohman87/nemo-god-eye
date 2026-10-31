import { createVolcanoesLayer } from '../../layers/volcanoes/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire volcano alert levels to the application overlay host. */
export function createApplicationVolcanoes(options) {
  return createVolcanoesLayer({ overlayHost, ...options });
}
