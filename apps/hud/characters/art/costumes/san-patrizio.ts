import { shifted, type Costume, type CostumeLayer, type Part } from '../../compose.ts';

/**
 * San Patrizio (D-246): the green top hat with a dark band and a gold
 * buckle, a shamrock on the front; Arianna in an emerald dress, the Coder
 * painted green. The hat covers the Coder's antenna.
 */
const HAT: Part = {
  top: 1,
  rows: [
    '....oooooooo....',
    '....oLLLLLLo....',
    '....oLLTLLLo....',
    '....oLTLTLLo....',
    '....oLLKLLLo....',
    '....oLLLLLLo....',
    '....oKKYYKKo....',
    '..ooLLLLLLLLoo..',
    '..oKKKKKKKKKKo..',
  ],
};
/** From behind, no buckle and no shamrock. */
const HAT_BACK: Part = {
  top: 1,
  rows: [
    '....oooooooo....',
    '....oLLLLLLo....',
    '....oLLLLLLo....',
    '....oLLLLLLo....',
    '....oLLLLLLo....',
    '....oLLLLLLo....',
    '....oKKKKKKo....',
    '..ooLLLLLLLLoo..',
    '..oKKKKKKKKKKo..',
  ],
};
const HAT_SIDE: Part = {
  top: 1,
  rows: [
    '...oooooooo.....',
    '...oLLLLLLo.....',
    '...oLLLLLLo.....',
    '...oLLLLLLo.....',
    '...oLLLLLLo.....',
    '...oLLLLLLo.....',
    '...oKKKKKYo.....',
    '.ooLLLLLLLLLoo..',
    '.oKKKKKKKKKKKo..',
  ],
};
const PALETTE = { L: '#2e9e44', K: '#1e6e2e', Y: '#f2c14e', T: '#d8f5d0' };

const hat = (part: Part): CostumeLayer => ({ name: 'hat', after: 'head', part });

export const ARIANNA_SAN_PATRIZIO: Costume = {
  theme: 'san-patrizio',
  recolor: { d: '#3aa856', D: '#1e6e2e' },
  palette: PALETTE,
  layers: { down: [hat(HAT)], up: [hat(HAT_BACK)], right: [hat(HAT_SIDE)] },
};

export const CODER_SAN_PATRIZIO: Costume = {
  theme: 'san-patrizio',
  recolor: { b: '#3aa856', B: '#1e6e2e' },
  palette: PALETTE,
  layers: { down: [hat(HAT)], up: [hat(HAT_BACK)], right: [hat(shifted(HAT_SIDE, 1))] },
};
