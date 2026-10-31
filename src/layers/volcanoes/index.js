import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  VOLCANO_LAYER_ID,
  VOLCANO_LEVELS,
  VOLCANO_OVERLAY_COHORT_LIMIT,
  VOLCANO_OVERLAY_COLLISION_CAPACITY,
  VOLCANO_OVERLAY_SOURCE_ID,
  VONA_COLORS,
  createVolcanoOverlayEntry,
  createVolcanoSprites,
  drawableVolcanoes,
  elevatedVolcanoes,
  knownLevel,
  mapAnalystRecord,
  selectVolcanoOverlayCohort,
  volcanoCounts,
  volcanoLabelTitle,
  volcanoPriority,
  volcanoView,
  volcanoesAreStale,
} from './model.js';
export * from './model.js';
export { createMagmaVolcanoSource } from './source.js';

/** Level I markers shrink at altitude; Level IV is never scaled. */
const QUIET_SCALE = new Cesium.NearFarScalar(150_000, 1, 6_000_000, 0.5);

/** "Level III Siaga" as shown in the list lead, legend and properties. */
const levelText = (level) =>
  t('Level {roman} {name}', { roman: level.roman, name: level.name });

/** Own the volcano alert-level display, its refresh lifecycle and row controls. */
export function createVolcanoesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Volcanoes require a snapshot source');
  if (!overlayHost) throw new TypeError('Volcanoes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _volcanoes = [];
  let _fetchedAt = null;
  let _noticesStale = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _showQuiet = true;
  let _showAviation = true;
  let rowControlsListener = null;
  const sprites = createVolcanoSprites();

  const notify = () => rowControlsListener?.();

  const resetData = () => {
    _volcanoes = [];
    _fetchedAt = null;
    _noticesStale = false;
    _count = 0;
    _lastUpdate = null;
    _lastError = null;
  };

  const toggle = (setter) => () => {
    setter();
    if (_enabled) layer._render();
    notify();
  };

  const layer = {
    id: VOLCANO_LAYER_ID,
    name: 'Volcanoes',
    icon: '▲',
    source: 'PVMBG MAGMA Indonesia',
    updateInterval: 1_800_000,

    init(viewer) {
      if (_viewer) throw new Error('Volcano layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(VOLCANO_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      resetData();
      _enabled = false;
      _showQuiet = true;
      _showAviation = true;
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, true);
      if (_volcanoes.length) this._render();
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(VOLCANO_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, false);
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
        _volcanoes = snapshot.volcanoes;
        _fetchedAt = Number.isFinite(snapshot.fetchedAt)
          ? snapshot.fetchedAt
          : null;
        _noticesStale = snapshot.noticesStale === true;
        _count = _volcanoes.filter((v) => knownLevel(v) !== null).length;
        if (snapshot.unplaced?.length)
          console.debug(
            '[Data:Volcanoes] Levels for volcanoes not in the catalog:',
            snapshot.unplaced.join(', '),
          );
        this._render();
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('MAGMA is unavailable.');
        console.warn('[Data:Volcanoes] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Rebuild markers, aviation rings and overlay labels from the snapshot. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const options = { showQuiet: _showQuiet, showAviation: _showAviation };
      const triangle = sprites.get('triangle');
      const awas = sprites.get('triangleAwas');
      const ring = sprites.get('ring');
      const overlayEntries = [];
      for (const volcano of drawableVolcanoes(_volcanoes, options)) {
        const view = volcanoView(volcano, options);
        const { level } = view;
        const position = Cesium.Cartesian3.fromDegrees(
          volcano.lon,
          volcano.lat,
        );
        const scaleByDistance = level.level === 1 ? QUIET_SCALE : undefined;
        const properties = {
          name: volcano.name,
          province: volcano.province,
          level: view.known ? levelText(level) : t('Level unknown'),
          elevationM: volcano.elevationM,
          lat: volcano.lat,
          lon: volcano.lon,
          ...(volcano.vona
            ? {
                vonaColor: volcano.vona.color,
                vonaIssuedMs: volcano.vona.issuedAt,
                vonaText: volcano.vona.text,
                vonaCode: volcano.vona.code,
              }
            : {}),
        };
        const billboard = (image, sizePx, color) => ({
          image,
          width: sizePx,
          height: sizePx,
          color,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance,
        });
        const isAwas = level.level === 4;
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `${VOLCANO_LAYER_ID}:${volcano.id}`,
            name: volcano.name,
            position,
            billboard: billboard(
              (isAwas ? awas : triangle) || undefined,
              level.sizePx,
              isAwas
                ? Cesium.Color.WHITE
                : Cesium.Color.fromCssColorString(level.color).withAlpha(
                    level.alpha,
                  ),
            ),
            properties,
          }),
        );
        if (view.vona) {
          // A separate entity so the ring tints independently; it carries the
          // same facts so picking it shows the same card.
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `${VOLCANO_LAYER_ID}:${volcano.id}:ring`,
              name: volcano.name,
              position,
              billboard: billboard(
                ring || undefined,
                view.ringSizePx,
                Cesium.Color.fromCssColorString(view.vona.hex),
              ),
              properties,
            }),
          );
        }
        const title = volcanoLabelTitle(volcano, options);
        if (title)
          overlayEntries.push(
            createVolcanoOverlayEntry({
              id: volcano.id,
              position,
              title,
              accent: level.color,
              priority: volcanoPriority(volcano, options),
            }),
          );
      }
      if (_enabled) {
        overlayHost.setEntries(
          VOLCANO_OVERLAY_SOURCE_ID,
          selectVolcanoOverlayCohort(overlayEntries),
          {
            cohortLimit: VOLCANO_OVERLAY_COHORT_LIMIT,
            collisionCapacity: VOLCANO_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(VOLCANO_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VOLCANO_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      sprites.clear();
      _viewer = null;
      resetData();
      rowControlsListener = null;
    },

    getRowControls() {
      const counts = volcanoCounts(_volcanoes);
      const elevated = elevatedVolcanoes(_volcanoes);
      const info = [
        t('PVMBG MAGMA alert levels. Aviation notices from VONA.'),
        _noticesStale ? t('Aviation notices may be out of date.') : '',
        _lastUpdate !== null && !_lastError && elevated.length === 0
          ? t('All monitored volcanoes are at Level I.')
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      return {
        chips: [
          {
            id: 'quiet',
            label: t('Quiet (Level I)'),
            active: _showQuiet,
            onClick: toggle(() => {
              _showQuiet = !_showQuiet;
            }),
          },
          {
            id: 'aviation',
            label: t('Aviation notices'),
            active: _showAviation,
            onClick: toggle(() => {
              _showAviation = !_showAviation;
            }),
          },
        ],
        legend: [
          ...VOLCANO_LEVELS.map((level) => ({
            color: level.color,
            label: levelText(level),
            count: counts.levels[level.level],
            blurb: t(level.blurb),
          })),
          ...VONA_COLORS.map((notice) => ({
            color: notice.hex,
            // i18n-ignore: VONA is the ICAO notice name, never translated
            label: `VONA ${notice.color}`,
            count: counts.vona[notice.color],
            blurb: t(notice.blurb),
          })),
        ],
        info,
        list: {
          ariaLabel: t('Elevated volcanoes'),
          items: elevated.map((volcano, index) => {
            const level = VOLCANO_LEVELS[knownLevel(volcano) - 1];
            return {
              id: volcano.id,
              ordinal: index + 1,
              lead: levelText(level),
              text: [
                volcano.name,
                volcano.province,
                volcano.vona ? `VONA ${volcano.vona.color}` : '',
              ]
                .filter(Boolean)
                .join(' · '),
              accent: level.color,
            };
          }),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot volcanoes as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_volcanoes.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _volcanoes
        .slice(0, limit)
        .map((volcano, index) => mapAnalystRecord(volcano, index));
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        // Only a completed refresh can be stale; before one there is no feed.
        stale: _lastUpdate !== null && volcanoesAreStale(_fetchedAt),
      };
    },
  };
  return layer;
}
