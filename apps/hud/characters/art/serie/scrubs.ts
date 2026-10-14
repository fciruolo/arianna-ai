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
