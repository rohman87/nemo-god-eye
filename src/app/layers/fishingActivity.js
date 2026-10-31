import { createFishingActivityLayer } from '../../layers/fishingActivity/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire fishing activity to the application overlay host. */
export function createApplicationFishingActivity(options) {
  return createFishingActivityLayer({ overlayHost, ...options });
}
