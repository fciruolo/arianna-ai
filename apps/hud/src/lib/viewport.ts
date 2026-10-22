/**
 * The page on the phone (D-293, tappa 1): the visible part of the window
 * follows the keyboard. iOS does not shrink the page when the keyboard opens:
 * it only shrinks and pans the visual viewport. Below `md` the app is pinned
 * to that visual viewport (style.css reads `--vv-height` and `--vv-top`), so
 * the field of the chat stays right above the keyboard. Pure parts here, the
 * listener in `watchViewport`.
 */

/** A drop of the visual viewport smaller than this is the browser's bars, not a keyboard (CSS pixels). */
export const KEYBOARD_MIN_PX = 120;

export interface ViewportSize {
  /** The height of the layout viewport (window.innerHeight before the keyboard, or documentElement.clientHeight). */
  layout: number;
  /** visualViewport.height */
  height: number;
  /** visualViewport.offsetTop: how far iOS panned the page up to keep the caret in view. */
  offsetTop: number;
}

/**
 * How much of the layout viewport the keyboard covers, 0 when it is closed or
 * the drop is only the browser's bars. The pan of iOS (offsetTop) does not
 * close the keyboard: it only moves what is visible (review of D-293).
 */
export function keyboardHeight(size: ViewportSize): number {
  if (!Number.isFinite(size.layout) || !Number.isFinite(size.height) || size.layout <= 0 || size.height <= 0) return 0;
  const covered = Math.round(size.layout - size.height);
  return covered >= KEYBOARD_MIN_PX ? covered : 0;
}

/** Whether the page is pinch zoomed (D-293 review): then the viewport is not followed. */
export function zoomed(scale: number | undefined): boolean {
  return scale !== undefined && Number.isFinite(scale) && Math.abs(scale - 1) > 0.01;
}

/** The values written on <html> for the CSS: the visible height and its top, in pixels, and whether the keyboard is open. */
export function viewportStyle(size: ViewportSize): { height: string; top: string; keyboard: boolean } {
  const height = Number.isFinite(size.height) && size.height > 0 ? Math.round(size.height) : Math.round(size.layout);
  const top = Number.isFinite(size.offsetTop) ? Math.max(0, Math.round(size.offsetTop)) : 0;
  return { height: `${String(height)}px`, top: `${String(top)}px`, keyboard: keyboardHeight(size) > 0 };
}

interface VisualViewportLike {
  height: number;
  offsetTop: number;
  /** The pinch zoom of the page; absent in old browsers. */
  scale?: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
}

interface RootLike {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  toggleAttribute(name: string, force: boolean): void;
}

/**
 * Follows the visual viewport and writes it on the root element; returns the
 * function that stops. The layout height is the largest seen without the
 * keyboard (iOS keeps window.innerHeight still while the keyboard is open,
 * other browsers shrink it). `onKeyboard` hears every change of open/closed.
 */
export function watchViewport(
  viewport: VisualViewportLike | null | undefined,
  root: RootLike,
  layoutHeight: () => number,
  onKeyboard?: (open: boolean) => void,
): () => void {
  if (viewport === null || viewport === undefined) return () => undefined;
  let open = false;
  let layout = layoutHeight();
  const update = (): void => {
    // A pinch zoom shrinks the visual viewport too: it is no keyboard, and the app keeps its size.
    if (zoomed(viewport.scale)) return;
    const size = { layout: Math.max(layout, layoutHeight()), height: viewport.height, offsetTop: viewport.offsetTop };
    const style = viewportStyle(size);
    if (!style.keyboard) layout = Math.max(layoutHeight(), Math.round(viewport.height));
    root.style.setProperty('--vv-height', style.height);
    root.style.setProperty('--vv-top', style.top);
    root.toggleAttribute('data-keyboard', style.keyboard);
    if (style.keyboard !== open) {
      open = style.keyboard;
      onKeyboard?.(open);
    }
  };
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    root.style.removeProperty('--vv-height');
    root.style.removeProperty('--vv-top');
    root.toggleAttribute('data-keyboard', false);
  };
}

/** The colour of the browser's bar (meta theme-color) for the background token of the page; a fallback when the token is unreadable. */
export function themeColorOf(value: string, fallback = '#0a1316'): string {
  const color = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
}
