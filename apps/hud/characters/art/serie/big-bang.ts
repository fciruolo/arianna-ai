import type { CharacterArt } from '../../compose.ts';
import { backOf, manFace, manSide } from './heads.ts';
import { COMMON, person, type Rows } from './person.ts';

/**
 * The friends of Pasadena of The Big Bang Theory, for the theme Pasadena
 * (D-243): fan art drawn by Claude for the user's personal use, in the pack
 * `serie`, to be removed (history of git included) before the repository is
 * shared. Real people as those of The Office and Prison Break: the shared
 * heads of `heads.ts`, the clothes tell them apart (Sheldon's superhero shirt,
 * Howard's bowl cut and bright trousers, the cardigans of the girls).
 */

/** Hair down to the shoulders, front, back and side (Penny). */
const LONG_HAIR = {
  down: ['..ohhho..ohhho..', '..ohho....ohho..'],
  up: ['..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '...ohhhhhhhho...', '....ohhhhhho....'],
  right: ['..ohhhhh........', '..ohhhho........', '..ohhho.........', '...oho..........'],
};

/** Hair that just touches the shoulders (Bernadette, Amy). */
const SHOULDER_HAIR = {
  down: ['..ohho....ohho..'],
  up: ['..ohhhhhhhhhho..', '...ohhhhhhhho...'],
  right: ['..ohhhho........', '...ohho.........'],
};

/** The back of a woman's head: hair all over, down to the nape. */
function hairBack(top: Rows): string[] {
  return [...top.slice(0, 4), ...Array.from({ length: 6 }, () => '..ohhhhhhhhhho..')];
}

const PENNY_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhHhhhhho...',
  '..ohhHhhhhhhho..',
  '..ohhhsssssHho..',
  '..ohssssssssho..',
  '..ohsessssesho..',
  '..ohpsssssspho..',
  '..ohsssmmsssho..',
  '..ohhossssohho..',
];

/** Penny: long blonde hair with a side fringe, a coral top with short sleeves, blue jeans. */
export const PENNY: CharacterArt = person({
  id: 'penny',
  palette: { ...COMMON, s: '#f6d4b8', S: '#d6a98a', m: '#c0505a', p: '#f0a8a0', h: '#e8c060', H: '#f6dc8e', J: '#e0605a', K: '#b8463f', i: '#e0605a', t: '#f6d4b8', T: '#d6a98a', n: '#3d5f8f', N: '#2e4a70' },
  head: {
    down: PENNY_FRONT,
    up: hairBack(PENNY_FRONT),
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
  garment: { kind: 'shirt', short: true },
  hair: LONG_HAIR,
});

const HOWARD_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohHHHHHHHHho..', ...manFace('...osssmmmsso...')];

/** Howard: the dark bowl cut with its straight fringe, a turquoise shirt over the white collar of a dickey, raspberry trousers. */
export const HOWARD: CharacterArt = person({
  id: 'howard',
  palette: { ...COMMON, s: '#f0c8a6', S: '#cc9c7c', m: '#8a3e3a', h: '#3a2a20', H: '#2a1e16', J: '#3fa6b8', K: '#2e8090', i: '#f2f0ea', t: '#f2f0ea', T: '#d4d2cc', n: '#b8325a', N: '#922446' },
  head: {
    down: HOWARD_FRONT,
    up: backOf(HOWARD_FRONT),
    right: [...manSide(['.....oooo.......', '...oohhhhoo.....', '..ohhhhhhhhoo...', '..ohhhhhhhhhho..']).slice(0, 4), '..ohhhhhhhHHHo..', ...manSide().slice(5)],
  },
  garment: { kind: 'shirt' },
});

/** The yellow disc with the bolt on Sheldon's chest, front and side; the grey of the long sleeves shows at the collar. */
const SHELDON_BOLT = {
  down: ['................', '................', '......xxXx......', '......xXxx......'],
  right: ['................', '................', '..........xX....', '..........Xx....'],
};

const SHELDON_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhhHhhho...', '..ohhhhhHhhhho..', '..ohhsssssshho..', ...manFace('...osssmmssso...')];

/** Sheldon: short brown hair neatly combed, a red superhero T-shirt with the bolt on a yellow disc, the grey of a long-sleeved shirt at the collar, khaki trousers. */
export const SHELDON: CharacterArt = person({
  id: 'sheldon',
  palette: { ...COMMON, s: '#f4cfb0', S: '#d0a284', m: '#9a5048', h: '#5a3c26', H: '#7a5636', J: '#c8302c', K: '#9a2420', i: '#c8302c', t: '#9aa0a6', T: '#7e848a', x: '#f2c230', X: '#8a1a18', n: '#7a6448', N: '#5e4c36' },
  head: {
    down: SHELDON_FRONT,
    up: backOf(SHELDON_FRONT),
    right: manSide(['.....oooo.......', '...oohhhhoo.....', '..ohhhhHhhhoo...', '..ohhhhhhhhhho..']),
  },
  garment: { kind: 'shirt' },
  accessory: SHELDON_BOLT,
});

const LEONARD_FRONT = [
  '......oooo......',
  '....oohHhHoo....',
  '...ohHhHhHhho...',
  '..ohhHhhHhhHho..',
  '..ohhhhhhhhhho..',
  '..ohgggssgggho..',
  '..ohGeGggGeGho..',
  '..oossssssssoo..',
  '...osssmmssso...',
  '....oossssoo....',
];

/** Leonard: dark curly hair, the thick black glasses, an olive hoodie open on an orange T-shirt, jeans. */
export const LEONARD: CharacterArt = person({
  id: 'leonard',
  palette: { ...COMMON, s: '#f2c8a4', S: '#cf9c78', m: '#a0524a', h: '#2e2420', H: '#4a3a30', g: '#1b1b22', G: '#cfdbe6', J: '#5f6e4a', K: '#4a573a', i: '#d98a3a', n: '#3a4f73', N: '#2c3c58' },
  head: {
    down: LEONARD_FRONT,
    up: backOf(LEONARD_FRONT),
    right: [...manSide(['.....oooo.......', '...oohHhHoo.....', '..ohHhHhHhhoo...', '..ohhHhhHhhhho..']).slice(0, 4), '..ohhhhhhhhhho..', '..ohhhhhhsssso..', '..ohhhSgggGeGo..', '...ohsssssssso..', '....osssssmso...', '.....ossssoo....'],
  },
  garment: { kind: 'cardigan' },
});

const BERNADETTE_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhHhhhho...',
  '..ohhhhhhHhhho..',
  '..ohhhssssshho..',
  '..ohgggssgggho..',
  '..ohGeGggGeGho..',
  '..ohpsssssspho..',
  '..ohsssmmsssho..',
  '..ohhossssohho..',
];

