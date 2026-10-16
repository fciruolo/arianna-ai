import type { CharacterArt } from '../../compose.ts';
import { backOf, manFace, manSide } from './heads.ts';
import { COMMON, person } from './person.ts';

/**
 * The family of Family Guy and their neighbour, for the theme Quahog
 * (D-238): fan art drawn by Claude for the user's personal use, in the pack
 * `serie`, to be removed (history of git included) before the repository is
 * shared. A list of its own, appended to `SERIES` of originals.ts.
 */

const PETER_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhhhHhho...',
  '..ohhhhhhhhhho..',
  '..ohssssssssho..',
  '..ogggssssgggo..',
  '..oGeGssssGeGo..',
  '..osssssssssso..',
  '..osssmmmmssso..',
  '...osssSSssso...',
];

/** Peter: short brown hair, round glasses, the big chin with its cleft, a white shirt open at the collar, green trousers. */
export const PETER: CharacterArt = person({
  id: 'peter',
  palette: { ...COMMON, s: '#f2c9a6', S: '#cf9e7c', m: '#8a3e38', h: '#4a3322', H: '#6a4a32', g: '#2b2b33', G: '#dfe8ee', J: '#f4f4f0', K: '#cfd2d4', i: '#f4f4f0', t: '#f2c9a6', T: '#cf9e7c', n: '#3f7a46', N: '#2f5e36' },
  head: {
    down: PETER_FRONT,
    up: backOf(PETER_FRONT),
    right: [...manSide().slice(0, 6), '..ohhhSgggGeGo..', '...ohsssssssso..', '....osssssmmo...', '....oosssssoo...'],
  },
  garment: { kind: 'shirt' },
});

/** Shoulder-length hair with its flip, front, back and side (Lois). */
const FLIP_HAIR = {
  down: ['.ohhho....ohhho.', '.oHho......ohHo.'],
  up: ['..ohhhhhhhhhho..', '.ohhhhhhhhhhhho.', '.oHhhhhhhhhhhHo.'],
  right: ['..ohhhhh........', '.ohhhhho........', '.oHhhoo.........'],
};

/** Lois: auburn red hair to the shoulders with the flip, a green blouse, tan trousers. */
export const LOIS: CharacterArt = person({
  id: 'lois',
  palette: { ...COMMON, s: '#f6d2b4', S: '#d6a68a', m: '#c0505a', p: '#efa79c', h: '#c4522a', H: '#e2763e', J: '#5aa46c', K: '#43865a', i: '#bfe3c4', t: '#f6d2b4', T: '#d6a68a', n: '#cdb68c', N: '#a8936c' },
  head: {
    down: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhHHhhho...',
      '..ohhhhHhhhhho..',
      '..ohhhssssshho..',
      '..ohssssssssho..',
      '..ohsessssesho..',
      '..ohpsssssspho..',
      '..ohsssmmsssho..',
      '..ohhossssohho..',
    ],
    up: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhHHhhho...',
      '..ohhhhHhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhHhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
    ],
    right: [
      '.....oooo.......',
      '...oohhHhoo.....',
      '..ohhhHHhhho....',
      '..ohhhhhhhhho...',
      '..ohhhhhhhssso..',
      '..ohhhhsssssso..',
      '..ohhhhsssseso..',
      '..ohhhhssssspo..',
      '..ohhhhsssssmo..',
      '..ohhhhhossso...',
    ],
  },
  garment: { kind: 'shirt' },
  hair: FLIP_HAIR,
});

/** Stewie: the head shaped like a rugby ball, a wisp of hair, a yellow shirt under red overalls. */
export const STEWIE: CharacterArt = person({
  id: 'stewie',
  palette: { ...COMMON, s: '#f6d6bc', S: '#d8ab90', m: '#a34a48', h: '#9c7a52', H: '#b8956a', J: '#c8372d', K: '#9c2a22', i: '#f2cf4a', t: '#f2cf4a', T: '#d6b032', n: '#c8372d', N: '#9c2a22' },
  head: {
    down: [
      '................',
      '.....oooooo.....',
      '...oohhhhhhoo...',
      '..osssssssssso..',
      '.osssssssssssso.',
      'osssssssssssssso',
      'osssessssssessso',
      '.osssssssssssso.',
      '..ossssmmsssso..',
      '...oossssssoo...',
    ],
    up: [
      '................',
      '.....oooooo.....',
      '...oohhhhhhoo...',
      '..ohhhhhhhhhho..',
      '.ohhhhhhhhhhhho.',
      'ohhhhhhhhhhhhhho',
      'ohhhhhhhhhhhhhho',
      '.ohhhhhhhhhhhho.',
      '..ohhhhhhhhhho..',
      '...oossssssoo...',
    ],
    right: [
      '................',
      '....oooooo......',
      '..oohhhhhhoo....',
      '.ossssssssssoo..',
      'osssssssssssssso',
      'osssssssssssssso',
      'ossssssssssesso.',
      '.osssssssssssso.',
      '..ossssssmmsso..',
      '...oosssssoo....',
    ],
  },
  garment: { kind: 'shirt', short: true },
});

