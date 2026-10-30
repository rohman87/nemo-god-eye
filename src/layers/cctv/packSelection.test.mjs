// Provider-pack changes and the active camera: a camera in a disabled pack is
// deactivated (not re-targeted), and the UI payload counts only enabled packs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { createSelection } from './selection.js';
import { createPresentation } from './presentation.js';

const record = (id, pack) => ({ camera: { id, pack, city: 'X', name: id } });

function layerStateFor(records, { activeId = null, disabled = [] } = {}) {
  return {
    _records: records,
    _recordById: new Map(records.map((r) => [r.camera.id, r])),
    _activeCameraId: activeId,
    _disabledPacks: new Set(disabled),
    _packsCustomizedByUser: false,
    _count: records.length,
    _viewRecords: [],
    _listeners: new Set(),
    _cardIds: new Set(),
    _healthById: new Map(),
  };
}

function controlsFixture(state) {
  const calls = [];
  const log = (name, result) => () => {
    calls.push(name);
    return result;
  };
  const parts = {
    selection: { deactivateActiveCamera: log('deactivate') },
    rendering: {
      refreshHorizonCulling: log('cull', true),
      refreshCoverageStyles: log('styles'),
    },
    geometryQueue: { enqueueViewGeometry: log('enqueue') },
    cards: { refreshAmbientCards: log('cards') },
    presentation: { notifyListeners: log('notify') },
  };
  const services = {
    render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    activation: { CCTV_ACTIVATION_RESULT: {} },
  };
  const { methods } = createControls({ state, services, parts, source: {} });
  return { methods, calls };
}

const twoPacks = () => [record('a', 'jakarta'), record('b', 'austin')];

test('disabling the active camera pack deactivates it', () => {
  const state = layerStateFor(twoPacks(), { activeId: 'b' });
  const { methods, calls } = controlsFixture(state);
  methods.setParams({ togglePack: 'AUSTIN' });
  assert.ok(state._disabledPacks.has('austin'));
  assert.ok(state._packsCustomizedByUser);
  assert.ok(calls.includes('deactivate'));
  assert.ok(!calls.includes('enqueue'), 'no geometry enqueue after deactivate');
});

test('disabling another pack refreshes culling and geometry instead', () => {
  const state = layerStateFor(twoPacks(), { activeId: 'a' });
  const { methods, calls } = controlsFixture(state);
  methods.setParams({ disabledPacks: ['Austin'] });
  assert.deepEqual([...state._disabledPacks], ['austin']);
  assert.ok(!calls.includes('deactivate'));
  assert.deepEqual(
    calls.filter((c) => c === 'cull' || c === 'enqueue' || c === 'cards'),
    ['cull', 'enqueue', 'cards'],
  );
});

test('re-enabling a pack with no active camera does not deactivate', () => {
  const state = layerStateFor(twoPacks(), { disabled: ['austin'] });
  const { methods, calls } = controlsFixture(state);
  methods.setParams({ togglePack: 'austin' });
  assert.equal(state._disabledPacks.size, 0);
  assert.ok(!calls.includes('deactivate'));
  assert.ok(calls.includes('enqueue'));
});

test('a stale active id is ignored when packs change', () => {
  const state = layerStateFor(twoPacks(), { activeId: 'gone' });
  const { methods, calls } = controlsFixture(state);
  methods.setParams({ togglePack: 'austin' });
  assert.ok(!calls.includes('deactivate'));
});

test('resetDefaultPacks deactivates an active camera outside the defaults', () => {
  const state = layerStateFor(twoPacks(), { activeId: 'b' });
  state._packsCustomizedByUser = true;
  const { methods, calls } = controlsFixture(state);
  methods.setParams({ resetDefaultPacks: true });
  assert.equal(state._packsCustomizedByUser, false);
  assert.deepEqual([...state._disabledPacks], ['austin']);
  assert.ok(calls.includes('deactivate'));
});

test('resetDefaultPacks keeps an active camera in a default pack', () => {
  const state = layerStateFor(twoPacks(), { activeId: 'a' });
  const { methods, calls } = controlsFixture(state);
  methods.setParams({ resetDefaultPacks: true });
  assert.ok(!calls.includes('deactivate'));
  assert.ok(calls.includes('enqueue'));
});

test('params without a pack change skip the pack refresh', () => {
  const state = layerStateFor(twoPacks(), { activeId: 'b' });
  const { methods, calls } = controlsFixture(state);
  methods.setParams({});
  assert.deepEqual(calls, ['styles', 'notify']);
});

function selectionFor(state) {
  return createSelection({
    state,
    services: {
      activation: { CCTV_ACTIVATION_RESULT: {} },
      picking: { resolvePickId() {} },
    },
    parts: {},
    source: {},
  });
}

test('getActiveRecord returns null for a camera in a disabled pack', () => {
  const state = layerStateFor(twoPacks(), {
    activeId: 'b',
    disabled: ['austin'],
  });
  assert.equal(selectionFor(state).getActiveRecord(), null);
  assert.equal(state._activeCameraId, 'b', 'does not re-target another camera');
});

test('getActiveRecord returns the record when its pack is enabled', () => {
  const state = layerStateFor(twoPacks(), {
    activeId: 'a',
    disabled: ['austin'],
  });
  assert.equal(
    selectionFor(state).getActiveRecord(),
    state._recordById.get('a'),
  );
});

test('getActiveRecord is null with no active id', () => {
  assert.equal(selectionFor(layerStateFor(twoPacks())).getActiveRecord(), null);
});

function uiStateFor(state) {
  return createPresentation({
    state,
    services: {},
    parts: { selection: { getActiveRecord: () => null } },
    source: {},
  }).uiState();
}

test('enabledCount equals count when no pack is disabled', () => {
  const state = layerStateFor(twoPacks());
  state._count = 99;
  assert.equal(uiStateFor(state).enabledCount, 99);
});

test('enabledCount excludes records in disabled packs', () => {
  const state = layerStateFor(
    [record('a', 'jakarta'), record('b', 'austin'), record('c', 'austin')],
    { disabled: ['austin'] },
  );
  const payload = uiStateFor(state);
  assert.equal(payload.enabledCount, 1);
  assert.equal(payload.count, 3);
});

test('enabledCount is 0 when every pack is disabled', () => {
  const state = layerStateFor(twoPacks(), { disabled: ['jakarta', 'austin'] });
  assert.equal(uiStateFor(state).enabledCount, 0);
});
