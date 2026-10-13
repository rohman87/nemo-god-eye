import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CctvControls } from './cctvControls.js';

function element() {
  const classes = new Set();
  return {
    dataset: {},
    src: '',
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    classList: {
      add(...values) {
        values.forEach((value) => classes.add(value));
      },
      remove(...values) {
        values.forEach((value) => classes.delete(value));
      },
      contains(value) {
        return classes.has(value);
      },
      toggle(value, enabled) {
        if (enabled) classes.add(value);
        else classes.delete(value);
      },
    },
  };
}
function fixture(t) {
  const prior = globalThis.Image;
  const requests = [];
  globalThis.Image = class {
    constructor() {
      requests.push(this);
    }
  };
  t.after(() => {
    globalThis.Image = prior;
  });
  const controls = new CctvControls({
    elements: { _cctvFrame: element(), _cctvFrameWrap: element() },
    cctv: {},
    actions: { isEnabled: () => true },
  });
  t.after(() => controls.destroy());
  return { controls, requests };
}

test('a late image completion cannot replace a newer camera preview', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const stale = requests[0].onload;
  controls._queueCctvFrame('second.jpg', 'b', true);
  assert.equal(requests[0].onload, null);
  requests[1].onload();
  stale();
  assert.equal(controls._cctvFrame.src, 'second.jpg');
  assert.equal(controls._cctvFrame.dataset.cameraId, 'b');
});

test('failed refresh preserves settled pixels, but changing cameras clears them', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  requests[1].onerror();
  assert.equal(controls._cctvFrame.src, 'first.jpg');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), true);
  controls._queueCctvFrame('other.jpg', 'b', true);
  assert.equal(controls._cctvFrame.src, '');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), false);
});

test('destroy invalidates image callbacks and releases each subscription once', (t) => {
  const { controls, requests } = fixture(t);
  let unsubscribed = 0;
  controls.cctv.subscribe = () => () => {
    unsubscribed++;
  };
  controls.connect();
  controls.connect();
  assert.equal(unsubscribed, 1);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const late = requests[0].onload;
  controls.destroy();
  controls.destroy();
  controls.connect();
  late();
  assert.equal(unsubscribed, 2);
  assert.equal(requests[0].onload, null);
  assert.equal(requests[0].onerror, null);
  assert.equal(controls._cctvFrame.src, '');
  controls._queueCctvFrame('late.jpg', 'b', true);
  assert.equal(requests.length, 1);
});

function calibrationFixture(t) {
  const { controls } = fixture(t);
  const prior = globalThis.document;
  const inputs = [];
  globalThis.document = {
    createElement() {
      const input = new EventTarget();
      Object.assign(input, {
        focus() {},
        select() {},
        remove() {
          this.parent.input = null;
        },
      });
      inputs.push(input);
      return input;
    },
  };
  t.after(() => {
    globalThis.document = prior;
  });
  const chip = {
    dataset: { calField: 'heading' },
    textContent: '',
    input: null,
    appendChild(input) {
      this.input = input;
      input.parent = this;
    },
    querySelector() {
      return this.input;
    },
  };
  const patches = [];
  controls.actions.setParams = (params) => patches.push(params);
  controls.actions.setPanelCollapsed = () => {};
  controls._cctvCalReadout = { querySelectorAll: () => [chip] };
  controls._cctvState = {
    enabled: true,
    activeCameraId: 'a',
    activeCamera: { id: 'a', headingDeg: 30, basePose: { headingDeg: 20 } },
  };
  const key = (name) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key: name });
  return { controls, chip, inputs, patches, key };
}

test('calibration commits against the captured camera base and releases its editor', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._cctvState.activeCamera.basePose.headingDeg = 60;
  inputs[0].dispatchEvent(key('Enter'));
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, [
    {
      selectedCameraId: 'a',
      calibration: { cameraId: 'a', patch: { headingDeg: 80 } },
    },
  ]);
  assert.equal(controls._calibrationEdit, null);
});