/** Bernadette: blonde hair to the shoulders, small glasses, a periwinkle cardigan on a white blouse, a purple skirt. */
export const BERNADETTE: CharacterArt = person({
  id: 'bernadette',
  palette: { ...COMMON, s: '#f6d6bc', S: '#d6aa8c', m: '#c0506a', p: '#f0a8a8', h: '#e2c47a', H: '#f2dc9e', g: '#6a4a3a', G: '#e4ecf2', J: '#8fa8d8', K: '#6f88b8', i: '#f6f2ea', n: '#5a4a78', N: '#463a5e' },
  head: {
    down: BERNADETTE_FRONT,
    up: hairBack(BERNADETTE_FRONT),
    right: [
      '.....oooo.......',
      '...oohhHhoo.....',
      '..ohhhHHhhho....',
      '..ohhhhhhhhho...',
      '..ohhhhhhhssso..',
      '..ohhhhsssssso..',
      '..ohhhhsggGeGo..',
      '..ohhhhssssspo..',
      '..ohhhhsssssmo..',
      '..ohhhhhossso...',
    ],
  },
  garment: { kind: 'cardigan' },
  legs: 'skirt',
  hair: SHOULDER_HAIR,
});

const RAJ_FRONT = ['.....oooooo.....', '...oohhhHhhoo...', '..ohhhhHHhhhho..', '..ohhhhhhhhhho..', '..ohhsssssshho..', ...manFace('...osssmmssso...')];

/** Raj: black hair swept up, a maroon sweater vest over a light blue shirt, khaki trousers. */
export const RAJ: CharacterArt = person({
  id: 'raj',
  palette: { ...COMMON, s: '#b88460', S: '#966644', m: '#6a3430', h: '#16120f', H: '#34302c', J: '#7a3040', K: '#5c2230', i: '#bcd4ea', n: '#a89470', N: '#8a7858' },
  head: {
    down: RAJ_FRONT,
    up: backOf(RAJ_FRONT),
    right: manSide(['....oooooo......', '...ohhhHhhoo....', '..ohhhHHhhhhoo..', '..ohhhhhhhhhho..']),
  },
  garment: { kind: 'cardigan' },
});

const FOWLER_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohHhhhhhho...',
  '..ohhHhhhhhhho..',
  '..ohhssssssHho..',
  '..ohgggssgggho..',
  '..ohGeGggGeGho..',
  '..ohssssssssho..',
  '..ohsssmmsssho..',
  '..ohhossssohho..',
];

/** Amy Farrah Fowler: straight brown hair parted on the side, glasses, a mustard cardigan on a plum blouse, a long brown skirt. */
export const FOWLER: CharacterArt = person({
  id: 'fowler',
  palette: { ...COMMON, s: '#f2cfb2', S: '#d0a48a', m: '#a8585a', h: '#5a4030', H: '#74563e', g: '#2b2b33', G: '#dfe8ee', J: '#9a8a3a', K: '#7a6c2a', i: '#b86a8a', n: '#6a4a3a', N: '#54392c' },
  head: {
    down: FOWLER_FRONT,
    up: hairBack(FOWLER_FRONT),
    right: [
      '.....oooo.......',
      '...oohhhhoo.....',
      '..ohhhhhhhho....',
      '..ohhhhhhhhho...',
      '..ohhhhhhhssso..',
      '..ohhhhsssssso..',
      '..ohhhhsggGeGo..',
      '..ohhhhsssssso..',
      '..ohhhhsssssmo..',
      '..ohhhhhossso...',
    ],
  },
  garment: { kind: 'cardigan' },
  legs: 'skirt',
  hair: SHOULDER_HAIR,
});

/** The friends of the theme Pasadena in the order of pack.json: `SERIES` of originals.ts takes them after the others. */
export const BIG_BANG: readonly { art: CharacterArt; name: string }[] = [
  { art: PENNY, name: 'Penny' },
  { art: HOWARD, name: 'Howard' },
  { art: SHELDON, name: 'Sheldon' },
  { art: LEONARD, name: 'Leonard' },
  { art: BERNADETTE, name: 'Bernadette' },
  { art: RAJ, name: 'Raj' },
  { art: FOWLER, name: 'Amy' },
];
