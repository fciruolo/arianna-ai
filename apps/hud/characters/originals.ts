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
