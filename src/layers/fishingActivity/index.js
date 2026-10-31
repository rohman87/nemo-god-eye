import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  EEZ_COLOR,
  FISHING_COLOR,
  FISHING_OVERLAY_COHORT_LIMIT,
  FISHING_OVERLAY_COLLISION_CAPACITY,
  FISHING_OVERLAY_SOURCE_ID,
  GAP_COLOR,
  GAP_HIGHLIGHT_COUNT,
  OUTLINE_COLOR,
  compareFishing,
  compareGaps,
  createFishingOverlayEntry,
  eezLineStyle,
  longestGaps,
  mapAnalystRecord,
  snapshotIsStale,
  wholeHours,
} from './model.js';
import { INDONESIA_EEZ_LINES } from './eezBoundary.js';
import { GFW_TOKEN_REJECTED_MESSAGE } from './source.js';
export * from './model.js';
export { createGfwFishingSource } from './source.js';
export { INDONESIA_EEZ_LINES } from './eezBoundary.js';

const LAYER_ID = 'fishing-activity';
const FISHING_SIZE_PX = 9;
const GAP_SIZE_PX = 12;
/** Canvases are drawn at twice the display size so edges stay crisp. */
const SPRITE_SCALE = 2;

/** One white-on-transparent canvas per shape, tinted by `Billboard.color`. */
const spriteCache = new Map();
function diamondSprite(hollow) {
  const key = hollow ? 'hollow' : 'filled';
  if (spriteCache.has(key)) return spriteCache.get(key);
  let url;
  try {
    const px = (hollow ? GAP_SIZE_PX : FISHING_SIZE_PX) * SPRITE_SCALE;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext('2d');
    const mid = px / 2;
    // Inset so the widest stroke stays inside the canvas.
    const reach = mid - (hollow ? 2 * SPRITE_SCALE : SPRITE_SCALE);
    ctx.beginPath();
    ctx.moveTo(mid, mid - reach);
    ctx.lineTo(mid + reach, mid);
    ctx.lineTo(mid, mid + reach);
    ctx.lineTo(mid - reach, mid);
    ctx.closePath();
    ctx.lineJoin = 'miter';
    if (hollow) {
      // Hollow = signal absent: faint fill, 2 px light stroke, 1 px dark edge.
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
      ctx.lineWidth = 4 * SPRITE_SCALE;
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.stroke();
      ctx.lineWidth = 2 * SPRITE_SCALE;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = SPRITE_SCALE;
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.stroke();
    }
    url = canvas.toDataURL();
  } catch {
    url = undefined;
  }
  spriteCache.set(key, url);
  return url;
}

