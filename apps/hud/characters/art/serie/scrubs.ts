import type { CharacterArt } from '../../compose.ts';
import { backOf, manFace, manSide } from './heads.ts';
import { COMMON, person, type Rows } from './person.ts';

/**
 * The doctors and the nurse of Scrubs, for the theme Corsia (D-211): fan
 * art drawn by Claude for the user's personal use, in the pack `serie`, to
 * be removed (history of git included) before the repository is shared.
 */

/** A stethoscope round the neck, front and side. */
const STETHOSCOPE = {
  down: ['................', '......x..x......', '......x..x......', '.......xX.......'],
  up: [],
  right: ['................', '................', '.........x......', '.........X......'],
};

/** Long hair down to the shoulders, front, back and side (Carla, Elliot). */
const LONG_HAIR = {
  down: ['..ohhho..ohhho..', '..ohho....ohho..'],
  up: ['..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '...ohhhhhhhho...', '....ohhhhhho....'],
  right: ['..ohhhhh........', '..ohhhho........', '..ohhho.........', '...oho..........'],
};

/** A woman's head with long hair: the fringe on rows 3–5, the rest shared. */
function womanHead(fringe: readonly [string, string, string]): { down: Rows; up: Rows; right: Rows } {
  const down = [
    '......oooo......',
    '....oohhhhoo....',
    '...ohhhHHhhho...',
    ...fringe,
    '..ohsessssesho..',
    '..ohpsssssspho..',
    '..ohsssmmsssho..',
    '..ohhossssohho..',
  ];
  const up = [
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
  ];
  const right = [
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
  ];
  return { down, up, right };
}

const JD_FRONT = ['.....oo.oo.o....', '....ohhohhoho...', '...ohhhhHhhhho..', '..ohhHhhhhhhho..', '..ohhhhhhhhhho..', ...manFace(undefined, undefined, '..ohssshssssho..')];

/** J.D.: messy brown hair, light blue scrubs, the stethoscope round the neck. */
export const JD: CharacterArt = person({
  id: 'jd',
  palette: { ...COMMON, s: '#f2c8a2', S: '#cf9a76', m: '#a8584e', h: '#6b4a2e', H: '#8f6844', J: '#8cc4ea', K: '#5f98c4', n: '#8cc4ea', N: '#5f98c4', x: '#5d6670', X: '#c8d0d8' },
  head: {
    down: JD_FRONT,
    up: backOf(JD_FRONT),
    right: manSide(['.....oo.oo......', '...oohhohhoo....', '..ohhhhhHhhhoo..', '..ohhHhhhhhhhho.']),
  },
  garment: { kind: 'scrubs', short: true },
  accessory: STETHOSCOPE,
});

const TURK_FRONT = [
  '......oooo......',
  '....oossssoo....',
  '...ossLLsssso...',
  '..osssssssssso..',
  '..osssssssssso..',
  '..oshhsssshhso..',
  '.oSssessssessSo.',
  '.oSssssssssssSo.',
  '...ossmmmmsso...',
  '....oohhhhoo....',
];

/** Turk: shaved head, dark skin, a short goatee, dark green surgical scrubs. */
export const TURK: CharacterArt = person({
  id: 'turk',
  palette: { ...COMMON, s: '#8a5a3c', S: '#68412a', L: '#a87556', m: '#4a2a22', h: '#2a1a14', H: '#2a1a14', J: '#2f6e4f', K: '#235339', n: '#2f6e4f', N: '#235339' },
  head: {
    down: TURK_FRONT,
    up: [
      ...TURK_FRONT.slice(0, 3),
      '..osssssssssso..',
      '..osssssssssso..',
      '..osssssssssso..',
      '.oSssssssssssSo.',
      '.oSssssssssssSo.',
      '...osssssssso...',
      '....oossssoo....',
    ],
    right: [
      '.....oooo.......',
      '...oossssoo.....',
      '..ossLLsssso....',
      '..osssssssssso..',
      '..osssssssssso..',
      '..osssssssshso..',
      '..ossSssssseso..',
      '...osSssssssso..',
      '....osssssmso...',
      '.....ohhhhoo....',
    ],
  },
  garment: { kind: 'scrubs', short: true },
});

const COX_FRONT = [
  '....oo.oo.oo....',
  '...ohhoHhohho...',
  '..ohHhhhhHhhho..',
  '..ohhhHhhhhHho..',
  '..ohHhhhHhhhho..',
  ...manFace('...ossssmmsso...', undefined, '..ohhsssssshho..'),
];

/** Dr. Cox: short reddish curls, white coat open on a blue shirt. */
export const COX: CharacterArt = person({
  id: 'cox',
  palette: { ...COMMON, s: '#f0c29c', S: '#cc9672', m: '#a8584e', h: '#9c4a28', H: '#c46a3c', J: '#eef1f3', K: '#b9c3cb', i: '#5b86b3', n: '#3a3f4a', N: '#2c3038' },
  head: {
    down: COX_FRONT,
    up: backOf(COX_FRONT),
    right: manSide(['....oo.oo.......', '...ohhoHhoo.....', '..ohHhhhhHhoo...', '..ohhhHhhhhHho..']),
  },
  garment: { kind: 'coat' },
});

/** Elliot: blonde hair to the shoulders with a side fringe, white coat on pink scrubs. */
export const ELLIOT: CharacterArt = person({
  id: 'elliot',
  palette: { ...COMMON, s: '#f6d2b4', S: '#d6a684', m: '#c0606a', p: '#f0a0a0', h: '#e3bd5e', H: '#f5dc92', J: '#eef1f3', K: '#b9c3cb', i: '#ee93b6', n: '#ee93b6', N: '#c96f93', x: '#5d6670', X: '#c8d0d8' },
  head: womanHead(['..ohhhhhhhHhho..', '..ohhhhhhsshho..', '..ohhsssssssho..']),
  garment: { kind: 'coat' },
  hair: LONG_HAIR,
  accessory: STETHOSCOPE,
});

/** Carla: long dark hair parted in the middle, plum nurse scrubs. */
export const CARLA: CharacterArt = person({
  id: 'carla',
  palette: { ...COMMON, s: '#d9a27c', S: '#b47e5c', m: '#a8404a', p: '#d88a7a', h: '#2a1a16', H: '#4d3329', J: '#8e3b66', K: '#6b2a4c', n: '#8e3b66', N: '#6b2a4c' },
  head: womanHead(['..ohhhhhhhhhho..', '..ohhhsssshhho..', '..ohhsssssshho..']),
  garment: { kind: 'scrubs', short: true },
  hair: LONG_HAIR,
});

const KELSO_FRONT = ['......oooo......', '....oossssoo....', '...ossLLsssso...', '..osssssssssso..', '..ohhsssssshho..', ...manFace('...ossmmmmsso...')];

/** Dr. Kelso: bald on top with white hair at the sides, the smug grin, white coat on a shirt and a maroon tie. */
export const KELSO: CharacterArt = person({
  id: 'kelso',
  palette: { ...COMMON, s: '#efc6a6', S: '#cc9c7e', L: '#fbe0ca', m: '#9a4e46', h: '#deded8', H: '#b4b2aa', J: '#eef1f3', K: '#b9c3cb', i: '#c3d3e6', t: '#7a2a3c', T: '#561c2a', n: '#3a3f4a', N: '#2c3038' },
  head: {
    down: KELSO_FRONT,
    up: [
      '......oooo......',
      '....oossssoo....',
      '...ossLLsssso...',
      '..osssssssssso..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..oohhhhhhhhoo..',
      '...ohhhhhhhho...',
      '....oossssoo....',
    ],
    right: [
      '.....oooo.......',
      '...oossssoo.....',
      '..ossLLsssso....',
      '..osssssssssso..',
      '..ohhsssssssso..',
      '..ohhhssssssso..',
      '..ohhhSsssseso..',
      '...ohsssssssso..',
      '....ossssmmso...',
      '.....ossssoo....',
    ],
  },
  garment: { kind: 'coat', tie: true },
});

const JANITOR_SIDE_HAIR = ['.....oooo.......', '...oohhHhoo.....', '..ohhhhhhhhoo...', '..ohhhhhhhhhho..'] as const;
const JANITOR_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhHhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', ...manFace(undefined, undefined, '..ohshhsshhsho..')];

/** The Janitor: short brown hair, a frown under heavy brows, a grey-green work overall with the keys at the belt. */
export const JANITOR: CharacterArt = person({
  id: 'janitor',
  palette: { ...COMMON, s: '#eec29e', S: '#c9946f', m: '#8a4a42', h: '#5a4130', H: '#76583f', J: '#7f8c74', K: '#66715d', i: '#6a7561', t: '#6a7561', T: '#59634f', n: '#7f8c74', N: '#66715d', x: '#9aa0a6', X: '#d9c27a' },
  head: {
    down: JANITOR_FRONT,
    up: backOf(JANITOR_FRONT),
    right: [...manSide(JANITOR_SIDE_HAIR).slice(0, 5), '..ohhhhhssshso..', ...manSide(JANITOR_SIDE_HAIR).slice(6)],
  },
  garment: { kind: 'shirt' },
  accessory: {
    down: ['................', '................', '................', '................', '................', '..........xX....'],
    up: [],
    right: ['................', '................', '................', '................', '................', '.......xX.......'],
  },
});

const TED_FRONT = ['......oooo......', '....oossssoo....', '...osshLhhsso...', '..osssssssssso..', '..ohhsssssshho..', ...manFace()];

/** Ted: thinning brown hair combed over a bald top, a worried face, a beige shirt and a dull blue tie. */
export const TED: CharacterArt = person({
  id: 'ted',
  palette: { ...COMMON, s: '#eec4a0', S: '#c99a78', L: '#f8d8bc', m: '#9a5048', h: '#6b5340', H: '#8a6f58', J: '#e6e0cc', K: '#c4bca4', i: '#e6e0cc', t: '#55688a', T: '#3e4e6a', n: '#5c5a52', N: '#47463f' },
  head: {
    down: TED_FRONT,
    up: [
      '......oooo......',
      '....oossssoo....',
      '...osshhhhsso...',
      '..osssssssssso..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..oohhhhhhhhoo..',
      '...ohhhhhhhho...',
      '....oossssoo....',
    ],
    right: [
      '.....oooo.......',
      '...oosshhoo.....',
      '..osshLhhsso....',
      '..osssssssssso..',
      '..ohhsssssssso..',
      '..ohhhssssssso..',
      '..ohhhSsssseso..',
      '...ohsssssssso..',
      '....osssssmso...',
      '.....ossssoo....',
    ],
  },
  garment: { kind: 'shirt', tie: true },
});

const LAVERNE_FRONT = [
  '....oo.oo.oo....',
  '...ohhohhohho...',
  '..ohhhHhhhHhho..',
  '..ohhhhhhhhhho..',
  '..ohhsssssshho..',
  '..ohssssssssho..',
  '..ohsessssesho..',
  '..ohpsssssspho..',
  '...ossmmmmsso...',
  '....oossssoo....',
];

/** Laverne: short black curls, dark skin, a warm smile, lavender nurse scrubs. */
export const LAVERNE: CharacterArt = person({
  id: 'laverne',
  palette: { ...COMMON, s: '#7e5136', S: '#5e3a25', m: '#a85a52', p: '#93603f', h: '#1e1612', H: '#3a2a22', J: '#9a98d6', K: '#7573b4', n: '#9a98d6', N: '#7573b4' },
  head: {
    down: LAVERNE_FRONT,
    up: backOf(LAVERNE_FRONT),
    right: [
      '....oo.oo.......',
      '...ohhoHhoo.....',
      '..ohHhhhhHhoo...',
      '..ohhhhhhhhhho..',
      '..ohhhhhhsssso..',
      '..ohhhhhssssso..',
      '..ohhhSsssseso..',
      '...ohssssssspo..',
      '....ossssmmso...',
      '.....ossssoo....',
    ],
  },
  garment: { kind: 'scrubs', short: true },
});
