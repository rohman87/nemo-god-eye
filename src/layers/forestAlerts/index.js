/**
 * Forest loss alerts: Global Forest Watch integrated deforestation alerts and
 * peatland extent as Cesium imagery, limited to Indonesia. The layer fetches
 * no data of its own; Cesium requests the tiles and each one is recoloured in
 * `imagery.js`. Alerts sit above peat, both on the imagery host (the globe, or
 * the 3D Tiles imagery collection), so vector layers always draw over them.
 */
import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { createForestAlertsImagery } from './imagery.js';
import {
  CONFIDENCE_COLORS,
  DEFAULT_WINDOW_DAYS,
  FOREST_ALERTS_LAYER_ID,
  PEAT_COLOR,
  WINDOW_DAYS,
  normalizeWindow,
} from './model.js';

/**
 * @param {{ overlayHost?: object, createCanvas?: () => object, now?: () => number,
 *   cesium?: object, createImagery?: Function, eventTarget?: object }} [options]
 *   `overlayHost` is accepted for a uniform factory signature; the layer has no labels.
 */
export function createForestAlertsLayer({
  createCanvas = () => document.createElement('canvas'),
  now = Date.now,
  cesium = Cesium,
  createImagery = createForestAlertsImagery,
  eventTarget = globalThis.window,
} = {}) {
  let viewer = null;
  let imagery = null;
  let imageryHost = null;
  let enabled = false;
  let lastUpdate = null;
  let removeCamera = null;
  let listening = false;
  let rowControlsListener = null;
  let alerts = true;
  let peat = true;
  let windowDays = DEFAULT_WINDOW_DAYS;
  const notify = () => rowControlsListener?.();
  const getHost = () =>
    imageryHost?.() ?? {
      collection: viewer?.imageryLayers ?? viewer?.scene?.imageryLayers,
      kind: 'globe',
    };
  const rehome = () => imagery?.rehome();
  const apply = () => {
    imagery?.setOptions({ alerts, peat, windowDays });
    notify();
  };
  const currentError = () =>
    (enabled ? imagery?.getStatus().error : null) ?? null;

  const layer = {
    id: FOREST_ALERTS_LAYER_ID,
    name: 'Forest loss alerts',
    icon: '♣',
    source: 'Global Forest Watch',
    updateInterval: 21_600_000,

    init(nextViewer) {
      viewer = nextViewer;
      imagery = createImagery({
        cesium,
        getHost,
        createCanvas,
        now,
        onChange: notify,
      });
      imagery.setOptions({ alerts, peat, windowDays });
    },

    /** The shell supplies the imagery host so a 3D Tiles map can own the imagery. */
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      rehome();
    },

    enable() {
      enabled = true;
      lastUpdate = now();
      imagery?.setEnabled(true);
      if (!listening) {
        listening = true;
        removeCamera = viewer?.camera?.moveEnd?.addEventListener(rehome);
        eventTarget?.addEventListener?.('gev:map-stack-changed', rehome);
      }
      notify();
    },

    disable() {
      enabled = false;
      listening = false;
      removeCamera?.();
      removeCamera = null;
      eventTarget?.removeEventListener?.('gev:map-stack-changed', rehome);
      imagery?.setEnabled(false);
      notify();
    },

    /** Re-create the alert imagery so 'latest' tiles refresh; nothing is fetched here. */
    async update() {
      if (!enabled) return false;
      imagery?.refresh();
      lastUpdate = now();
      notify();
      return true;
    },

    _render() {
      viewer?.scene?.requestRender?.();
    },

    destroy() {
      layer.disable();
      imagery?.clear();
      imagery = null;
      imageryHost = null;
      viewer = null;
      rowControlsListener = null;
    },

    getRowControls() {
      const error = currentError();
      const chip = (id, label, active, onClick) => ({
        id,
        label,
        active,
        disabled: false,
        onClick,
      });
      const legend = [
        ...(alerts
          ? [
              {
                color: CONFIDENCE_COLORS.lower,
                label: t('Lower confidence'),
                blurb: t('Single sensor detection'),
              },
              {
                color: CONFIDENCE_COLORS.high,
                label: t('High confidence'),
                blurb: t('Confirmed by two sources'),
              },
              {
                color: CONFIDENCE_COLORS.highest,
                label: t('Highest confidence'),
                blurb: t('Strongest evidence'),
              },
            ]
          : []),
        ...(peat
          ? [
              {
                color: PEAT_COLOR,
                label: t('Peatland'),
                blurb: t('Mapped peat soil extent'),
              },
            ]
          : []),
      ];
      return {
        chips: [
          chip('alerts', t('Alerts'), alerts, () => {
            alerts = !alerts;
            apply();
          }),
          chip('peat', t('Peat'), peat, () => {
            peat = !peat;
            apply();
          }),
          ...WINDOW_DAYS.map((days) =>
            chip(
              `window-${days}`,
              t('{days} d', { days }),
              windowDays === days,
              () => {
                windowDays = normalizeWindow(days);
                apply();
              },
            ),
          ),
        ],
        legend,
        info: `${t(
          'Global Forest Watch integrated alerts: satellite detections of possible forest loss in the last {days} days. Fainter pixels are older.',
          { days: windowDays },
        )}${error ? `\n${t(error)}` : ''}`,
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** Raster imagery has no records to query. */
    getAnalystRecords() {
      return [];
    },

    getStats() {
      return {
        count: 0,
        lastUpdate,
        error: currentError(),
        stale: false,
      };
    },
  };
  return layer;
}
