import { msg } from '../../i18n/index.js';
import { NO_IMAGERY_HOST, imageryHostStatus } from '../weather/imageryHost.js';
import {
  ALERTS_TILE_URL,
  DEFAULT_WINDOW_DAYS,
  INDONESIA_BOUNDS,
  PEAT_TILE_URL,
  TILE_MAXIMUM_LEVEL,
  TILE_MINIMUM_LEVEL,
  dayIndexFor,
  normalizeWindow,
  recolorAlertPixels,
  recolorPeatPixels,
} from './model.js';

export const FOREST_TILES_UNAVAILABLE = msg(
  'Forest alert tiles are unavailable.',
);
export { NO_IMAGERY_HOST };

const TILE_SIZE = 256;
/** Consecutive failed tiles (not counting 404s) before the layer reports an error. */
export const FAILURE_LIMIT = 6;
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Redraw a decoded tile into a canvas and recolour its pixels. The canvas is
 * 2D, so it holds premultiplied RGBA: the data-encoded alert bytes survive
 * exactly only where a pixel is fully opaque.
 * `flipY` draws an ImageBitmap that Cesium already flipped back upright.
 */
export function recolorTile(
  image,
  recolor,
  createCanvas,
  { flipY = false } = {},
) {
  const canvas = createCanvas();
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (flipY) context.setTransform(1, 0, 0, -1, 0, image.height);
  context.drawImage(image, 0, 0);
  if (flipY) context.setTransform(1, 0, 0, 1, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  recolor(pixels.data);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/**
 * One Global Forest Watch Web Mercator tile provider limited to Indonesia,
 * whose tiles are recoloured on arrival. `kind` is 'alerts' or 'peat'.
 * `onTile(ok)` hears each settled tile that is not a plain 404.
 */
export function createGfwImageryProvider({
  cesium,
  kind,
  windowDays = DEFAULT_WINDOW_DAYS,
  nowMs = Date.now(),
  createCanvas,
  onTile = () => {},
}) {
  const alerts = kind === 'alerts';
  const nowDayIndex = dayIndexFor(nowMs);
  const days = normalizeWindow(windowDays);
  const recolor = alerts
    ? (data) => recolorAlertPixels(data, nowDayIndex, days)
    : recolorPeatPixels;
  const { west, south, east, north } = INDONESIA_BOUNDS;
  const provider = new cesium.UrlTemplateImageryProvider({
    url: alerts ? ALERTS_TILE_URL : PEAT_TILE_URL,
    tilingScheme: new cesium.WebMercatorTilingScheme(),
    rectangle: cesium.Rectangle.fromDegrees(west, south, east, north),
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel: TILE_MINIMUM_LEVEL,
    maximumLevel: TILE_MAXIMUM_LEVEL,
    enablePickFeatures: false,
    credit: new cesium.Credit('Global Forest Watch', false),
  });
  const requestImage = provider.requestImage.bind(provider);
  provider.requestImage = (x, y, level, request) => {
    const result = requestImage(x, y, level, request);
    // Scheduler admission: Cesium asks again later.
    if (!result) return result;
    return Promise.resolve(result).then((image) => {
      // Cesium decodes tiles as ImageBitmaps already flipped, since WebGL
      // ignores UNPACK_FLIP_Y for them; a canvas upload flips again.
      const bitmap =
        typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
      try {
        const tile = recolorTile(image, recolor, createCanvas, {
          flipY: bitmap,
        });
        retries.delete(`${level}/${x}/${y}`);
        onTile(true);
        return tile;
      } finally {
        if (bitmap) image.close?.();
      }
    });
  };
  const retries = new Map();
  provider.errorEvent.addEventListener((error) => {
    const status = error?.error?.statusCode;
    error.retry = false;
    // A missing tile is open ocean or no data, not a fault.
    if (status === 404) return;
    const key = `${error.level}/${error.x}/${error.y}`;
    const attempts = retries.get(key) ?? 0;
    if (
      (status === 429 || status === 503) &&
      attempts < MAX_TRANSIENT_RETRIES
    ) {
      retries.set(key, attempts + 1);
      error.retry = true;
      return;
    }
    retries.delete(key);
    onTile(false);
  });
  return provider;
}

/**
 * Own the peat and alert imagery layers on the resolved imagery host.
 * Peat is always kept below the alerts. Switching host (globe to 3D Tiles
 * and back) re-creates the layers on the new collection.
 */
export function createForestAlertsImagery({
  cesium,
  getHost,
  createCanvas,
  now = Date.now,
  onChange = () => {},
  failureLimit = FAILURE_LIMIT,
}) {
  const options = { alerts: true, peat: true, windowDays: DEFAULT_WINDOW_DAYS };
  const entries = { alerts: null, peat: null };
  let enabled = false;
  let failures = 0;

  const onTile = (ok) => {
    const before = failures >= failureLimit;
    failures = ok ? 0 : failures + 1;
    if (before !== failures >= failureLimit) onChange();
  };

  function detach(kind) {
    const entry = entries[kind];
    entries[kind] = null;
    if (!entry) return;
    const { collection, layer } = entry;
    if (collection && !collection.isDestroyed?.() && collection.contains(layer))
      collection.remove(layer, true);
    else if (!layer.isDestroyed?.()) layer.destroy?.();
  }

  function attach(kind, collection) {
    const provider = createGfwImageryProvider({
      cesium,
      kind,
      windowDays: options.windowDays,
      nowMs: now(),
      createCanvas,
      onTile,
    });
    entries[kind] = {
      collection,
      layer: collection.addImageryProvider(provider),
      windowDays: options.windowDays,
    };
  }

  function sync() {
    const host = getHost();
    const { collection } = host;
    if (!enabled || imageryHostStatus(host) !== null || !collection) {
      detach('peat');
      detach('alerts');
      return;
    }
    for (const kind of ['peat', 'alerts']) {
      const entry = entries[kind];
      if (
        entry &&
        (!options[kind] ||
          entry.collection !== collection ||
          (kind === 'alerts' && entry.windowDays !== options.windowDays))
      )
        detach(kind);
      if (options[kind] && !entries[kind]) attach(kind, collection);
    }
    const { alerts, peat } = entries;
    if (
      alerts &&
      peat &&
      typeof collection.raiseToTop === 'function' &&
      collection.indexOf(alerts.layer) < collection.indexOf(peat.layer)
    )
      collection.raiseToTop(alerts.layer);
  }

  const apply = () => {
    sync();
    onChange();
  };

  return {
    /** Layers exist only while enabled; disabling removes them. */
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) failures = 0;
      apply();
    },
    /** Set any of `alerts`, `peat`, `windowDays` and reconcile the layers. */
    setOptions(next = {}) {
      if (next.alerts !== undefined) options.alerts = Boolean(next.alerts);
      if (next.peat !== undefined) options.peat = Boolean(next.peat);
      if (next.windowDays !== undefined)
        options.windowDays = normalizeWindow(next.windowDays);
      apply();
    },
    getOptions: () => ({ ...options }),
    /** Re-create the alert imagery so 'latest' tiles and the date window refresh. */
    refresh() {
      failures = 0;
      detach('alerts');
      apply();
    },
    /** Follow the imagery host after a map change. */
    rehome: apply,
    clear() {
      detach('peat');
      detach('alerts');
      failures = 0;
    },
    getStatus() {
      const hostStatus = imageryHostStatus(getHost());
      return {
        active: Boolean(entries.alerts || entries.peat),
        error:
          hostStatus ??
          (failures >= failureLimit ? FOREST_TILES_UNAVAILABLE : null),
      };
    },
  };
}
