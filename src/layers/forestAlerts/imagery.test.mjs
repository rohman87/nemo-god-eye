import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOREST_TILES_UNAVAILABLE,
  NO_IMAGERY_HOST,
  createForestAlertsImagery,
  createGfwImageryProvider,
  recolorTile,
} from './imagery.js';
import { ALERTS_TILE_URL, PEAT_TILE_URL, dayIndexFor } from './model.js';

class FakeEvent {
  listeners = [];
  addEventListener(fn) {
    this.listeners.push(fn);
    return () => this.listeners.splice(this.listeners.indexOf(fn), 1);
  }
}
class FakeProvider {
  constructor(options) {
    this.options = options;
    this.errorEvent = new FakeEvent();
  }
  requestImage() {
    return FakeProvider.nextImage;
  }
}
class FakeScheme {}
const fakeCesium = {
  UrlTemplateImageryProvider: FakeProvider,
  WebMercatorTilingScheme: FakeScheme,
  Rectangle: {
    fromDegrees: (west, south, east, north) => ({ west, south, east, north }),
  },
  Credit: class {
    constructor(text) {
      this.text = text;
    }
  },
};
const fakeCanvas = () => {
  let data = null;
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      setTransform() {},
      drawImage: (image) => {
        data = Uint8ClampedArray.from(image.data);
      },
      getImageData: () => ({ data }),
      putImageData: (pixels) => {
        data = pixels.data;
      },
    }),
    get data() {
      return data;
    },
  };
};
const fakeCollection = () => {
  const layers = [];
  return {
    layers,
    contains: (layer) => layers.includes(layer),
    indexOf: (layer) => layers.indexOf(layer),
    addImageryProvider(provider) {
      const layer = { provider };
      layers.push(layer);
      return layer;
    },
    remove(layer) {
      layers.splice(layers.indexOf(layer), 1);
      return true;
    },
    raiseToTop(layer) {
      layers.splice(layers.indexOf(layer), 1);
      layers.push(layer);
    },
  };
};
const NOW = Date.UTC(2026, 9, 30);
const harness = (host) => {
  const collection = fakeCollection();
  const state = { host: host ?? { collection, kind: 'globe' }, changes: 0 };
  const imagery = createForestAlertsImagery({
    cesium: fakeCesium,
    getHost: () => state.host,
    createCanvas: fakeCanvas,
    now: () => NOW,
    onChange: () => state.changes++,
    failureLimit: 2,
  });
  return { imagery, collection, state };
};
const urls = (collection) =>
  collection.layers.map((l) => l.provider.options.url);

test('providers are Web Mercator, Indonesia-limited and level-bounded', () => {
  const provider = createGfwImageryProvider({
    cesium: fakeCesium,
    kind: 'alerts',
    createCanvas: fakeCanvas,
  });
  const { options } = provider;
  assert.equal(options.url, ALERTS_TILE_URL);
  assert.ok(options.tilingScheme instanceof FakeScheme);
  assert.deepEqual(options.rectangle, {
    west: 94,
    south: -11.5,
    east: 141.5,
    north: 6.5,
  });
  assert.equal(options.minimumLevel, 0);
  assert.equal(options.maximumLevel, 12);
  assert.equal(options.enablePickFeatures, false);
  assert.equal(
    createGfwImageryProvider({
      cesium: fakeCesium,
      kind: 'peat',
      createCanvas: fakeCanvas,
    }).options.url,
    PEAT_TILE_URL,
  );
});

test('recolorTile redraws into a canvas and recolours the pixels', () => {
  const canvas = recolorTile(
    { width: 1, height: 1, data: [1, 2, 3, 255] },
    (data) => data.fill(7),
    fakeCanvas,
  );
  assert.deepEqual([...canvas.data], [7, 7, 7, 7]);
});

