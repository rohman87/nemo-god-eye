import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_EPOCH_MS,
  alertPixelColor,
  dayIndexFor,
  decodeAlertPixel,
  normalizeWindow,
  recolorAlertPixels,
  recolorPeatPixels,
} from './model.js';

const encode = (dayIndex, confidenceByte, alpha = 255) => [
  Math.floor(dayIndex / 255),
  dayIndex % 255,
  confidenceByte,
  alpha,
];

test('dayIndexFor counts whole UTC days since 2015-01-01', () => {
  assert.equal(dayIndexFor(ALERT_EPOCH_MS), 0);
  assert.equal(dayIndexFor(ALERT_EPOCH_MS + 86_400_000 - 1), 0);
  assert.equal(dayIndexFor(Date.UTC(2016, 0, 1)), 365);
  assert.ok(Number.isNaN(dayIndexFor('x')));
});

test('decodeAlertPixel reads day (R*255+G), confidence band and no-alert alpha', () => {
  assert.deepEqual(decodeAlertPixel(10, 20, 255, 255), {
    dayIndex: 10 * 255 + 20,
    confidence: 'highest',
  });
  assert.equal(decodeAlertPixel(1, 0, 250, 200).confidence, 'highest');
  assert.equal(decodeAlertPixel(1, 0, 249, 200).confidence, 'high');
  assert.equal(decodeAlertPixel(1, 0, 200, 200).confidence, 'high');
  assert.equal(decodeAlertPixel(1, 0, 150, 200).confidence, 'high');
  assert.equal(decodeAlertPixel(1, 0, 149, 200).confidence, 'lower');
  assert.equal(decodeAlertPixel(1, 0, 100, 200).confidence, 'lower');
  assert.equal(decodeAlertPixel(1, 0, 1, 200).confidence, 'lower');
  assert.equal(decodeAlertPixel(1, 0, 0, 200), null);
  assert.equal(decodeAlertPixel(1, 0, 255, 0), null);
  assert.equal(decodeAlertPixel(NaN, 0, 255, 255), null);
  assert.equal(decodeAlertPixel(undefined, 0, 255, 255), null);
});

test('alertPixelColor uses the confidence ladder and fixed age fade steps', () => {
  const day = 3000;
  const at = (age, confidence = 'high') =>
    alertPixelColor({ dayIndex: day - age, confidence }, day, 90);
  assert.deepEqual(at(0, 'lower'), [0xc0, 0x6a, 0x94, 242]);
  assert.deepEqual(at(0, 'high'), [0xff, 0x4f, 0x9a, 242]);
  assert.deepEqual(at(0, 'highest'), [0xff, 0xe0, 0xee, 242]);
  assert.equal(at(30)[3], 242);
  assert.equal(at(31)[3], 179);
  assert.equal(at(60)[3], 179);
  assert.equal(at(61)[3], 115);
  assert.equal(at(90)[3], 115);
  assert.equal(at(91), null);
});

test('alertPixelColor honours the 30 day window and rejects bad input', () => {
  const decoded = (age) => ({ dayIndex: 3000 - age, confidence: 'high' });
  assert.ok(alertPixelColor(decoded(30), 3000, 30));
  assert.equal(alertPixelColor(decoded(31), 3000, 30), null);
  // The fade steps stay fixed whatever the window.
  assert.equal(alertPixelColor(decoded(10), 3000, 30)[3], 242);
  // One day ahead of the clock counts as today; further ahead is dropped.
  assert.equal(alertPixelColor(decoded(-1), 3000, 90)[3], 242);
  assert.equal(alertPixelColor(decoded(-2), 3000, 90), null);
  assert.equal(alertPixelColor(null, 3000, 90), null);
  assert.equal(alertPixelColor(decoded(0), NaN, 90), null);
  // An unknown window falls back to 90 days.
  assert.ok(alertPixelColor(decoded(80), 3000, 5));
});

test('normalizeWindow only offers 30 or 90', () => {
  assert.equal(normalizeWindow(30), 30);
  assert.equal(normalizeWindow('90'), 90);
  assert.equal(normalizeWindow(45), 90);
  assert.equal(normalizeWindow(undefined), 90);
});

test('recolorAlertPixels recolours in place and clears everything else', () => {
  const nowDay = 4000;
  const data = new Uint8ClampedArray([
    ...encode(nowDay - 5, 255), // fresh, highest
    ...encode(nowDay - 45, 100), // mid age, lower
    ...encode(nowDay - 200, 255), // outside the window
    ...encode(nowDay - 5, 255, 0), // no alert
    ...encode(nowDay - 5, 0), // no confidence
  ]);
  const visible = recolorAlertPixels(data, nowDay, 90);
  assert.equal(visible, 2);
  assert.deepEqual([...data.slice(0, 4)], [0xff, 0xe0, 0xee, 242]);
  assert.deepEqual([...data.slice(4, 8)], [0xc0, 0x6a, 0x94, 179]);
  assert.deepEqual([...data.slice(8)], new Array(12).fill(0));
});

test('recolorPeatPixels tints any visible pixel and clears the rest', () => {
  const data = new Uint8ClampedArray([9, 9, 9, 255, 1, 2, 3, 0, 4, 5, 6, 1]);
  assert.equal(recolorPeatPixels(data), 2);
  assert.deepEqual(
    [...data],
    [0xa1, 0x70, 0x4a, 89, 0, 0, 0, 0, 0xa1, 0x70, 0x4a, 89],
  );
});
