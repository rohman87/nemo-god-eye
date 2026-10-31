import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  DISASTER_REPORTS_OVERLAY_SOURCE_ID,
  DISASTER_REPORTS_OVERLAY_COHORT_LIMIT,
  DISASTER_REPORTS_OVERLAY_COLLISION_CAPACITY,
  DISASTER_TYPES,
  DISASTER_WINDOWS,
  DISASTER_DEFAULT_WINDOW_ID,
  countByType,
  createDisasterReportOverlayEntry,
  drawDisasterDot,
  disasterType,
  disasterWindow,
  filterByWindow,
  mapAnalystRecord,
  newestPerType,
  reportAlpha,
} from './model.js';
export * from './model.js';
export { createPetaBencanaSource } from './source.js';

/** Reports listed in the row. */
const spriteCache = new Map();

/** One cached browser canvas per type; created lazily on first use. */
function disasterDotSprite(typeId) {
  if (!spriteCache.has(typeId)) {
    const canvas = drawDisasterDot(typeId, () =>
      document.createElement('canvas'),
    );
    if (!canvas) return null;
    spriteCache.set(typeId, canvas);
  }
  return spriteCache.get(typeId);
}

const LIST_LIMIT = 8;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "<1m ago" / "12m ago" / "3h ago" / "2d ago" in the UI language. */
function ageText(createdMs, now) {
  const delta = now - createdMs;
  if (!Number.isFinite(delta) || delta < MINUTE_MS) return t('<1m ago');
  if (delta < 90 * MINUTE_MS)
    return t('{count}m ago', { count: Math.floor(delta / MINUTE_MS) });
  if (delta < 48 * HOUR_MS)
    return t('{count}h ago', { count: Math.round(delta / HOUR_MS) });
  return t('{count}d ago', { count: Math.round(delta / (24 * HOUR_MS)) });
}

/** Own the crowd-sourced disaster-report display and its refresh lifecycle. */
export function createDisasterReportsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Disaster reports require a snapshot source');
  if (!overlayHost)
    throw new TypeError('Disaster reports require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  /** Every validated report of the last good fetch (7 days). */
  let _rows = [];
  let _windowId = DISASTER_DEFAULT_WINDOW_ID;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();
  const windowRows = (now = Date.now()) =>
    filterByWindow(_rows, disasterWindow(_windowId).ms, now);

  const selectWindow = (id) => {
    if (id === _windowId) return;
    _windowId = disasterWindow(id).id;
    if (_enabled) layer._render();
    notify();
  };

  const layer = {
    id: 'disaster-reports',
    name: 'Disaster reports',
    icon: '⚑',
    source: 'PetaBencana.id',
    updateInterval: 600_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Disaster reports layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('disaster-reports');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _rows = [];
      _windowId = DISASTER_DEFAULT_WINDOW_ID;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(DISASTER_REPORTS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(DISASTER_REPORTS_OVERLAY_SOURCE_ID, true);
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
      overlayHost.clearSource(DISASTER_REPORTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(DISASTER_REPORTS_OVERLAY_SOURCE_ID, false);
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
        this._render();
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Disaster reports request failed');
        console.warn('[Data:DisasterReports] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Rebuild dots and the per-type labels from the rows in the window. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const now = Date.now();
      const rows = windowRows(now);
      for (const row of rows) {
        const type = disasterType(row.type);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `disaster-reports:${row.id}`,
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
            billboard: {
              image: disasterDotSprite(row.type),
              color: Cesium.Color.WHITE.withAlpha(
                reportAlpha(row.createdMs, now),
              ),
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: {
              type: type.label,
              createdMs: row.createdMs,
              city: row.city,
              regionCode: row.regionCode,
              source: row.source,
              title: row.title,
              text: row.text,
              url: row.url,
              floodDepthCm: row.floodDepthCm,
              lat: row.lat,
              lon: row.lon,
            },
          }),
        );
      }
      _count = rows.length;
      if (_enabled) {
        const entries = newestPerType(rows).map((row) => {
          const type = disasterType(row.type);
          const place = row.city ? ` · ${row.city}` : '';
          return createDisasterReportOverlayEntry({
            id: row.id,
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
            title: `${t(type.label)}${place} ${ageText(row.createdMs, now)}`,
            accent: type.color,
          });
        });
        overlayHost.setEntries(DISASTER_REPORTS_OVERLAY_SOURCE_ID, entries, {
          cohortLimit: DISASTER_REPORTS_OVERLAY_COHORT_LIMIT,
          collisionCapacity: DISASTER_REPORTS_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        });
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(DISASTER_REPORTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(DISASTER_REPORTS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _rows = [];
      _windowId = DISASTER_DEFAULT_WINDOW_ID;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    getRowControls() {
      const now = Date.now();
      const win = disasterWindow(_windowId);
      const rows = windowRows(now);
      const counts = countByType(rows);
      const status = _lastError
        ? t('PetaBencana is unavailable.')
        : _lastUpdate !== null && rows.length === 0
          ? t('No reports in the last {window}.', { window: t(win.label) })
          : '';
      return {
        chips: DISASTER_WINDOWS.map((option) => ({
          id: option.id,
          label: t(option.label),
          active: option.id === _windowId,
          disabled: false,
          onClick: () => selectWindow(option.id),
        })),
        legend: DISASTER_TYPES.filter((type) => counts[type.id] > 0).map(
          (type) => ({
            color: type.color,
            label: t(type.label),
            count: counts[type.id],
          }),
        ),
        info: [
          status,
          t('Crowd-sourced reports via PetaBencana.id; not verified.'),
        ]
          .filter(Boolean)
          .join('\n'),
        list: {
          ariaLabel: t('Newest disaster reports'),
          items: rows.slice(0, LIST_LIMIT).map((row, index) => {
            const type = disasterType(row.type);
            const where = [row.city, ageText(row.createdMs, now)]
              .filter(Boolean)
              .join(' · ');
            return {
              id: row.id,
              ordinal: index + 1,
              lead: t(type.label),
              text: row.title ? `${where} · ${row.title}` : where,
              accent: type.color,
            };
          }),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Reports in the current window as JSON-safe records for the analyst
     * query engine. [] while the layer is off.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_rows.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return windowRows()
        .slice(0, limit)
        .map((row, index) => mapAnalystRecord(row, index));
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Only a completed refresh can be stale: the last refresh failed, so
        // the reports on screen are from an earlier one.
        stale: _lastUpdate !== null && _lastError !== null,
      };
    },
  };
  return layer;
}
