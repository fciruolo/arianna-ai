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

const OSCAR_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhhhhHho...',
  '..ohhhhhhhhhho..',
  '..ohhsssssshho..',
  '..ohssssssssho..',
  '..ohsessssesho..',
  '..ooSssssssSoo..',
  '...oSssmmssSo...',
  '....ooSSSSoo....',
];

/** Oscar: short black hair, a trimmed dark beard on the jaw, a lavender shirt and a dark tie. */
export const OSCAR: CharacterArt = person({
  id: 'oscar',
  palette: { ...COMMON, s: '#cf9d76', S: '#5a4234', m: '#7a3a34', h: '#1f1915', H: '#3a302a', J: '#b8a6d6', K: '#9482b6', i: '#b8a6d6', t: '#33334f', T: '#24243a', n: '#3a3d46', N: '#2c2e35' },
  head: {
    down: OSCAR_FRONT,
    up: backOf(OSCAR_FRONT),
    right: [...manSide().slice(0, 7), '...ohssssssSSo..', '....oSsssSmSo...', '.....oSSSSoo....'],
  },
  garment: { kind: 'shirt', tie: true },
});

const ANDY_FRONT = ['......ooooo.....', '....oohhHHhoo...', '...ohhhhHHhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', ...manFace('...ossmmmmsso...', undefined, '..ohhsssssssho..')];

/** Andy: sandy hair with a side quiff, the big grin, a navy blazer on a pink shirt and a green tie. */
export const ANDY: CharacterArt = person({
  id: 'andy',
  palette: { ...COMMON, s: '#f3cba8', S: '#d09c7c', m: '#9a4440', h: '#9a7444', H: '#c29a62', J: '#2f4a7c', K: '#22375e', i: '#f2c2cc', t: '#3f7a4a', T: '#2c5a36', n: '#c9b88e', N: '#a8976e' },
  head: {
    down: ANDY_FRONT,
    up: backOf(ANDY_FRONT),
    right: manSide(['.....ooooo......', '...oohhHHhoo....', '..ohhhhHHhhhoo..', '..ohhhhhhhhhhho.'], '....osssssmmo...'),
  },
  garment: { kind: 'suit' },
});

const KEVIN_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhhhhhho...',
  '..ohhsssssshho..',
  '..osssssssssso..',
  '.osssssssssssso.',
  '.osssessssessso.',
  '.osssssssssssso.',
  '..osssmmmmssso..',
  '...oossssssoo...',
];

/** Kevin: thinning hair over a high forehead, a big round face, a tan shirt and a brown tie. */
export const KEVIN: CharacterArt = person({
  id: 'kevin',
  palette: { ...COMMON, s: '#f0c49e', S: '#cc9876', m: '#8a3e38', h: '#5e4634', H: '#7a5e48', J: '#d6c6a2', K: '#b5a47e', i: '#d6c6a2', t: '#7a4a2a', T: '#59341c', n: '#4a4d58', N: '#383a43' },
  head: {
    down: KEVIN_FRONT,
    up: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhhhhhho...',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '.ohhhhhhhhhhhho.',
      '.ohhhhhhhhhhhho.',
      '.ohhhhhhhhhhhho.',
      '..ohhhhhhhhhho..',
      '...oossssssoo...',
    ],
    right: [
      '.....oooo.......',
      '...oohhhhoo.....',
      '..ohhhhhsssso...',
      '..ohhhssssssso..',
      '..ohhssssssssso.',
      '.ohhhssssssssso.',
      '.ohhhSsssssesso.',
      '.oSssssssssssso.',
      '..ossssssssmso..',
      '...oosssssooo...',
    ],
  },
  garment: { kind: 'shirt', tie: true },
});

/** Angela: blonde hair pulled back in a tight bun, a prim small mouth, a butter cardigan on a white blouse, a brown skirt. */
export const ANGELA: CharacterArt = person({
  id: 'angela',
  palette: { ...COMMON, s: '#f6d4b8', S: '#d6a88a', m: '#b85a62', p: '#efb0a6', h: '#e2c068', H: '#f2da98', r: '#b38f3c', J: '#ece0b0', K: '#c9bb88', i: '#fbfaf5', n: '#6e5a48', N: '#584736' },
  head: {
    down: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhHHhhho...',
      '..ohhhhHhhhhho..',
      '..ohssssssssho..',
      '..ohssssssssho..',
      '..ohsessssesho..',
      '..oossssssssoo..',
      '...osssmsssso...',
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
      '....ohsssssspo..',
      '....osssssssmo..',
      '.....oossssso...',
    ],
  },
  garment: { kind: 'cardigan' },
  legs: 'skirt',
});

const CREED_FRONT = ['.....oooooo.....', '...oohhhhhhoo...', '..ohhhHhhHhhho..', '..ohhhhhhhhhho..', '..ohhsssssshho..', ...manFace('...ossssmmsso...')];

/** Creed: grey hair swept back, a weathered face with a sly half smile, a white shirt and a plum tie. */
export const CREED: CharacterArt = person({
  id: 'creed',
  palette: { ...COMMON, s: '#e4b48e', S: '#bd8a66', m: '#8a4a40', h: '#b9b7ae', H: '#dedcd4', J: '#e6e9ec', K: '#bfc6cd', i: '#e6e9ec', t: '#5c3858', T: '#43273f', n: '#565a60', N: '#43464b' },
  head: {
    down: CREED_FRONT,
    up: backOf(CREED_FRONT),
    right: manSide(['.....ooooo......', '...oohhHhhoo....', '..ohhhhhhHhhoo..', '..ohhhhhhhhhhho.'], '....ossssmmso...'),
  },
  garment: { kind: 'shirt', tie: true },
});
