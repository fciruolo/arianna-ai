/**
 * A long press on a row of the phone (D-293, tappa 3): the finger stays still
 * on a conversation and its actions open in a sheet, where the Mac shows
 * them on hover. The row also has a «⋯» button, so the actions never depend
 * on the gesture alone.
 */

/** How long the finger stays down, in milliseconds. */
export const LONG_PRESS_MS = 480;
/** How far it may move meanwhile, in CSS pixels: more is a scroll. */
export const LONG_PRESS_SLOP = 10;

export function longPressStarted(press: { elapsed: number; dx: number; dy: number }): boolean {
  if (Math.hypot(press.dx, press.dy) > LONG_PRESS_SLOP) return false;
  return press.elapsed >= LONG_PRESS_MS;
}

interface PointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

/**
 * Follows one touch on an element: `fire` after LONG_PRESS_MS unless the
 * finger moved or lifted. Returns the handlers to bind and whether the last
 * press fired, so the click that follows the lift is swallowed.
 */
export function longPress(fire: () => void, timers: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void }) {
  let handle: unknown;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const cancel = (): void => {
    if (handle !== undefined) timers.clear(handle);
    handle = undefined;
    start = null;
  };
  return {
    down(event: PointerLike): void {
      fired = false;
      if (event.pointerType !== 'touch') return;
      cancel();
      start = { x: event.clientX, y: event.clientY };
      handle = timers.set(() => {
        handle = undefined;
        start = null;
        fired = true;
        fire();
      }, LONG_PRESS_MS);
    },
    move(event: PointerLike): void {
      if (start === null) return;
      if (!longPressStarted({ elapsed: LONG_PRESS_MS, dx: event.clientX - start.x, dy: event.clientY - start.y })) cancel();
    },
    up(): void {
      cancel();
    },
    /** True once after a press that fired: the click of the lift opens nothing. */
    consumeFired(): boolean {
      const was = fired;
      fired = false;
      return was;
    },
  };
}
