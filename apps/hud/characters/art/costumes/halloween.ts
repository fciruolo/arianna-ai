import { mirrored, shifted, type Costume, type CostumeLayer, type Part } from '../../compose.ts';

/**
 * Halloween (D-246): the witch's hat, black with an orange band and the tip
 * bent, for both; Arianna in a purple dress, the Coder painted purple with
 * a jack-o'-lantern bucket in the hand that hangs free (not while it types
 * or reads, when the hands are busy).
 */
const HAT: Part = {
  top: 1,
  rows: [
    '.........oo.....',
    '........oPo.....',
    '.......oPVo.....',
    '......oPPo......',
    '......oPVPo.....',
    '.....oPPPVo.....',
    '.....oPPPPPo....',
    '....oUUUUUUo....',
    '.oPPPPPPPPPPPPo.',
  ],
};
const PALETTE = { P: '#2b2238', V: '#4a3a5e', U: '#e07b24' };

const hat = (part: Part): CostumeLayer => ({ name: 'hat', after: 'head', part });

export const ARIANNA_HALLOWEEN: Costume = {
  theme: 'halloween',
  recolor: { d: '#7a4fa8', D: '#553578' },
  palette: PALETTE,
  layers: {
    down: [hat(HAT)],
    up: [hat(mirrored(HAT))],
    right: [hat(shifted(HAT, -1))],
  },
};

/** The bucket: a pumpkin with a face and a handle, under the hand. */
const PUMPKIN: Part = { top: 23, rows: ['.oLo............', 'oUUUo...........', 'oJUJo...........', 'oUJUo...........', '.ooo............'] };

export const CODER_HALLOWEEN: Costume = {
  theme: 'halloween',
  recolor: { b: '#6b3f8f', B: '#4f2d6b' },
  palette: { ...PALETTE, J: '#3a2a10', L: '#3f7a3a' },
  layers: {
    down: [hat(HAT), { name: 'pumpkin', after: 'body', skip: ['body-type', 'body-read'], part: PUMPKIN }],
    up: [hat(mirrored(HAT)), { name: 'pumpkin', after: 'body', skip: ['body-type', 'body-read'], part: mirrored(PUMPKIN) }],
    // From the side the hand is not drawn: the bucket hangs in front of the body.
    right: [hat(HAT), { name: 'pumpkin', after: 'body', skip: ['body-type', 'body-read'], part: shifted({ top: 22, rows: PUMPKIN.rows }, 8) }],
  },
};
