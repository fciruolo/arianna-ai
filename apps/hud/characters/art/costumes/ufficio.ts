import type { Costume } from '../../compose.ts';

/**
 * Ufficio (D-103, the paper company of the series): Arianna in a pale shirt
 * with a navy tie and a badge on a lanyard, the Coder in a grey suit, white
 * collar and red tie. Variants of the original maps; from behind a tie is not
 * seen, so its part there is empty.
 */
const EMPTY = { top: 0, rows: [] };

export const ARIANNA_UFFICIO: Costume = {
  theme: 'ufficio',
  recolor: { d: '#dfe6ee', D: '#9fb0c2' },
  palette: { t: '#34466e', T: '#24304d', y: '#f2d16b' },
  layers: {
    down: [
      { name: 'tie-knot', after: 'body', part: { top: 18, rows: ['.......tt.......', '.......tt.......'] } },
      { name: 'tie', after: 'body', skip: ['body-read'], part: { top: 20, rows: ['......tTTt......', '......tTTt......', '.......tt.......'] } },
      { name: 'badge', after: 'body', skip: ['body-read', 'body-type'], part: { top: 21, rows: ['....y...........', '....y...........'] } },
    ],
    up: [
      { name: 'tie-knot', after: 'body', part: EMPTY },
      { name: 'tie', after: 'body', part: EMPTY },
      { name: 'badge', after: 'body', part: EMPTY },
    ],
    right: [
      { name: 'tie-knot', after: 'body', part: { top: 18, rows: ['.........t......'] } },
      { name: 'tie', after: 'body', skip: ['body-read'], part: { top: 19, rows: ['..........t.....', '..........t.....', '..........T.....', '..........T.....'] } },
      { name: 'badge', after: 'body', part: EMPTY },
    ],
  },
};

export const CODER_UFFICIO: Costume = {
  theme: 'ufficio',
  recolor: { b: '#5b6170', B: '#474c59' },
  palette: { t: '#b3362c', T: '#7f241d' },
  layers: {
    down: [{ name: 'tie', after: 'body', skip: ['body-read'], part: { top: 19, rows: ['......wttw......', '.......tt.......', '.......TT.......', '.......tt.......'] } }],
    up: [{ name: 'tie', after: 'body', part: EMPTY }],
    right: [{ name: 'tie', after: 'body', skip: ['body-read', 'body-type'], part: { top: 19, rows: ['..........w.....', '..........t.....', '..........T.....'] } }],
  },
};
