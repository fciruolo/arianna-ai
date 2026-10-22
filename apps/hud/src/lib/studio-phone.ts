// The Studio on the phone (D-293): below `md` one side at a time («Chat» or
// «Anteprima») and the mockup drawn at the width of its view, then scaled
// down to the width of the screen, so a desktop page is seen whole instead
// of squeezed into 360 pixels. Pure parts here; the components hold the
// listener and the measure.
import type { StudioView } from './studio.ts';

/** The phone of the chat: the same edge as the `phone:` variant of style.css (below 48rem). */
export const PHONE_QUERY = '(max-width: 47.98rem)';

/** The width each view draws the page at on the phone; the desktop has no width of its own on a big screen. */
export const PHONE_PAGE_WIDTH: Record<StudioView, number> = { desktop: 1280, tablet: 820, mobile: 390 };

/** The view the Studio opens with: the mobile one on the phone, where it fits without shrinking much. */
export function initialView(phone: boolean): StudioView {
  return phone ? 'mobile' : 'desktop';
}

export interface FrameFit {
  /** How much the page shrinks (at most 1: a page narrower than the box is not enlarged). */
  scale: number;
  /** The frame's own size in CSS pixels, before the scale. */
  width: number;
  height: number;
}

/**
 * The frame of a view fitted in a box of this size: drawn at the view's
 * width and scaled to the box's width, as tall as the box once scaled.
 * Undefined for a box not measured yet (or hidden).
 */
export function fitFrame(view: StudioView, box: { width: number; height: number }): FrameFit | undefined {
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return undefined;
  const page = PHONE_PAGE_WIDTH[view];
  const scale = Math.min(1, Math.floor((box.width / page) * 10_000) / 10_000);
  const width = scale === 1 ? Math.floor(box.width) : page;
  return { scale, width, height: Math.floor(box.height / scale) };
}

/** The inline style of a fitted frame: its own size and the scale from its top left corner. */
export function fitStyle(fit: FrameFit | undefined): Record<string, string> {
  if (fit === undefined) return { visibility: 'hidden' };
  return { width: `${String(fit.width)}px`, height: `${String(fit.height)}px`, transform: `scale(${String(fit.scale)})` };
}

interface MediaLike {
  matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** Hears a media query now and at every change; returns the function that stops. */
export function followMedia(media: MediaLike | undefined, onChange: (matches: boolean) => void): () => void {
  if (media === undefined) {
    onChange(false);
    return () => undefined;
  }
  const listener = (): void => {
    onChange(media.matches);
  };
  listener();
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

/** Whether the window is a phone now (false outside a browser). */
export function phoneNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/** The media query of the phone, or undefined outside a browser. */
export function phoneMedia(): MediaLike | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : undefined;
}
