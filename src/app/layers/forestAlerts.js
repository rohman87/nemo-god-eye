import { createForestAlertsLayer } from '../../layers/forestAlerts/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire forest loss alert imagery to the application overlay host. */
export function createApplicationForestAlerts(options) {
  return createForestAlertsLayer({ overlayHost, ...options });
}
