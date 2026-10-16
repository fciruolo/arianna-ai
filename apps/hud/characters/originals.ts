import { join } from 'node:path';

import { ARIANNA } from './art/arianna.ts';
import { CODER } from './art/coder.ts';
import { ARIANNA_CORSIA, CODER_CORSIA } from './art/costumes/corsia.ts';
import { ARIANNA_UFFICIO, CODER_UFFICIO } from './art/costumes/ufficio.ts';
import { GOD } from './art/god.ts';
import { ANDY, ANGELA, CREED, DWIGHT, JIM, KEVIN, MICHAEL, OSCAR, PAM } from './art/serie/office.ts';
import { CARLA, COX, ELLIOT, JANITOR, JD, KELSO, LAVERNE, TED, TURK } from './art/serie/scrubs.ts';
import { dress, renderSheet, type CharacterArt } from './compose.ts';
import { encodePng } from './png.ts';

/** The pack of the original characters, in git: also the fallback when a pack in data/ is missing or invalid (D-060). */
export const PACK_DIR = join(import.meta.dirname, 'originali');
export const ORIGINALS: readonly CharacterArt[] = [ARIANNA, CODER, GOD];

/**
 * The costumes of the themes (D-103), sheets of their own in the same pack:
 * `<character>-<theme>`, with the name the chat shows. The test of the PNGs
 * covers them as the originals.
 */
export const COSTUMED: readonly { art: CharacterArt; name: string }[] = [
  { art: dress(ARIANNA, ARIANNA_CORSIA), name: 'Arianna · Scrubs' },
  { art: dress(CODER, CODER_CORSIA), name: 'Coder · Scrubs' },
  { art: dress(ARIANNA, ARIANNA_UFFICIO), name: 'Arianna · The Office' },
  { art: dress(CODER, CODER_UFFICIO), name: 'Coder · The Office' },
];

/** Every sheet of the pack `originali`, as pack.json lists them. */
export const SHEETS: readonly CharacterArt[] = [...ORIGINALS, ...COSTUMED.map(({ art }) => art)];

/**
 * The pack `serie` (D-211): the real people of the series of the themes,
 * fan art drawn by Claude for the user's personal use. In the repository by
 * the user's choice, in a folder of its own so it goes away whole (history
 * included) before the repository is shared.
 */
export const SERIES_DIR = join(import.meta.dirname, 'serie');
export const SERIES: readonly { art: CharacterArt; name: string }[] = [
  { art: JD, name: 'J.D.' },
  { art: TURK, name: 'Turk' },
  { art: ELLIOT, name: 'Elliot' },
  { art: CARLA, name: 'Carla' },
  { art: COX, name: 'Dr. Cox' },
  { art: KELSO, name: 'Dr. Kelso' },
  { art: JANITOR, name: 'Inserviente' },
  { art: TED, name: 'Ted' },
  { art: LAVERNE, name: 'Laverne' },
  { art: MICHAEL, name: 'Michael' },
  { art: DWIGHT, name: 'Dwight' },
  { art: JIM, name: 'Jim' },
  { art: PAM, name: 'Pam' },
  { art: OSCAR, name: 'Oscar' },
  { art: ANDY, name: 'Andy' },
  { art: KEVIN, name: 'Kevin' },
  { art: ANGELA, name: 'Angela' },
  { art: CREED, name: 'Creed' },
];

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