test('a camera switch cancels calibration before old blur can change the new camera', (t) => {
  const { controls, chip, inputs, patches } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._renderCctvState({
    enabled: true,
    activeCameraId: 'b',
    activeCamera: { id: 'b', headingDeg: 200, basePose: { headingDeg: 190 } },
  });
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  assert.equal(chip.input, null);
  assert.equal(chip.textContent, 'HDG 200.0°');
});

test('Escape claims calibration cancellation and disposal prevents late commits', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  const escape = key('Escape');
  inputs[0].dispatchEvent(escape);
  inputs[0].dispatchEvent(new Event('blur'));
  assert.equal(escape.defaultPrevented, true);
  controls._beginCctvCalValueEdit(chip);
  inputs[1].value = '120';
  controls.destroy();
  inputs[1].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
});

test('disposing during camera enable prevents the delayed focus and future clicks', async () => {
  const button = new EventTarget();
  let resolveEnable;
  let enables = 0;
  let focuses = 0;
  const controls = new CctvControls({
    elements: { _cctvPanel: {}, _cctvNextBtn: button },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      toggleEnabled() {
        enables++;
        return new Promise((resolve) => {
          resolveEnable = resolve;
        });
      },
      runExplicitFocus() {
        focuses++;
      },
    },
  });
  button.dispatchEvent(new Event('click'));
  controls.destroy();
  resolveEnable(true);
  await new Promise((resolve) => setImmediate(resolve));
  button.dispatchEvent(new Event('click'));
  assert.equal(enables, 1);
  assert.equal(focuses, 0);
});

test('fullscreen expand, collapse, and Escape key handling', (t) => {
  const wrap = element();
  wrap.parentNode = { appendChild() {}, insertBefore() {} };
  wrap.setAttribute = () => {};
  wrap.removeAttribute = () => {};
  const fullscreenBtn = new EventTarget();
  const closeBtn = new EventTarget();
  closeBtn.hidden = true;
  const controls = new CctvControls({
    elements: {
      _cctvPanel: {},
      _cctvFrameWrap: wrap,
      _cctvFullscreenBtn: fullscreenBtn,
      _cctvFullscreenCloseBtn: closeBtn,
    },
    cctv: {},
    actions: { isEnabled: () => true, syncViewport() {} },
  });
  t.after(() => controls.destroy());

  assert.equal(controls.isViewerExpanded(), false);
  fullscreenBtn.dispatchEvent(new Event('click'));
  assert.equal(controls.isViewerExpanded(), true);
  assert.equal(closeBtn.hidden, false);

  fullscreenBtn.dispatchEvent(new Event('click'));
  assert.equal(controls.isViewerExpanded(), false);
  assert.equal(closeBtn.hidden, true);

  controls.setViewerExpanded(true);
  assert.equal(controls.isViewerExpanded(), true);
  closeBtn.dispatchEvent(new Event('click'));
  assert.equal(controls.isViewerExpanded(), false);
});

test('provider pack chip clicks forward togglePack parameter', (t) => {
  const chipsContainer = new EventTarget();
  chipsContainer.children = [];
  let setParamsCall = null;
  const controls = new CctvControls({
    elements: {
      _cctvPanel: {},
      _cctvProviderChips: chipsContainer,
    },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      setParams(params, options) {
        setParamsCall = { params, options };
      },
    },
  });
  t.after(() => controls.destroy());

  const chipBtn = {
    dataset: { chipId: 'jakarta' },
    closest(selector) {
      return selector === '.data-toggle-chip' ? this : null;
    },
  };
  const clickEvent = new Event('click');
  Object.defineProperty(clickEvent, 'target', { value: chipBtn });
  chipsContainer.dispatchEvent(clickEvent);

  assert.deepEqual(setParamsCall, {
    params: { togglePack: 'jakarta' },
    options: { origin: 'user' },
  });
});

