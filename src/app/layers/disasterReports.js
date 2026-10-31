import { createDisasterReportsLayer } from '../../layers/disasterReports/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire crowd-sourced disaster reports to the application overlay host. */
export function createApplicationDisasterReports(options) {
  return createDisasterReportsLayer({ overlayHost, ...options });
}
