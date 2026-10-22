import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KEYBOARD_MIN_PX, keyboardHeight, themeColorOf, viewportStyle, watchViewport, zoomed } from '../src/lib/viewport.ts';

test('the keyboard covers what the visual viewport lost', () => {
  assert.equal(keyboardHeight({ layout: 844, height: 508, offsetTop: 0 }), 336);
  // iOS panned the page up to show a field low in the page: the keyboard is still open.
  assert.equal(keyboardHeight({ layout: 844, height: 508, offsetTop: 40 }), 336);
  assert.equal(keyboardHeight({ layout: 844, height: 508, offsetTop: 336 }), 336);
});

test('a small drop is the browser bars, not a keyboard', () => {
  assert.equal(keyboardHeight({ layout: 844, height: 844, offsetTop: 0 }), 0);
  assert.equal(keyboardHeight({ layout: 844, height: 844 - KEYBOARD_MIN_PX + 1, offsetTop: 0 }), 0);
  assert.equal(keyboardHeight({ layout: 0, height: 500, offsetTop: 0 }), 0);
  assert.equal(keyboardHeight({ layout: Number.NaN, height: 500, offsetTop: 0 }), 0);
});

test('the style gives the visible height and top in pixels', () => {
  assert.deepEqual(viewportStyle({ layout: 844, height: 507.6, offsetTop: 12.2 }), { height: '508px', top: '12px', keyboard: true });
  assert.deepEqual(viewportStyle({ layout: 844, height: 844, offsetTop: -3 }), { height: '844px', top: '0px', keyboard: false });
  // An unreadable visual height falls back to the layout.
  assert.deepEqual(viewportStyle({ layout: 700, height: 0, offsetTop: 0 }), { height: '700px', top: '0px', keyboard: false });
});

function fakeViewport(height: number) {
  const listeners = new Set<() => void>();
  return {
    height,
    offsetTop: 0,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    fire: () => {
      for (const listener of listeners) listener();
    },
    count: () => listeners.size,
  };
}

function fakeRoot() {
  const props = new Map<string, string>();
  const attrs = new Set<string>();
  return {
    props,
    attrs,
    style: { setProperty: (name: string, value: string) => props.set(name, value), removeProperty: (name: string) => props.delete(name) },
    toggleAttribute: (name: string, force: boolean) => (force ? attrs.add(name) : attrs.delete(name)),
  };
}

test('watchViewport writes the root, hears the keyboard and stops clean', () => {
  const viewport = fakeViewport(844);
  const root = fakeRoot();
  const heard: boolean[] = [];
  const stop = watchViewport(viewport, root, () => 844, (open) => heard.push(open));
  assert.equal(root.props.get('--vv-height'), '844px');
  assert.equal(root.attrs.has('data-keyboard'), false);
  viewport.height = 508;
  viewport.fire();
  assert.equal(root.props.get('--vv-height'), '508px');
  assert.equal(root.attrs.has('data-keyboard'), true);
  viewport.height = 844;
  viewport.fire();
  assert.deepEqual(heard, [true, false]);
  stop();
  assert.equal(viewport.count(), 0);
  assert.equal(root.props.has('--vv-height'), false);
  assert.equal(root.attrs.has('data-keyboard'), false);
});

test('without a visual viewport nothing is watched', () => {
  const root = fakeRoot();
  const stop = watchViewport(undefined, root, () => 800);
  stop();
  assert.equal(root.props.size, 0);
});

test('the theme colour takes only a hex token', () => {
  assert.equal(themeColorOf(' #f5f4f0 '), '#f5f4f0');
  assert.equal(themeColorOf('rgb(1,2,3)'), '#0a1316');
  assert.equal(themeColorOf('', '#000'), '#000');
});

test('a pinch zoom is no keyboard and leaves the app as it was', () => {
  assert.equal(zoomed(undefined), false);
  assert.equal(zoomed(1), false);
  assert.equal(zoomed(1.6), true);
  const viewport = fakeViewport(844);
  const root = fakeRoot();
  const heard: boolean[] = [];
  const stop = watchViewport(viewport, root, () => 844, (open) => heard.push(open));
  Object.assign(viewport, { height: 420, offsetTop: 200, scale: 2 });
  viewport.fire();
  assert.equal(root.props.get('--vv-height'), '844px');
  assert.equal(root.attrs.has('data-keyboard'), false);
  assert.deepEqual(heard, []);
  stop();
});
