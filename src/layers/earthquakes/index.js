import * as Cesium from 'cesium';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
  EARTHQUAKE_FELT_COLOR,
  EARTHQUAKE_FELT_OUTLINE_COLOR,
  EARTHQUAKE_FELT_REPORT_LIST_CHARS,
  EARTHQUAKE_TSUNAMI_RING_SCALE,
  capText,
  circleDegrees,
  depthBand,
  earthquakeLabelPriority,
  earthquakeRadiusM,
  relativeAge,
  selectEarthquakeList,
} from './model.js';
import { formatRelativeTime, msg, t } from '../../i18n/index.js';
export * from './model.js';
export {
  createBmkgEarthquakeSource,
  createCompositeEarthquakeSource,
  createUsgsEarthquakeSource,
} from './source.js';
export {
  BMKG_FEED_URLS,
  mergeBmkgRows,
  mergeEarthquakeProviders,
  normalizeBmkgEvents,
} from './bmkg.js';

// The error stays English data and the layer panel shows it translated.

/** Own one earthquake display and its refresh lifecycle. */
export function createEarthquakesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _rows = [];
  let _rowControlsListener = null;
  const notify = () => _rowControlsListener?.();

  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'BMKG · USGS',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Earthquake layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('earthquakes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _rows = [];
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Earthquakes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const {
          stableId,
          usgsId,
          bmkgId,
          provider,
          providers,
          tsunami,
          felt,
          feltReport,
          potential,
          lon,
          lat,
          depthKm,
          mag,
          place,
          time,
        } of rows) {
          count++;
          const baseRadius = earthquakeRadiusM(mag, felt);
          const color = depthColor(depthKm || 0);
          const isSignificant = mag >= 5.0;
          const fillAlpha = isSignificant ? 0.4 : 0.3;
          const outlineAlpha = isSignificant ? 1.0 : 0.8;

          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `earthquake:${stableId}`,
              position,
              ellipse: {
                // Static axes — see the module header. A CallbackProperty here
                // re-tessellates the clamped ground geometry every frame.
                semiMajorAxis: baseRadius,
                semiMinorAxis: baseRadius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(fillAlpha),
                ),
                outline: true,
                outlineColor: color.withAlpha(outlineAlpha),
                outlineWidth: tsunami || isSignificant ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              ...(felt
                ? {
                    point: {
                      pixelSize: 5,
                      color: Cesium.Color.fromCssColorString(
                        EARTHQUAKE_FELT_COLOR,
                      ),
                      outlineColor: Cesium.Color.fromCssColorString(
                        EARTHQUAKE_FELT_OUTLINE_COLOR,
                      ),
                      outlineWidth: 1,
                      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                      disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    },
                  }
                : {}),
              properties: {
                // Analyst seam (additive): the USGS event id (e.g. "us7000abcd").
                usgsId,
                bmkgId,
                provider,
                providers,
                tsunami,
                felt,
                feltReport,
                potential,
                mag,
                place,
                time,
                depth: depthKm,
              },
            }),
          );
          if (tsunami) {
            // Separate entity: removed with its parent on every re-render.
            nextEntities.push(
              new Cesium.Entity({
                id: `earthquake:${stableId}:tsunami`,
                polyline: {
                  positions: Cesium.Cartesian3.fromDegreesArray(
                    circleDegrees(
                      lon,
                      lat,
                      baseRadius * EARTHQUAKE_TSUNAMI_RING_SCALE,
                    ),
                  ),
                  width: 2,
                  clampToGround: true,
                  material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.WHITE.withAlpha(0.95),
                    dashLength: 16,
                  }),
                },
              }),
            );
          }
          overlayEntries.push(
            createEarthquakeOverlayEntry({
              id: String(stableId),
              position,
              magnitude: mag,
              accent: color.toCssColorString(),
              suffix: tsunami ? t('Tsunami potential') : felt ? t('Felt') : '',
              priority: earthquakeLabelPriority(mag, { tsunami, felt }),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            EARTHQUAKE_OVERLAY_SOURCE_ID,
            selectEarthquakeOverlayCohort(overlayEntries),
            {
              cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _rows = rows;
        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        console.log(`[Data:Earthquakes] Updated: ${_count} events (M2.5+)`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Earthquakes] Fetch error:', e);
        _lastError = e?.message || msg('Earthquake source unavailable');
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _rows = [];
      _rowControlsListener = null;
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        // Tsunami rings are decoration on an event, not records of their own.
        if (!entity.properties) continue;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: p?.usgsId?.getValue(now) ?? p?.bmkgId?.getValue(now) ?? null,
              mag: p?.mag?.getValue(now),
              place: p?.place?.getValue(now),
              time: p?.time?.getValue(now),
              depth: p?.depth?.getValue(now),
              provider: p?.provider?.getValue(now),
              tsunami: p?.tsunami?.getValue(now),
              felt: p?.felt?.getValue(now),
              potential: p?.potential?.getValue(now),
              feltReport: p?.feltReport?.getValue(now),
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getRowControls() {
      const bands = [
        {
          key: 'shallow',
          color: '#ff0000',
          label: t('Shallow'),
          blurb: t('Depth under 70 km'),
        },
        {
          key: 'intermediate',
          color: '#ffa500',
          label: t('Intermediate'),
          blurb: t('Depth 70 to 300 km'),
        },
        {
          key: 'deep',
          color: '#ffff00',
          label: t('Deep'),
          blurb: t('Depth over 300 km'),
        },
      ];
      const counts = { shallow: 0, intermediate: 0, deep: 0 };
      let tsunamiCount = 0;
      let feltCount = 0;
      for (const row of _rows) {
        counts[depthBand(row.depthKm)]++;
        if (row.tsunami) tsunamiCount++;
        if (row.felt) feltCount++;
      }
      const legend = [
        ...bands.map(({ key, color, label, blurb }) => ({
          color,
          label,
          count: counts[key],
          blurb,
        })),
        {
          color: '#ffffff',
          label: t('Tsunami potential'),
          count: tsunamiCount,
          blurb: t('Dashed ring. Flagged by BMKG'),
        },
        {
          color: EARTHQUAKE_FELT_COLOR,
          label: t('Felt report'),
          count: feltCount,
          blurb: t('Dot. Reported felt by people'),
        },
      ];
      const now = Date.now();
      const items = selectEarthquakeList(_rows).map((row, index) => {
        const age = relativeAge(row.time, now);
        const parts = [
          row.place || '',
          age ? formatRelativeTime(age.value, age.unit) : '',
          (row.providers || [row.provider]).filter(Boolean).join('+'),
        ].filter(Boolean);
        let text = parts.join(' \u00b7 ');
        if (row.tsunami) text += ` \u00b7 ${t('Tsunami potential')}`;
        if (row.feltReport)
          text += ` \u00b7 ${t('Felt: {report}', {
            report: capText(row.feltReport, EARTHQUAKE_FELT_REPORT_LIST_CHARS),
          })}`;
        return {
          id: `earthquake:${row.stableId}`,
          ordinal: index + 1,
          lead: `M${Number(row.mag).toFixed(1)}`,
          text,
          accent: depthColor(row.depthKm || 0).toCssColorString(),
        };
      });
      const controls = { chips: [], legend };
      if (source.getProviderStatus?.().bmkg === 'down')
        controls.info = t('BMKG unavailable. Showing USGS only.');
      if (items.length)
        controls.list = {
          ariaLabel: t('Newest Indonesian earthquakes'),
          items,
        };
      return controls;
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
