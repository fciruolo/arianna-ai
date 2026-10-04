// Usage: node apps/hud/characters/build.ts [--preview]
// Writes the sheets of the original characters (D-060) into
// apps/hud/characters/originali/, from the pixel maps in art/. With --preview
// it also writes 8× enlargements on a checkerboard into data/characters-preview/,
// out of git, to look at the art.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ORIGINALS, PACK_DIR, sheetPng } from './originals.ts';
import { encodePng } from './png.ts';
import { renderSheet, type CharacterArt } from './compose.ts';

const SCALE = 8;

function preview(art: CharacterArt): Buffer {
  const { width, height, rgba } = renderSheet(art);
  const big = { width: width * SCALE, height: height * SCALE };
  const out = new Uint8Array(big.width * big.height * 4);
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const sx = Math.floor(x / SCALE);
      const sy = Math.floor(y / SCALE);
      const at = (sy * width + sx) * 4;
      const edge = (sx % 16 === 0 && x % SCALE === 0) || (sy % 32 === 0 && y % SCALE === 0);
      const background = edge ? 90 : (sx + sy) % 2 === 0 ? 200 : 185;
      const alpha = (rgba[at + 3] ?? 0) / 255;
      const target = (y * big.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        out[target + channel] = Math.round((rgba[at + channel] ?? 0) * alpha + background * (1 - alpha));
      }
      out[target + 3] = 255;
    }
  }
  return encodePng(big.width, big.height, out);
}

const home = join(import.meta.dirname, '..', '..', '..');
for (const art of ORIGINALS) {
  writeFileSync(join(PACK_DIR, `${art.id}.png`), sheetPng(art));
  console.log(`Written ${art.id}.png`);
}
if (process.argv.includes('--preview')) {
  const dir = join(home, 'data', 'characters-preview');
  mkdirSync(dir, { recursive: true });
  for (const art of ORIGINALS) writeFileSync(join(dir, `${art.id}.png`), preview(art));
  console.log('Previews in data/characters-preview/');
}
