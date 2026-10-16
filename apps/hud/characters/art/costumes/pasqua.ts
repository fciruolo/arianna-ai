import { mirrored, shifted, type Costume, type CostumeLayer, type Part } from '../../compose.ts';

/**
 * Pasqua (D-246): bunny ears, white with pink inside, for both (the Coder's
 * antenna stays between them); Arianna in a pastel pink dress, the Coder
 * with a painted egg under the hand that hangs free.
 */
const EARS: Part = {
  top: 1,
  rows: ['....oo....oo....', '...oWWo..oWWo...', '...oWPo..oPWo...', '...oWPo..oPWo...', '...oWPo..oPWo...', '....oWo..oWo....', '....oWo..oWo....', '....oWo..oWo....'],
};
const EARS_BACK: Part = {
  top: 1,
  rows: ['....oo....oo....', '...oWWo..oWWo...', '...oWWo..oWWo...', '...oWWo..oWWo...', '...oWWo..oWWo...', '....oWo..oWo....', '....oWo..oWo....', '....oWo..oWo....'],
};
/** From the side the two ears are one behind the other, leaning back. */
const EARS_SIDE: Part = {
  top: 1,
  rows: ['..oo............', '.oWWo...........', '.oWPWo..........', '..oWPWo.........', '...oWPo.........', '....oWo.........', '....oWWo........', '.....oWo........'],
};
const PALETTE = { W: '#f4f1ec', P: '#f2a0b8' };

const ears = (part: Part): CostumeLayer => ({ name: 'ears', after: 'head', part });

export const ARIANNA_PASQUA: Costume = {
  theme: 'pasqua',
  recolor: { d: '#e89ac0', D: '#b8668f' },
  palette: PALETTE,
  layers: { down: [ears(EARS)], up: [ears(EARS_BACK)], right: [ears(EARS_SIDE)] },
};

/** The egg: pale blue with a pink band, under the hand. */
const EGG: Part = { top: 23, rows: ['.oo.............', 'oEEo............', 'oPPo............', 'oEEo............', '.oo.............'] };

export const CODER_PASQUA: Costume = {
  theme: 'pasqua',
  palette: { ...PALETTE, E: '#9cc9f2' },
  layers: {
    down: [ears(EARS), { name: 'egg', after: 'body', skip: ['body-type', 'body-read'], part: EGG }],
    up: [ears(EARS_BACK), { name: 'egg', after: 'body', skip: ['body-type', 'body-read'], part: mirrored(EGG) }],
    // From the side the hand is not drawn: the egg is carried in front of the body.
    right: [ears(shifted(EARS_SIDE, 1)), { name: 'egg', after: 'body', skip: ['body-type', 'body-read'], part: shifted({ top: 21, rows: EGG.rows }, 8) }],
  },
};
