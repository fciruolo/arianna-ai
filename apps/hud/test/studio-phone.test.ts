import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fitFrame, fitStyle, followMedia, initialView, PHONE_PAGE_WIDTH } from '../src/lib/studio-phone.ts';

test('the Studio opens on the mobile view on the phone, on the desktop one elsewhere', () => {
  assert.equal(initialView(true), 'mobile');
  assert.equal(initialView(false), 'desktop');
});

test('a desktop page is drawn at its width and scaled down to the box', () => {
  const fit = fitFrame('desktop', { width: 320, height: 500 });
  assert.ok(fit !== undefined);
  assert.equal(fit.scale, 0.25);
  assert.equal(fit.width, PHONE_PAGE_WIDTH.desktop);
  // Once scaled it is as tall as the box.
  assert.equal(fit.height, 2000);
  assert.equal(Math.round(fit.height * fit.scale), 500);
});

test('a page narrower than the box is not enlarged: it takes the box width', () => {
  const fit = fitFrame('mobile', { width: 500.6, height: 400 });
  assert.deepEqual(fit, { scale: 1, width: 500, height: 400 });
});

test('the scale never makes the page wider than the box', () => {
  for (const width of [337, 351.5, 358, 389]) {
    const fit = fitFrame('tablet', { width, height: 600 });
    assert.ok(fit !== undefined);
    assert.ok(fit.width * fit.scale <= width, `width ${String(width)}`);
  }
});

test('a box not measured, hidden or broken gives no fit', () => {
  assert.equal(fitFrame('desktop', { width: 0, height: 500 }), undefined);
  assert.equal(fitFrame('desktop', { width: 320, height: 0 }), undefined);
  assert.equal(fitFrame('mobile', { width: Number.NaN, height: 500 }), undefined);
  assert.equal(fitFrame('mobile', { width: -10, height: 500 }), undefined);
});

test('the style carries size and scale, and hides a frame not fitted yet', () => {
  assert.deepEqual(fitStyle({ scale: 0.5, width: 820, height: 900 }), { width: '820px', height: '900px', transform: 'scale(0.5)' });
  assert.deepEqual(fitStyle(undefined), { visibility: 'hidden' });
});

test('a media query is heard at once and at each change, until stopped', () => {
  const listeners = new Set<() => void>();
  const media = {
    matches: true,
    addEventListener: (_type: 'change', listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: 'change', listener: () => void) => listeners.delete(listener),
  };
  const heard: boolean[] = [];
  const stop = followMedia(media, (matches) => heard.push(matches));
  media.matches = false;
  for (const listener of listeners) listener();
  stop();
  assert.equal(listeners.size, 0);
  assert.deepEqual(heard, [true, false]);
});

test('without a media query the window is not a phone', () => {
  const heard: boolean[] = [];
  followMedia(undefined, (matches) => heard.push(matches))();
  assert.deepEqual(heard, [false]);
});