test('alert tiles are decoded against the injected clock', async () => {
  const day = dayIndexFor(NOW) - 3;
  FakeProvider.nextImage = Promise.resolve({
    width: 2,
    height: 1,
    data: [Math.floor(day / 255), day % 255, 200, 255, 0, 0, 0, 0],
  });
  const provider = createGfwImageryProvider({
    cesium: fakeCesium,
    kind: 'alerts',
    windowDays: 30,
    nowMs: NOW,
    createCanvas: fakeCanvas,
  });
  const tile = await provider.requestImage(1, 2, 3);
  assert.deepEqual([...tile.data], [0xff, 0x4f, 0x9a, 242, 0, 0, 0, 0]);
  FakeProvider.nextImage = undefined;
  assert.equal(provider.requestImage(1, 2, 3), undefined);
});

test('404 tiles are normal; other errors are counted and recovered', () => {
  const { imagery, collection, state } = harness();
  imagery.setEnabled(true);
  const [peat, alerts] = collection.layers;
  assert.equal(imagery.getStatus().error, null);
  const fire = (layer, statusCode) => {
    const event = { error: { statusCode }, x: 0, y: 0, level: 1, retry: true };
    layer.provider.errorEvent.listeners[0](event);
    return event;
  };
  assert.equal(fire(alerts, 404).retry, false);
  assert.equal(fire(peat, 404).retry, false);
  assert.equal(imagery.getStatus().error, null);
  assert.equal(fire(alerts, 503).retry, true);
  assert.equal(imagery.getStatus().error, null);
  state.changes = 0;
  fire(alerts, 500);
  assert.equal(imagery.getStatus().error, null);
  fire(alerts, 500);
  assert.equal(imagery.getStatus().error, FOREST_TILES_UNAVAILABLE);
  assert.equal(state.changes, 1);
});

test('toggles add and remove layers with peat always below alerts', () => {
  const { imagery, collection } = harness();
  imagery.setEnabled(true);
  assert.deepEqual(urls(collection), [PEAT_TILE_URL, ALERTS_TILE_URL]);
  imagery.setOptions({ peat: false });
  assert.deepEqual(urls(collection), [ALERTS_TILE_URL]);
  imagery.setOptions({ peat: true });
  assert.deepEqual(urls(collection), [PEAT_TILE_URL, ALERTS_TILE_URL]);
  imagery.setOptions({ alerts: false });
  assert.deepEqual(urls(collection), [PEAT_TILE_URL]);
  imagery.setEnabled(false);
  assert.deepEqual(urls(collection), []);
});

test('changing the window or refreshing re-creates only the alerts provider', () => {
  const { imagery, collection } = harness();
  imagery.setEnabled(true);
  const [peat, alerts] = collection.layers;
  imagery.setOptions({ windowDays: 30 });
  assert.equal(collection.layers[0], peat);
  assert.notEqual(collection.layers[1], alerts);
  const second = collection.layers[1];
  imagery.setOptions({ windowDays: 30 });
  assert.equal(collection.layers[1], second);
  imagery.refresh();
  assert.notEqual(collection.layers[1], second);
  assert.equal(collection.layers.length, 2);
  assert.equal(imagery.getOptions().windowDays, 30);
});

test('options set while disabled apply on enable', () => {
  const { imagery, collection } = harness();
  imagery.setOptions({ peat: false });
  assert.deepEqual(urls(collection), []);
  imagery.setEnabled(true);
  assert.deepEqual(urls(collection), [ALERTS_TILE_URL]);
});

test('a host without imagery reports status and a host switch re-homes layers', () => {
  const { imagery, collection, state } = harness();
  imagery.setEnabled(true);
  state.host = { collection: null, kind: 'none' };
  imagery.rehome();
  assert.deepEqual(urls(collection), []);
  assert.equal(imagery.getStatus().error, NO_IMAGERY_HOST);
  const other = fakeCollection();
  state.host = { collection: other, kind: 'tileset' };
  imagery.rehome();
  assert.deepEqual(urls(other), [PEAT_TILE_URL, ALERTS_TILE_URL]);
  assert.equal(imagery.getStatus().error, null);
  imagery.clear();
  assert.deepEqual(urls(other), []);
});
