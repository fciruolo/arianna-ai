import { mirrored, shifted, type Costume, type CostumeLayer, type Part } from '../../compose.ts';

/**
 * Natale (D-246): the red cap with the white band and the pompon, the tip
 * falling to one side; Arianna also wears a green scarf. The same cap fits
 * the Coder: its band sits where Arianna's hair starts and the top of its
 * head, and it covers the antenna. From behind the tip falls to the other
 * side; from the side it falls backwards.
 */
const CAP: Part = {
  top: 2,
  rows: [
    '...........oo...',
    '..........oWWo..',
    '.........ooWWo..',
    '.......ooRRoo...',
    '......oRRRRRo...',
    '.....oRRRRRRo...',
    '....oRRRRRRQRo..',
    '..oWWWWWWWWWWo..',
    '..oXWWWWWWWWXo..',
  ],
};
const CAP_SIDE: Part = {
  top: 2,
  rows: [
    '..oo............',
    '.oWWo...........',
    '.oWWoo..........',
    '..ooRRoo........',
    '...oRRRRRo......',
    '...oRRRRRRo.....',
    '..oRQRRRRRRo....',
    '..oWWWWWWWWWo...',
    '..oXWWWWWWWXo...',
  ],
};
const PALETTE = { R: '#d23a32', Q: '#9c2420', W: '#f4f4f0', X: '#c9d0d6', L: '#2f8f4f', K: '#1f6438' };

const cap = (part: Part): CostumeLayer => ({ name: 'cap', after: 'head', part });

export const ARIANNA_NATALE: Costume = {
  theme: 'natale',
  palette: PALETTE,
  layers: {
    down: [
      cap(CAP),
      // The scarf round the neck, its end on the chest; the book of read covers the end.
      { name: 'scarf', after: 'body', part: { top: 17, rows: ['...oLLLLLLLLo...', '....oKLLLLKo....'] } },
      { name: 'scarf-end', after: 'body', skip: ['body-read', 'body-type'], part: { top: 19, rows: ['....oLo.........', '....oKo.........', '....oLo.........'] } },
    ],
    up: [cap(mirrored(CAP)), { name: 'scarf', after: 'body', part: { top: 17, rows: ['...oLLLLLLLLo...'] } }, { name: 'scarf-end', after: 'body', part: { top: 0, rows: [] } }],
    right: [
      cap(CAP_SIDE),
      { name: 'scarf', after: 'body', part: { top: 17, rows: ['.....oLLLLLo....', '......oKLLo.....'] } },
      // From the side the end hangs in front, hidden by the arm.
      { name: 'scarf-end', after: 'body', part: { top: 0, rows: [] } },
    ],
  },
};

export const CODER_NATALE: Costume = {
  theme: 'natale',
  palette: PALETTE,
  layers: {
    down: [cap(CAP)],
    up: [cap(mirrored(CAP))],
    right: [cap(shifted(CAP_SIDE, 1))],
  },
};
