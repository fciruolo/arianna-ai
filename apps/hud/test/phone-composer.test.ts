import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enterSends, phoneComposer } from '../src/lib/composer.ts';
import { longPress, longPressStarted, LONG_PRESS_MS, LONG_PRESS_SLOP } from '../src/lib/long-press.ts';

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    set: (callback: () => void) => {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    clear: (handle: unknown) => {
      pending.delete(handle as number);
    },
    runAll: () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

test('a still touch fires once and swallows the click of the lift', () => {
  const timers = fakeTimers();
  let fired = 0;
  const press = longPress(() => (fired += 1), timers);
  press.down({ pointerType: 'touch', clientX: 10, clientY: 10 });
  press.move({ pointerType: 'touch', clientX: 12, clientY: 13 });
  timers.runAll();
  press.up();
  assert.equal(fired, 1);
  assert.equal(press.consumeFired(), true);
  assert.equal(press.consumeFired(), false);
});

test('a moving touch, a mouse or an early lift fire nothing', () => {
  const timers = fakeTimers();
  let fired = 0;
  const press = longPress(() => (fired += 1), timers);
  press.down({ pointerType: 'touch', clientX: 10, clientY: 10 });
  press.move({ pointerType: 'touch', clientX: 10, clientY: 40 });
  timers.runAll();
  press.down({ pointerType: 'mouse', clientX: 0, clientY: 0 });
  timers.runAll();
  press.down({ pointerType: 'touch', clientX: 0, clientY: 0 });
  press.up();
  timers.runAll();
  assert.equal(fired, 0);
  assert.equal(press.consumeFired(), false);
});

test('Enter sends on a keyboard, Shift+Enter never', () => {
  assert.equal(enterSends({ key: 'Enter', shiftKey: false }, false), true);
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }, false), false);
  assert.equal(enterSends({ key: 'a', shiftKey: false }, false), false);
  // A word being composed (an accent, a suggestion) is never sent by its Enter.
  assert.equal(enterSends({ key: 'Enter', shiftKey: false, isComposing: true }, false), false);
});

test('on the phone the Enter of the keyboard goes to a new line', () => {
  assert.equal(enterSends({ key: 'Enter', shiftKey: false }, true), false);
});

test('the phone is a finger on a narrow screen', () => {
  const only = (...queries: string[]) => (query: string) => queries.includes(query);
  assert.equal(phoneComposer(only('(pointer: coarse)', '(width < 48rem)')), true);
  // An iPad: a finger on a wide screen keeps Enter to send.
  assert.equal(phoneComposer(only('(pointer: coarse)')), false);
  // A narrow window of the Mac.
  assert.equal(phoneComposer(only('(width < 48rem)')), false);
});

test('a long press starts after its time without moving', () => {
  assert.equal(longPressStarted({ elapsed: LONG_PRESS_MS, dx: 0, dy: 0 }), true);
  assert.equal(longPressStarted({ elapsed: LONG_PRESS_MS - 1, dx: 0, dy: 0 }), false);
  // A finger that scrolls the list is no long press.
  assert.equal(longPressStarted({ elapsed: LONG_PRESS_MS + 100, dx: 0, dy: LONG_PRESS_SLOP + 1 }), false);
  assert.equal(longPressStarted({ elapsed: LONG_PRESS_MS + 100, dx: 3, dy: 4 }), true);
});
