import { type Costume, type CostumeLayer, type Part } from '../../compose.ts';

/**
 * Carnevale (D-246): Arianna in a violet dress with a gold mask over the
 * eyes and a magenta feather; the mask shows her eyes through its holes,
 * closed when she sleeps. The Coder wears a striped party cone with a
 * pompon, over the antenna, and confetti on the chest.
 */
const FEATHER = ['..............F.', '.............FF.', '.............F..', '............FF..'];

const MASK: Part = { top: 8, rows: [...FEATHER, '...ZYYYYYYYYZ...', '...YYeYYYYeYY...', '....ZYY..YYZ....'] };
const MASK_SLEEP: Part = { top: 8, rows: [...FEATHER, '...ZYYYYYYYYZ...', '...YYSYYYYSYY...', '....ZYY..YYZ....'] };
const MASK_SIDE: Part = { top: 8, rows: [...FEATHER, '.......ZYYYYY...', '......YYYYYeYY..', '.......ZYYYZ....'] };
const MASK_SIDE_BLINK: Part = { top: 8, rows: [...FEATHER, '.......ZYYYYY...', '......YYYYYSYY..', '.......ZYYYZ....'] };
/** From behind: the ribbon round the head and the feather on the other side. */
const MASK_BACK: Part = { top: 8, rows: ['.F..............', '.FF.............', '..F.............', '..FF............', '................', '..ZZZZZZZZZZZZ..'] };

export const ARIANNA_CARNEVALE: Costume = {
  theme: 'carnevale',
  recolor: { d: '#8a52c4', D: '#5f3590' },
  palette: { Y: '#f2c14e', Z: '#b8862a', F: '#d0457f' },
  layers: {
    down: [
      { name: 'mask', after: 'head', skip: ['head-sleep', 'head-blink'], part: MASK },
      { name: 'mask-closed', after: 'head', only: ['head-sleep', 'head-blink'], part: MASK_SLEEP },
    ],
    up: [
      { name: 'mask', after: 'head', part: MASK_BACK },
      { name: 'mask-closed', after: 'head', part: { top: 0, rows: [] } },
    ],
    right: [
      { name: 'mask', after: 'head', skip: ['head-blink'], part: MASK_SIDE },
      { name: 'mask-closed', after: 'head', only: ['head-blink'], part: MASK_SIDE_BLINK },
    ],
  },
};

const CONE: Part = {
  top: 1,
  rows: ['.......WW.......', '.......WW.......', '.......oo.......', '......oYZo......', '......oZYo......', '.....oYZYZo.....', '.....oZYZYo.....', '....oYZYZYZo....'],
};
const cone = (part: Part): CostumeLayer => ({ name: 'cone', after: 'head', part });
const CONFETTI: Part = { top: 19, rows: ['.....Z..........', '..........Y.....', '........E.......'] };

export const CODER_CARNEVALE: Costume = {
  theme: 'carnevale',
  palette: { Y: '#f2c14e', Z: '#d0457f', W: '#f4f4f0', E: '#7fc4f0' },
  layers: {
    down: [cone(CONE), { name: 'confetti', after: 'body', skip: ['body-read', 'body-type'], part: CONFETTI }],
    up: [cone(CONE), { name: 'confetti', after: 'body', skip: ['body-read', 'body-type'], part: { top: 19, rows: ['......Z.........', '.........Y......', '.......E........'] } }],
    right: [cone(CONE), { name: 'confetti', after: 'body', skip: ['body-read', 'body-type'], part: { top: 19, rows: ['......Z.........', '.........Y......', '.......E........'] } }],
  },
};