/** Brian: a white dog with a black nose and his red collar, standing up like the others. */
export const BRIAN: CharacterArt = person({
  id: 'brian',
  palette: { ...COMMON, s: '#f7f5ef', S: '#c9c6bd', h: '#f7f5ef', H: '#e4e1d8', m: '#5a2e2e', x: '#1f1f26', J: '#f7f5ef', K: '#d9d6cd', i: '#f7f5ef', t: '#f7f5ef', T: '#d9d6cd', X: '#c8372d', n: '#f7f5ef', N: '#d9d6cd', k: '#c9c6bd' },
  head: {
    down: [
      '.oo..........oo.',
      '.oSo..oooo..oSo.',
      '.oSSoossssooSSo.',
      '..osssssssssso..',
      '..osssssssssso..',
      '..osssssssssso..',
      '..osesssssseso..',
      '..ossssxxsssso..',
      '...osssmmssso...',
      '....oossssoo....',
    ],
    up: [
      '.oo..........oo.',
      '.oSo..oooo..oSo.',
      '.oSSoohhhhooSSo.',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '...ohhhhhhhho...',
      '....oossssoo....',
    ],
    right: [
      '....oo..........',
      '...oSSo.........',
      '..oSSssoo.......',
      '..ossssssssoo...',
      '..osssssssssoo..',
      '..ossssssssssoo.',
      '..osssssssessxxo',
      '..ossssssssssso.',
      '...ossssssmmoo..',
      '....oosssso.....',
    ],
  },
  garment: { kind: 'shirt' },
  // The red collar round the neck, under the sheet when he reads.
  accessory: { down: ['....XXXXXXXX....'], up: ['....XXXXXXXX....'], right: ['.......XX.......'] },
});

/** Meg: the pink beanie, round glasses, brown hair to the chin, a pink shirt and jeans. */
export const MEG: CharacterArt = person({
  id: 'meg',
  palette: { ...COMMON, s: '#f6d0b0', S: '#d6a286', m: '#b85a62', h: '#6a4630', H: '#86603f', x: '#e58fb4', X: '#c86a92', g: '#3a3a44', G: '#e6eef2', J: '#f0a8c2', K: '#d488a6', i: '#f0a8c2', t: '#f6d0b0', T: '#d6a286', n: '#4a6fa5', N: '#3a5884' },
  head: {
    down: [
      '.....oooooo.....',
      '...ooxxxxxxoo...',
      '..oxxxxxxxxxxo..',
      '..oXXXXXXXXXXo..',
      '..ohssssssssho..',
      '..ohgggssgggho..',
      '..ohGeGssGeGho..',
      '..ohssssssssho..',
      '..ohsssmmsssho..',
      '..ohhossssohho..',
    ],
    up: [
      '.....oooooo.....',
      '...ooxxxxxxoo...',
      '..oxxxxxxxxxxo..',
      '..oXXXXXXXXXXo..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhHhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
    ],
    right: [
      '....oooooo......',
      '...oxxxxxxoo....',
      '..oxxxxxxxxxo...',
      '..oXXXXXXXXXXo..',
      '..ohhhhhhsssso..',
      '..ohhhhhssssso..',
      '..ohhhSgggGeGo..',
      '..ohhhssssssso..',
      '..ohhhsssssmso..',
      '..ohhooossssoo..',
    ],
  },
  garment: { kind: 'shirt', short: true },
});

const CHRIS_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhhHhhho...',
  '..ohhhhhhHhhho..',
  '..ohhhhhhhhhho..',
  '.osssssssssssso.',
  '.osssessssessso.',
  '.osssssssssssso.',
  '..osssmmmmssso..',
  '...oossssssoo...',
];

/** Chris: blond hair over the forehead, a big round face, a blue T-shirt and jeans. */
export const CHRIS: CharacterArt = person({
  id: 'chris',
  palette: { ...COMMON, s: '#f6cfae', S: '#d4a286', m: '#9a4a46', h: '#e2c45a', H: '#f2dc8a', J: '#3f6fb6', K: '#2f5694', i: '#3f6fb6', t: '#f6cfae', T: '#d4a286', n: '#4a5f86', N: '#3a4b6c' },
  head: {
    down: CHRIS_FRONT,
    up: backOf(CHRIS_FRONT),
    right: [
      '.....oooo.......',
      '...oohhhhoo.....',
      '..ohhhhhhhhoo...',
      '..ohhhhhhhhhho..',
      '..ohhhhhhsssso..',
      '.ohhhsssssssso..',
      '.ohhhSsssssesso.',
      '.oSssssssssssso.',
      '..ossssssssmso..',
      '...oosssssooo...',
    ],
  },
  garment: { kind: 'shirt', short: true },
});

const CLEVELAND_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhhhhhho...', '..ohhsssssshho..', '..ohssssssssho..', ...manFace('...oShhhhhhSo...', '..ossessssesso..', '..osssssssssso..')];

/** Cleveland: short black hair, a thick moustache, a tan cardigan over a white shirt, grey trousers. */
export const CLEVELAND: CharacterArt = person({
  id: 'cleveland',
  palette: { ...COMMON, s: '#8a5a3c', S: '#6a4229', m: '#4a2a1e', h: '#1f1915', H: '#3a302a', J: '#c9a46a', K: '#a8854e', i: '#f1f3f5', n: '#5e6168', N: '#4a4c52' },
  head: {
    down: CLEVELAND_FRONT,
    up: backOf(CLEVELAND_FRONT),
    right: manSide(undefined, '....osssshhho...'),
  },
  garment: { kind: 'cardigan' },
});

/** The people of Family Guy in the pack `serie`, with the name the chat shows. */
export const GRIFFIN: readonly { art: CharacterArt; name: string }[] = [
  { art: LOIS, name: 'Lois' },
  { art: PETER, name: 'Peter' },
  { art: STEWIE, name: 'Stewie' },
  { art: BRIAN, name: 'Brian' },
  { art: MEG, name: 'Meg' },
  { art: CHRIS, name: 'Chris' },
  { art: CLEVELAND, name: 'Cleveland' },
];
