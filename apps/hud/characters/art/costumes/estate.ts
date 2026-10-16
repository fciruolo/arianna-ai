import { shifted, type Costume, type CostumeLayer, type Part } from '../../compose.ts';

/**
 * Estate (D-246): the straw hat with a red band and a wide brim for both;
 * Arianna also wears dark sunglasses (a row higher when she looks up, so
 * they stay on her eyes) and a sky-blue dress, the Coder a coral body.
 */
const HAT: Part = {
  top: 4,
  rows: ['.....oooooo.....', '....oYYYYYYo....', '....oYYJYYYo....', '....oRRRRRRo....', '.oYYYYYYYYYYYYo.', '..oJJJJJJJJJJo..'],
};
const HAT_SIDE: Part = {
  top: 4,
  rows: ['....oooooo......', '...oYYYYYYo.....', '...oYYJYYYo.....', '...oRRRRRRo.....', 'oYYYYYYYYYYYYYo.', '.oJJJJJJJJJJJo..'],
};
const PALETTE = { Y: '#e8c66a', J: '#b8923e', R: '#d23a32' };

const hat = (part: Part): CostumeLayer => ({ name: 'hat', after: 'head', part });

const GLASSES: Part = { top: 13, rows: ['...nNnnnnNnnn...', '....nnn..nnn....'] };
const GLASSES_SIDE: Part = { top: 13, rows: ['......nnnnNnn...', '..........nnn...'] };

export const ARIANNA_ESTATE: Costume = {
  theme: 'estate',
  recolor: { d: '#4fb3e0', D: '#2f7fa8' },
  palette: { ...PALETTE, n: '#141414', N: '#3a5a80' },
  layers: {
    down: [
      hat(HAT),
      { name: 'glasses', after: 'head', skip: ['head-up'], part: GLASSES },
      { name: 'glasses-up', after: 'head', only: ['head-up'], part: { top: 12, rows: GLASSES.rows } },
    ],
    up: [hat(HAT), { name: 'glasses', after: 'head', part: { top: 0, rows: [] } }, { name: 'glasses-up', after: 'head', part: { top: 0, rows: [] } }],
    right: [hat(HAT_SIDE), { name: 'glasses', after: 'head', part: GLASSES_SIDE }, { name: 'glasses-up', after: 'head', part: { top: 0, rows: [] } }],
  },
};

export const CODER_ESTATE: Costume = {
  theme: 'estate',
  recolor: { b: '#e8794a', B: '#b85a33' },
  palette: PALETTE,
  layers: { down: [hat(HAT)], up: [hat(HAT)], right: [hat(shifted(HAT_SIDE, 1))] },
};
