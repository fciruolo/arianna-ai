import { join } from 'node:path';

import { ARIANNA } from './art/arianna.ts';
import { CODER } from './art/coder.ts';
import { renderSheet, type CharacterArt } from './compose.ts';
import { encodePng } from './png.ts';

/** The pack of the original characters, in git: also the fallback when a pack in data/ is missing or invalid (D-060). */
export const PACK_DIR = join(import.meta.dirname, 'originali');
export const ORIGINALS: readonly CharacterArt[] = [ARIANNA, CODER];

export function sheetPng(art: CharacterArt): Buffer {
  const { width, height, rgba } = renderSheet(art);
  return encodePng(width, height, rgba);
}

/** Where the icon of the notifications lives (I-1): served by the chat as /notification-icon.png. */
export const NOTIFICATION_ICON = join(import.meta.dirname, '..', 'public', 'notification-icon.png');

/** The icon of the notifications (I-1): the head of Arianna ×14, 256×256. */
export function notificationIconPng(): Buffer {
  return headIconPng(256, 14);
}

/**
 * The icons of the chat installed as an app (D-126, public/manifest.webmanifest):
 * the same head at the sizes Chrome asks for. The maskable one keeps the head
 * inside the safe circle of maskable icons (80% of the side), so no mask cuts it.
 */
export const APP_ICONS: readonly { file: string; size: number; scale: number; purpose: 'any' | 'maskable' }[] = [
  { file: 'icon-192.png', size: 192, scale: 11, purpose: 'any' },
  { file: 'icon-512.png', size: 512, scale: 28, purpose: 'any' },
  { file: 'icon-maskable-512.png', size: 512, scale: 18, purpose: 'maskable' },
];

/** A file of public/, served by the chat at its root. */
export function publicPath(file: string): string {
  return join(import.meta.dirname, '..', 'public', file);
}

/**
 * The head of Arianna, 16×16 of her first frame from the top of her hair,
 * ×scale and centred on the dark surface of the chat, size×size.
 */
export function headIconPng(size: number, scale: number): Buffer {
  if (size < 16 * scale || (size - 16 * scale) % 2 !== 0) throw new Error(`headIconPng: ${String(size)} cannot centre 16×${String(scale)}`);
  const { width, rgba } = renderSheet(ARIANNA);
  // The first row with a pixel of hers, one row of air above: the frame is 32 tall and she stands at the bottom.
  let top = 0;
  while (top < 31 && ![...Array(16).keys()].some((x) => (rgba[(top * width + x) * 4 + 3] ?? 0) > 0)) top += 1;
  top = Math.max(0, top - 1);
  const pad = (size - 16 * scale) / 2;
  const surface = [0x0e, 0x1b, 0x1f];
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x - pad) / scale);
      const sy = Math.floor((y - pad) / scale);
      const inside = sx >= 0 && sx < 16 && sy >= 0 && sy < 16;
      const at = ((sy + top) * width + sx) * 4;
      const alpha = inside ? (rgba[at + 3] ?? 0) / 255 : 0;
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        out[target + channel] = Math.round((inside ? (rgba[at + channel] ?? 0) : 0) * alpha + (surface[channel] ?? 0) * (1 - alpha));
      }
      out[target + 3] = 255;
    }
  }
  return encodePng(size, size, out);
}