test('provider packs quick enable all and disable all buttons', (t) => {
  const allBtn = new EventTarget();
  const noneBtn = new EventTarget();
  const defaultBtn = new EventTarget();
  let calls = [];
  const controls = new CctvControls({
    elements: {
      _cctvPanel: {},
      _cctvPacksAllBtn: allBtn,
      _cctvPacksNoneBtn: noneBtn,
      _cctvPacksDefaultBtn: defaultBtn,
    },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      setParams(params, options) {
        calls.push({ params, options });
      },
    },
  });
  t.after(() => controls.destroy());

  controls._cctvState = {
    packs: [
      { id: 'jakarta' },
      { id: 'westjava' },
      { id: 'depok' },
      { id: 'bogor' },
      { id: 'austin' },
    ],
  };

  allBtn.dispatchEvent(new Event('click'));
  noneBtn.dispatchEvent(new Event('click'));
  defaultBtn.dispatchEvent(new Event('click'));

  assert.deepEqual(calls[0].params, { disabledPacks: [] });
  assert.deepEqual(calls[1].params, {
    disabledPacks: ['jakarta', 'westjava', 'depok', 'bogor', 'austin'],
  });
  assert.deepEqual(calls[2].params, {
    resetDefaultPacks: true,
    disabledPacks: ['austin'],
  });
});

test('fullscreen prev/next buttons and arrow keys cycle cameras', async (t) => {
  const priorDoc = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    globalThis.document = priorDoc;
  });
  const wrap = element();
  wrap.parentNode = { appendChild() {}, insertBefore() {} };
  wrap.setAttribute = () => {};
  wrap.removeAttribute = () => {};
  const fsPrevBtn = new EventTarget();
  const fsNextBtn = new EventTarget();
  const fsSidePrev = new EventTarget();
  const fsSideNext = new EventTarget();
  const cycled = [];
  const controls = new CctvControls({
    elements: {
      _cctvPanel: {},
      _cctvFrameWrap: wrap,
      _cctvFsPrevBtn: fsPrevBtn,
      _cctvFsNextBtn: fsNextBtn,
      _cctvFsSidePrev: fsSidePrev,
      _cctvFsSideNext: fsSideNext,
    },
    cctv: {
      cycleCamera: (delta) => {
        cycled.push(delta);
        return 'cam-' + delta;
      },
      focusCamera: () => {},
    },
    actions: {
      isEnabled: () => true,
      toggleEnabled: async () => true,
      syncViewport() {},
      runExplicitFocus: (select, focus) => {
        const id = select();
        if (id) focus(id);
      },
    },
  });
  t.after(() => controls.destroy());

  // Top header fs nav buttons
  fsPrevBtn.dispatchEvent(new Event('click'));
  await Promise.resolve();
  fsNextBtn.dispatchEvent(new Event('click'));
  await Promise.resolve();
  assert.deepEqual(cycled, [-1, 1]);

  // Floating side chevron buttons
  fsSidePrev.dispatchEvent(new Event('click'));
  await Promise.resolve();
  fsSideNext.dispatchEvent(new Event('click'));
  await Promise.resolve();
  assert.deepEqual(cycled, [-1, 1, -1, 1]);

  // Arrow keys when not expanded should NOT cycle
  const arrowLeft = new Event('keydown');
  arrowLeft.key = 'ArrowLeft';
  const arrowRight = new Event('keydown');
  arrowRight.key = 'ArrowRight';
  const bracketLeft = new Event('keydown');
  bracketLeft.key = '[';
  const bracketRight = new Event('keydown');
  bracketRight.key = ']';

  document.dispatchEvent(arrowLeft);
  await Promise.resolve();
  document.dispatchEvent(arrowRight);
  await Promise.resolve();
  assert.deepEqual(cycled, [-1, 1, -1, 1]);

  // Arrow keys and [ / ] when expanded SHOULD cycle
  controls.setViewerExpanded(true);
  document.dispatchEvent(arrowLeft);
  await Promise.resolve();
  document.dispatchEvent(arrowRight);
  await Promise.resolve();
  document.dispatchEvent(bracketLeft);
  await Promise.resolve();
  document.dispatchEvent(bracketRight);
  await Promise.resolve();
  assert.deepEqual(cycled, [-1, 1, -1, 1, -1, 1, -1, 1]);
});
