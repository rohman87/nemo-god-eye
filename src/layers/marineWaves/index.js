import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  DEFAULT_VESSEL_ID,
  MARINE_STRAITS,
  MARINE_UNKNOWN_COLOR,
  MARINE_WAVES_OVERLAY_COHORT_LIMIT,
  MARINE_WAVES_OVERLAY_COLLISION_CAPACITY,
  MARINE_WAVES_OVERLAY_SOURCE_ID,
  VESSEL_LIMITS,
  WAVE_BANDS,
  arrowSizePx,
  compassPoint,
  createMarineOverlayEntry,
  exceedsLimit,
  formatHeight,
  mapAnalystRecord,
  marineLabelTitle,
  marineRowsAreStale,
  newestValidMs,
  sortRowsByHeight,
  travelBearing,
  vesselById,
} from './model.js';
export * from './model.js';
export { createOpenMeteoMarineSource } from './source.js';

const LAYER_ID = 'marine-waves';
const HALO_COLOR = '#0b0f14';
/** Arrow sprite is drawn in 5/6 of its canvas so the pick box is padded. */
const SPRITE_PAD = 6 / 5;
const RING_PX = 44;

const sprites = new Map();

/**
 * One white-on-transparent canvas per shape, tinted by `billboard.color`.
 * Lazy and DOM-guarded so importing this module never needs a document.
 */