/** Own one fishing-activity display, its refresh lifecycle, and its row. */
export function createFishingActivityLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fishing activity requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('Fishing activity requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _eezEntities = [];
  let _eventEntities = [];
  let _fishing = [];
  let _gaps = [];
  /** null until a snapshot arrives: unknown is not "not configured". */
  let _configured = null;
  let _fetchedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _show = { eez: true, fishing: true, gaps: true };
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const eezColor = (alpha) =>
    Cesium.Color.fromCssColorString(EEZ_COLOR).withAlpha(alpha);

  /** The boundary is static data: drawn once per enable, before any fetch. */
  const ensureEez = () => {
    if (!_dataSource || _eezEntities.length) return;
    _dataSource.entities.suspendEvents();
    try {
      INDONESIA_EEZ_LINES.forEach((line, index) => {
        const style = eezLineStyle(line.kind);
        const color = eezColor(style.alpha);
        _eezEntities.push(
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `${LAYER_ID}:eez:${index}`,
              name: msg('EEZ boundary'),
              show: _show.eez,
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray([
                  ...line.coordinates,
                ]),
                width: style.width,
                clampToGround: true,
                material: style.dashed
                  ? new Cesium.PolylineDashMaterialProperty({
                      color,
                      dashLength: 12,
                    })
                  : new Cesium.ColorMaterialProperty(color),
              },
              properties: {
                type: msg('EEZ boundary'),
                boundary: line.kind,
              },
            }),
          ),
        );
      });
    } finally {
      _dataSource.entities.resumeEvents();
    }
  };

  const shownGaps = () => (_show.gaps ? _gaps : []);
  const shownFishing = () => (_show.fishing ? _fishing : []);

  const addEvent = (item, gap) => {
    const color = gap ? GAP_COLOR : FISHING_COLOR;
    const entity = _dataSource.entities.add(
      new Cesium.Entity({
        id: `${LAYER_ID}:${gap ? 'gap' : 'fishing'}:${item.id}`,
        name: item.vesselName || msg('Unknown vessel'),
        position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat),
        billboard: {
          image: diamondSprite(gap),
          width: gap ? GAP_SIZE_PX : FISHING_SIZE_PX,
          height: gap ? GAP_SIZE_PX : FISHING_SIZE_PX,
          color: Cesium.Color.fromCssColorString(color).withAlpha(
            gap ? 1 : 0.9,
          ),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          // Ground-clamped marks would sink into terrain; the horizon cull
          // hides the far side instead.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // Shrink the small marks at high altitude so they do not smother
          // the map.
          scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1, 1.2e7, 0.55),
        },
        properties: {
          type: gap ? msg('AIS gap') : msg('Fishing event'),
          vessel: item.vesselName,
          flag: item.flag,
          durationH: item.durationH,
          startMs: item.startMs,
          endMs: item.endMs,
          ...(gap ? { intentional: item.intentional } : {}),
          lat: item.lat,
          lon: item.lon,
        },
      }),
    );
    _eventEntities.push(entity);
  };

  const layer = {
    id: LAYER_ID,
    name: 'Fishing activity',
    icon: '◆',
    source: 'Global Fishing Watch · Marine Regions',
    updateInterval: 3_600_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Fishing activity layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _eezEntities = [];
      _eventEntities = [];
      _fishing = [];
      _gaps = [];
      _configured = null;
      _fetchedAt = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _show = { eez: true, fishing: true, gaps: true };
      overlayHost.setVisible(FISHING_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      ensureEez();
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(FISHING_OVERLAY_SOURCE_ID, true);
      this._render();
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(FISHING_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FISHING_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        // A superseded or aborted request must not touch the scene, and neither
        // must one that lands after the layer was switched off.
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _configured = snapshot.configured;
        _fishing = snapshot.fishing;
        _gaps = snapshot.gaps;
        _fetchedAt = snapshot.fetchedAt;
        _lastUpdate = Date.now();
        _lastError = null;
        this._render();
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Fishing request failed');
        console.warn('[Data:Fishing] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Rebuild event marks, EEZ visibility and gap labels from current state. */
    _render() {
      if (!_dataSource) return;
      ensureEez();
      for (const entity of _eezEntities) entity.show = _show.eez;
      _dataSource.entities.suspendEvents();
      for (const entity of _eventEntities) _dataSource.entities.remove(entity);
      _eventEntities = [];
      for (const item of shownFishing()) addEvent(item, false);
      for (const item of shownGaps()) addEvent(item, true);
      _dataSource.entities.resumeEvents();
      if (!_enabled) return;
      const entries = longestGaps(shownGaps(), GAP_HIGHLIGHT_COUNT).map((gap) =>
        createFishingOverlayEntry({
          id: `gap:${gap.id}`,
          position: Cesium.Cartesian3.fromDegrees(gap.lon, gap.lat),
          title: t('AIS gap {hours} h', { hours: wholeHours(gap.durationH) }),
          durationH: gap.durationH,
        }),
      );
      overlayHost.setEntries(FISHING_OVERLAY_SOURCE_ID, entries, {
        cohortLimit: FISHING_OVERLAY_COHORT_LIMIT,
        collisionCapacity: FISHING_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      });
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(FISHING_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FISHING_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _eezEntities = [];
      _eventEntities = [];
      _fishing = [];
      _gaps = [];
      _configured = null;
      _fetchedAt = null;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    getRowControls() {
      const unconfigured = _configured === false;
      const toggle = (id, label, key, disabled = false) => ({
        id,
        label,
        active: _show[key],
        disabled,
        onClick: () => {
          _show[key] = !_show[key];
          layer._render();
          notify();
        },
      });
      const hasEvents = _fishing.length + _gaps.length > 0;
      let info = '';
      if (_lastError)
        info =
          _lastError === GFW_TOKEN_REJECTED_MESSAGE
            ? t('Global Fishing Watch rejected the token.')
            : t(
                'Global Fishing Watch is unavailable. EEZ lines are still shown.',
              );
      else if (unconfigured)
        info = t(
          'Add a Global Fishing Watch API token to show fishing and AIS-gap events. EEZ lines are always shown.',
        );
      else if (_configured)
        info = [
          hasEvents ? '' : t('No fishing or AIS-gap events in this window.'),
          t('Events lag 3–5 days. Non-commercial use only.'),
        ]
          .filter(Boolean)
          .join(' ');
      const withCount = (count) => (_configured ? { count } : {});
      const top = longestGaps(shownGaps(), GAP_HIGHLIGHT_COUNT);
      return {
        chips: [
          toggle('eez', t('EEZ'), 'eez'),
          toggle('fishing', t('Fishing'), 'fishing', unconfigured),
          toggle('gaps', t('AIS gaps'), 'gaps', unconfigured),
        ],
        legend: [
          {
            color: EEZ_COLOR,
            label: t('EEZ 200 NM'),
            blurb: t('Outer limit of the exclusive economic zone'),
          },
          {
            color: EEZ_COLOR,
            label: t('Median or treaty line'),
            blurb: t('Dashed. Boundary with a neighbour'),
          },
          {
            color: FISHING_COLOR,
            label: t('Fishing event'),
            blurb: t('Vessel fishing behaviour detected'),
            ...withCount(_fishing.length),
          },
          {
            color: GAP_COLOR,
            label: t('AIS gap'),
            blurb: t('Transponder off 6 h or longer'),
            ...withCount(_gaps.length),
          },
        ],
        info,
        list: {
          ariaLabel: t('Longest AIS gaps'),
          items: top.map((gap, index) => ({
            id: `${LAYER_ID}:gap:${gap.id}`,
            ordinal: index + 1,
            lead: t('{hours} h', { hours: wholeHours(gap.durationH) }),
            text: [gap.vesselName || t('Unknown vessel'), gap.flag]
              .filter(Boolean)
              .join(' · '),
            accent: GAP_COLOR,
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot shown events as JSON-safe records for the analyst query engine.
     * Gaps come first, longest first, then fishing events, newest first.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return [
        ...shownGaps()
          .slice()
          .sort(compareGaps)
          .map((gap) => mapAnalystRecord(gap, 'ais-gap')),
        ...shownFishing()
          .slice()
          .sort(compareFishing)
          .map((event) => mapAnalystRecord(event, 'fishing')),
      ].slice(0, limit);
    },

    getStats() {
      return {
        count: _fishing.length + _gaps.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Only a completed refresh can be stale; before one there is no feed.
        stale: _lastUpdate !== null && snapshotIsStale(_fetchedAt, Date.now()),
      };
    },
  };
  return layer;
}
