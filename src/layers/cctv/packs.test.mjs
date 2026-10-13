import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { DEFAULT_ENABLED_CCTV_PACKS } from './policy.js';
import { createCctvLayer } from './index.js';

test('DEFAULT_ENABLED_CCTV_PACKS contains jakarta and westjava only', () => {
  assert.deepEqual(Array.from(DEFAULT_ENABLED_CCTV_PACKS), ['jakarta', 'westjava']);
});

test('cctvLayer enables jakarta and westjava by default and disables other providers', async (t) => {
  const originalDoc = globalThis.document;
  const docListeners = new Map();
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        fillRect: () => {},
        clearRect: () => {},
        strokeRect: () => {},
        fillText: () => {},
        drawImage: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} }),
        getImageData: () => ({ data: new Uint8Array(4) }),
      }),
      style: {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      docListeners.get(type)?.delete(fn);
    },
  };
  const originalImage = globalThis.Image;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.Image = class {
    constructor() {
      setTimeout(() => {
        if (typeof this.onload === 'function') this.onload();
      }, 0);
    }
  };
  t.after(() => {
    globalThis.document = originalDoc;
    globalThis.Image = originalImage;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  });

  const canvasListeners = new Map();
  const fakeCanvas = {
    clientHeight: 600,
    clientWidth: 800,
    addEventListener: (type, fn) => {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      canvasListeners.get(type)?.delete(fn);
    },
  };

  const fakeViewer = {
    isDestroyed: () => false,
    entities: {
      add: (ent) => ent || {},
      remove: () => true,
    },
    scene: {
      primitives: {
        add: () => ({}),
        remove: () => true,
      },
      canvas: fakeCanvas,
    },
    camera: {
      position: Cesium.Cartesian3.fromDegrees(0, 0, 10000000),
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 10000000),
      positionCartographic: { latitude: 0, longitude: 0 },
      moveEnd: { addEventListener: () => {}, removeEventListener: () => {} },
      moveStart: { addEventListener: () => {}, removeEventListener: () => {} },
    },
  };

  const sources = [
    { id: 'cam-austin-1', name: 'Austin Cam 1', pack: 'austin', cityId: 'austin', city: 'Austin', lat: 30.2, lon: -97.7 },
    { id: 'cam-caltrans-1', name: 'California Cam 1', pack: 'caltrans', cityId: 'sf', city: 'SF', lat: 37.7, lon: -122.4 },
    { id: 'cam-jkt-1', name: 'Jakarta Monas', pack: 'jakarta', cityId: 'jakarta', city: 'Jakarta', lat: -6.17, lon: 106.82 },
    { id: 'cam-westjava-1', name: 'Depok Margonda', pack: 'westjava', cityId: 'westjava', city: 'Depok', lat: -6.37, lon: 106.83 },
  ];

  const source = {
    getCatalog: async () => ({ sources }),
    getHealth: async () => ({}),
    getFrameUrl: () => 'https://example.com/frame.jpg',
    getMediaUrl: () => 'https://example.com/media.m3u8',
  };

  const noop = () => {};
  const services = {
    overlays: {
      clearOverlaySource: noop,
      hitTestWorldOverlay: noop,
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
    },
    sprites: { registerSpriteCollection: noop, restoreSpriteOrder: noop },
    activation: { activateCctvCameraFromWorldClick: noop },
    locations: { CITY_POIS: {} },
    picking: { resolvePickId: () => null, registerPickOwner: noop, unregisterPickOwner: noop },
    terrain: {},
    ground: {
      resolveGroundPriorBatch: async () => [],
      warmGroundFloor: async () => null,
      cachedGroundFloor: () => 0,
      resolveEllipsoidalGround: () => 0,
    },
    mesh: {},
    focus: { onFocusTargetAppear: () => noop },
    render: { releaseContinuousRender: noop, holdContinuousRender: noop },
  };

  const layer = createCctvLayer({ services, source });
  await layer.init(fakeViewer);

  // Before explicit toggle, only jakarta and westjava should be active
  let ui = layer.getUIState();
  const jakartaPack = ui.packs.find((p) => p.id === 'jakarta');
  const westjavaPack = ui.packs.find((p) => p.id === 'westjava');
  const austinPack = ui.packs.find((p) => p.id === 'austin');
  const caltransPack = ui.packs.find((p) => p.id === 'caltrans');

  assert.ok(jakartaPack?.active, 'Jakarta pack must be enabled by default');
  assert.ok(westjavaPack?.active, 'West Java pack must be enabled by default');
  assert.equal(austinPack?.active, false, 'Austin pack must be disabled by default');
  assert.equal(caltransPack?.active, false, 'California pack must be disabled by default');

  // Cameras list should only contain enabled packs
  const cameraIds = ui.cameras.map((c) => c.id);
  assert.ok(cameraIds.includes('cam-jkt-1'), 'Jakarta camera must be in visible list');
  assert.ok(cameraIds.includes('cam-westjava-1'), 'West Java camera must be in visible list');
  assert.ok(!cameraIds.includes('cam-austin-1'), 'Austin camera must not be in visible list');
  assert.ok(!cameraIds.includes('cam-caltrans-1'), 'California camera must not be in visible list');

  // Active camera should be from an enabled pack
  assert.ok(
    ui.activeCameraId === 'cam-jkt-1' || ui.activeCameraId === 'cam-westjava-1',
    `Active camera should be from enabled pack: ${ui.activeCameraId}`,
  );

  // Enable layer
  layer.enable();
  ui = layer.getUIState();
  assert.ok(
    ui.activeCameraId === 'cam-jkt-1' || ui.activeCameraId === 'cam-westjava-1',
    'Active camera after enable must be from enabled pack',
  );

  // User toggles Austin
  layer.setParams({ togglePack: 'austin' });
  ui = layer.getUIState();
  const austinToggled = ui.packs.find((p) => p.id === 'austin');
  assert.equal(austinToggled?.active, true, 'Austin pack should now be enabled');
  assert.ok(ui.cameras.some((c) => c.id === 'cam-austin-1'), 'Austin camera should now be visible');

  // User clicks "Enable All"
  layer.setParams({ disabledPacks: [] });
  ui = layer.getUIState();
  assert.ok(ui.packs.every((p) => p.active), 'All packs should be enabled');
  assert.equal(ui.cameras.length, 4, 'All 4 cameras should be visible');

  layer.disable();
  layer.destroy();
});