function sprite(shape) {
  if (sprites.has(shape)) return sprites.get(shape);
  if (typeof document === 'undefined') return undefined;
  const size = shape === 'ring' ? RING_PX : 60;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.fillStyle = '#ffffff';
  context.strokeStyle = shape === 'ring' ? '#ffffff' : HALO_COLOR;
  context.lineJoin = 'round';
  if (shape === 'arrow') {
    context.lineWidth = 2.5;
    context.beginPath();
    context.moveTo(30, 5);
    context.lineTo(51, 53);
    context.lineTo(30, 43);
    context.lineTo(9, 53);
    context.closePath();
    context.fill();
    context.stroke();
  } else if (shape === 'dot') {
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(30, 30, 19, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  } else {
    context.lineWidth = 2;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
    context.stroke();
  }
  sprites.set(shape, canvas);
  return canvas;
}

/** Own the strait-wave display, its refresh lifecycle, and its readout card. */
export function createMarineWavesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Marine waves requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('Marine waves requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _rows = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _vesselId = DEFAULT_VESSEL_ID;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const addBillboard = (id, position, billboard, properties) =>
    _dataSource.entities.add(
      new Cesium.Entity({
        id,
        position,
        billboard: {
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          ...billboard,
        },
        properties,
      }),
    );

  const layer = {
    id: LAYER_ID,
    name: 'Strait waves',
    icon: '≈',
    source: 'Open-Meteo Marine',
    updateInterval: 1_800_000,

    init(viewer) {
      if (_viewer) throw new Error('Marine waves layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _rows = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(MARINE_WAVES_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(MARINE_WAVES_OVERLAY_SOURCE_ID, true);
      // Labels were cleared on disable; bring back the rows still held.
      if (_rows.length) layer._render();
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(MARINE_WAVES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(MARINE_WAVES_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        // A superseded or aborted request must not touch the scene, and neither
        // must one that lands after the layer was switched off.
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _rows = rows;
        _count = _rows.length;
        _lastUpdate = Date.now();
        this._render();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Marine waves request failed');
        console.warn('[Data:MarineWaves] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Rebuild entities and overlay labels from the current rows. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const vessel = vesselById(_vesselId);
      const overlayEntries = [];
      const seen = new Set();
      for (const row of _rows) {
        seen.add(row.id);
        const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
        const band = WAVE_BANDS.find((entry) => entry.id === row.band);
        const color = Cesium.Color.fromCssColorString(band.color);
        const sizePx = arrowSizePx(band);
        const bearing = travelBearing(row.directionFromDeg);
        const above = exceedsLimit(row.heightM, vessel);
        if (above) {
          // Behind the arrow: added first, and the larger sprite.
          addBillboard(
            `${LAYER_ID}:${row.id}:ring`,
            position,
            {
              image: sprite('ring'),
              width: RING_PX,
              height: RING_PX,
              color: Cesium.Color.WHITE,
            },
            { strait: row.name, note: 'Above the selected vessel limit' },
          );
        }
        addBillboard(
          `${LAYER_ID}:${row.id}`,
          position,
          {
            // Without a direction there is no heading to show: a plain dot.
            image: sprite(bearing === null ? 'dot' : 'arrow'),
            width: Math.round(sizePx * SPRITE_PAD),
            height: Math.round(sizePx * SPRITE_PAD),
            color: color.withAlpha(0.95),
            // Cesium rotates counter-clockwise about the aligned axis; the
            // bearing is clockwise from north. UNIT_Z keeps "up" on screen
            // pointing at the north pole.
            rotation: bearing === null ? 0 : -Cesium.Math.toRadians(bearing),
            alignedAxis: Cesium.Cartesian3.UNIT_Z,
          },
          {
            strait: row.name,
            route: row.route,
            waveHeightM: row.heightM,
            band: band.label,
            directionFromDeg: row.directionFromDeg,
            compassFrom: compassPoint(row.directionFromDeg),
            periodS: row.periodS,
            maxNext24hM: row.maxNext24hM,
            validTimeMs: row.validMs,
            aboveVesselLimit: above,
            lat: row.lat,
            lon: row.lon,
          },
        );
        overlayEntries.push(
          createMarineOverlayEntry({
            id: row.id,
            position,
            title: marineLabelTitle(row),
            accent: band.color,
            band: band.id,
            heightM: row.heightM,
          }),
        );
      }
      // After a completed refresh a strait without data stays on the map, grey.
      if (_lastUpdate !== null) {
        for (const strait of MARINE_STRAITS) {
          if (seen.has(strait.id)) continue;
          addBillboard(
            `${LAYER_ID}:${strait.id}`,
            Cesium.Cartesian3.fromDegrees(strait.lon, strait.lat),
            {
              image: sprite('dot'),
              width: Math.round(20 * SPRITE_PAD),
              height: Math.round(20 * SPRITE_PAD),
              color:
                Cesium.Color.fromCssColorString(MARINE_UNKNOWN_COLOR).withAlpha(
                  0.6,
                ),
            },
            { strait: strait.name, route: strait.route, note: 'No data' },
          );
        }
      }
      if (_enabled) {
        overlayHost.setEntries(MARINE_WAVES_OVERLAY_SOURCE_ID, overlayEntries, {
          cohortLimit: MARINE_WAVES_OVERLAY_COHORT_LIMIT,
          collisionCapacity: MARINE_WAVES_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        });
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(MARINE_WAVES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(MARINE_WAVES_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _rows = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _vesselId = DEFAULT_VESSEL_ID;
      rowControlsListener = null;
    },

    /**
     * Readout descriptor for the Weather panel: the band legend, the vessel
     * limit chips, and every strait tallest first.
     */
    getRowControls() {
      const vessel = vesselById(_vesselId);
      const vesselName = t(vessel.label).toLowerCase();
      const limitText = { vessel: vesselName, limit: vessel.limitM };
      const above = _rows.filter((row) => exceedsLimit(row.heightM, vessel));
      const newest = newestValidMs(_rows);
      const sorted = sortRowsByHeight(_rows);
      const missing = MARINE_STRAITS.filter(
        (strait) => !_rows.some((row) => row.id === strait.id),
      );
      // Readings and errors stay English data (analyst records, stats); the
      // card translates them as the Layers panel row does.
      const items = sorted.map((row, index) => {
        const isAbove = exceedsLimit(row.heightM, vessel);
        return {
          id: row.id,
          ordinal: index + 1,
          lead: formatHeight(row.heightM),
          text: [
            row.name,
            row.route,
            t('max {height} next 24 h', {
              height: formatHeight(row.maxNext24hM),
            }),
            ...(isAbove ? [t('Above {vessel} limit', limitText)] : []),
          ].join(' · '),
          accent: WAVE_BANDS.find((band) => band.id === row.band).color,
        };
      });
      if (_lastUpdate !== null) {
        for (const strait of missing) {
          items.push({
            id: strait.id,
            ordinal: items.length + 1,
            lead: '—',
            text: `${strait.name} · ${t('No data')}`,
            accent: MARINE_UNKNOWN_COLOR,
          });
        }
      }
      return {
        readout: true,
        summary: {
          label: t('Strait waves'),
          coverage: t('Indonesia'),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: 'Open-Meteo Marine · BMKG wave categories',
          status: _lastError
            ? translateFeedError(_lastError)
            : _count === 0
              ? t('No wave data available')
              : above.length === 0
                ? t('All straits below {vessel} limit ({limit} m)', limitText)
                : t('{n} of {total} straits above {vessel} limit ({limit} m)', {
                    ...limitText,
                    n: above.length,
                    total: MARINE_STRAITS.length,
                  }),
          units: 'm',
          settings: [
            {
              id: 'vessel',
              label: t('VESSEL'),
              chips: VESSEL_LIMITS.map((entry) => ({
                id: `vessel-${entry.id}`,
                label: t(entry.label),
                active: entry.id === vessel.id,
                title: `${entry.limitM} m`,
                onClick: () => {
                  if (_vesselId === entry.id) return;
                  _vesselId = entry.id;
                  this._render();
                  notify();
                },
              })),
            },
          ],
        },
        legend: WAVE_BANDS.map((band) => ({
          color: band.color,
          label: `${t(band.label)} ${band.range}`,
          blurb: band.risk ? `${band.local} · ${t(band.risk)}` : band.local,
        })),
        legendCategorical: true,
        list: {
          ariaLabel: t('Strait wave heights, tallest first'),
          items,
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot rows as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_rows.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return sortRowsByHeight(_rows).slice(0, limit).map(mapAnalystRecord);
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        observedAt: newestValidMs(_rows),
        // Only a completed refresh can be stale; before one there is no feed.
        stale: _lastUpdate !== null && marineRowsAreStale(_rows),
      };
    },
  };
  return layer;
}
