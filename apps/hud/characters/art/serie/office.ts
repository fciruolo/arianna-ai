import type { CharacterArt } from '../../compose.ts';
import { backOf, manFace, manSide } from './heads.ts';
import { COMMON, person } from './person.ts';

/**
 * The people of the paper company of The Office, for the theme Ufficio
 * (D-211): fan art drawn by Claude for the user's personal use, in the pack
 * `serie`, to be removed (history of git included) before the repository is
 * shared.
 */

const MICHAEL_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhhhHhho...', '..ohhhhhhhHhho..', '..ohhhhhhhhhho..', ...manFace('...ossmmmmsso...')];

/** Michael Scott: dark short hair with a side parting, the big grin, a charcoal suit and a red tie. */
export const MICHAEL: CharacterArt = person({
  id: 'michael',
  palette: { ...COMMON, s: '#f0c4a0', S: '#cc9876', m: '#8a3a36', h: '#3a271c', H: '#5a3d2a', J: '#3b4152', K: '#2a2e3b', i: '#f1f3f5', t: '#a3333a', T: '#7a2329', n: '#3b4152', N: '#2a2e3b' },
  head: { down: MICHAEL_FRONT, up: backOf(MICHAEL_FRONT), right: manSide(undefined, '....osssssmmo...') },
  garment: { kind: 'suit' },
});

const DWIGHT_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhHHhhho...',
  '..ohhhhHHhhhho..',
  '..ohhhhhhhhhho..',
  '..ohgggssgggho..',
  '..ohGeGggGeGho..',
  '..oossssssssoo..',
  '...osssmmssso...',
  '....oossssoo....',
];

/** Dwight: brown hair parted in the middle with a straight fringe, glasses, a mustard short-sleeved shirt and a brown tie. */
export const DWIGHT: CharacterArt = person({
  id: 'dwight',
  palette: { ...COMMON, s: '#f2c8a4', S: '#cf9c78', m: '#a8584e', h: '#5a3d24', H: '#7a5634', g: '#2b2b33', G: '#cfdbe6', J: '#d6ad3a', K: '#a8842a', i: '#d6ad3a', t: '#6b4526', T: '#4d311b', n: '#5a4632', N: '#43342a' },
  head: {
    down: DWIGHT_FRONT,
    up: backOf(DWIGHT_FRONT),
    right: [...manSide(['.....oooo.......', '...oohhHhoo.....', '..ohhhhHhhhoo...', '..ohhhhhhhhhho..']).slice(0, 4), '..ohhhhhhhhhho..', '..ohhhhhhsssso..', '..ohhhSgggGeGo..', '...ohsssssssso..', '....osssssmso...', '.....ossssoo....'],
  },
  garment: { kind: 'shirt', short: true, tie: true },
});

const JIM_FRONT = ['.....ooooo......', '...oohhhhhoo....', '..ohhhhhHhhhoo..', '..ohhhhhhHhhhho.', '..ohhhhhhhhhhho.', ...manFace('...ossssmmsso...', undefined, '..ohsssssshhho..')];

/** Jim: floppy brown hair, a light blue shirt and a dark tie. */
export const JIM: CharacterArt = person({
  id: 'jim',
  palette: { ...COMMON, s: '#f2c8a2', S: '#cf9a76', m: '#a8584e', h: '#5c3b22', H: '#7d5432', J: '#a9cbea', K: '#7ea4c8', i: '#a9cbea', t: '#2f3e5c', T: '#1f2a40', n: '#4a4f5a', N: '#383c45' },
  head: {
    down: JIM_FRONT,
    up: backOf(JIM_FRONT),
    right: manSide(['.....ooooo......', '...oohhhhhoo....', '..ohhhhhhHhhoo..', '..ohhhhhhhhHhho.']),
  },
  garment: { kind: 'shirt', tie: true },
});

/** Pam: auburn hair pulled up in a bun, curls at the temples, a pink cardigan on a cream blouse, a grey skirt. */
export const PAM: CharacterArt = person({
  id: 'pam',
  palette: { ...COMMON, s: '#f4cfb0', S: '#d4a284', m: '#c0606a', p: '#eba39a', h: '#a65a32', H: '#c97c4c', r: '#7a3c1e', J: '#e7a6bd', K: '#c57f99', i: '#f3ead7', n: '#5e6278', N: '#4a4d60' },
  head: {
    down: [
      '......oooo......',
      '....oohHhhoo....',
      '...ohhhhhhhho...',
      '..ohhhhhhhhhho..',
      '..ohhsssssshho..',
      '..ohssssssssho..',
      '..ohsessssesho..',
      '..ohpsssssspho..',
      '...osssmmssso...',
      '....oossssoo....',
    ],
    up: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhhhhhho...',
      '..ohhhhrrhhhho..',
      '..ohhhrHHrhhho..',
      '..ohhhrhhrhhho..',
      '..ohhhhrrhhhho..',
      '..ohhhhhhhhhho..',
      '...ohhhhhhhho...',
      '....oossssoo....',
    ],
    right: [
      '.....oooo.......',
      '...oohhHhoo.....',
      '..ohhhHHhhho....',
      'oooohhhhhhhho...',
      'oHhohhhhhsssso..',
      'ohhohhhsssssso..',
      '.oooohhsssseso..',
      '....ohhssssspo..',
      '....osssssssmo..',
      '.....oossssso...',
    ],
  },
  garment: { kind: 'cardigan' },
  legs: 'skirt',
});
