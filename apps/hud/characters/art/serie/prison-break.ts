import type { CharacterArt } from '../../compose.ts';
import { backOf, manFace, manSide } from './heads.ts';
import { COMMON, person, type Rows } from './person.ts';

/**
 * The people of Fox River of Prison Break, for the theme Fox River (D-240):
 * fan art drawn by Claude for the user's personal use, in the pack `serie`,
 * to be removed (history of git included) before the repository is shared.
 * The inmates wear the blue chambray shirt and the dark blue trousers of the
 * prison; the faces tell them apart.
 */

/** The prison uniform: a light blue chambray shirt with a darker placket, a white undershirt at the collar, dark blue trousers. */
const UNIFORM = { J: '#7f9fc6', K: '#6283ab', i: '#5a789e', t: '#e4e3dc', T: '#c4c3bb', n: '#2f4566', N: '#24364f' } as const;

/** The back of a shaved head: skin all over, the light on the crown. */
function shavedBack(top: Rows): string[] {
  return [
    ...top.slice(0, 3),
    '..osssssssssso..',
    '..osssssssssso..',
    '..osssssssssso..',
    '..osssssssssso..',
    '..oossssssssoo..',
    '...osssssssso...',
    '....oossssoo....',
  ];
}

const SCOFIELD_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhHhhhho...', '..ohhhhhhhhhho..', '..ohssssssssho..', ...manFace('...ossssmssso...')];

/** Michael Scofield: a close dark buzz cut over a high forehead, a calm half smile, the long sleeves that hide the tattoo. */
export const SCOFIELD: CharacterArt = person({
  id: 'scofield',
  palette: { ...COMMON, ...UNIFORM, s: '#efc4a2', S: '#cb9a7a', m: '#9a5048', h: '#3b2c22', H: '#56443a' },
  head: {
    down: SCOFIELD_FRONT,
    up: backOf(SCOFIELD_FRONT),
    right: [...manSide(['.....oooo.......', '...oohhhhoo.....', '..ohhhHhhhhoo...', '..ohhhhhhhhhho..']).slice(0, 4), '..ohhhhhssssso..', ...manSide().slice(5)],
  },
  garment: { kind: 'shirt' },
});

const LINCOLN_TOP = ['......oooo......', '....oossssoo....', '...ossLLsssso...'] as const;
const LINCOLN_FRONT = [...LINCOLN_TOP, '..osssssssssso..', '..osssssssssso..', ...manFace('...osssmmssso...', '..ossessssesso..', '..osssssssssso..')];

/** Lincoln Burrows: a shaved head, a broad stern face, short sleeves on big arms. */
export const LINCOLN: CharacterArt = person({
  id: 'lincoln',
  palette: { ...COMMON, ...UNIFORM, s: '#e9b998', S: '#c38f6e', L: '#f6d4ba', m: '#8a4a42', h: '#c38f6e', H: '#c38f6e' },
  head: {
    down: LINCOLN_FRONT,
    up: shavedBack(LINCOLN_TOP),
    right: [
      '.....oooo.......',
      '...oossssoo.....',
      '..ossLLsssso....',
      '..osssssssssso..',
      '..osssssssssso..',
      '..osssssssssso..',
      '..osssSsssseso..',
      '...ossssssssso..',
      '....osssssmso...',
      '.....ossssoo....',
    ],
  },
  garment: { kind: 'shirt', short: true },
});

/** Long hair down to the shoulders, front, back and side (Sara). */
const LONG_HAIR = {
  down: ['..ohhho..ohhho..', '..ohho....ohho..'],
  up: ['..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '...ohhhhhhhho...', '....ohhhhhho....'],
  right: ['..ohhhhh........', '..ohhhho........', '..ohhho.........', '...oho..........'],
};

/** Sara Tancredi: auburn hair to the shoulders, the white coat of the prison doctor on a light blue blouse. */
export const SARA: CharacterArt = person({
  id: 'sara',
  palette: { ...COMMON, s: '#f6d2b6', S: '#d6a688', m: '#b85a5e', p: '#efaaa0', h: '#8e3f22', H: '#b45c32', J: '#eef1f3', K: '#b9c3cb', i: '#a9c4e0', n: '#3a3f4a', N: '#2c3038' },
  head: {
    down: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhHHhhho...',
      '..ohhhhHhhhhho..',
      '..ohhssssshhho..',
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
  garment: { kind: 'coat' },
  hair: LONG_HAIR,
});

const MAHONE_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhhhhHho...', '..ohhhhhhhhHho..', '..ohhhhhhhhhho..', ...manFace('...osssmmssso...', '..ohsessssesho..', '..ohSsssssssho..')];

/** Alexander Mahone: short dark hair with a side parting, a tired frown, a grey suit with a slate tie. */
export const MAHONE: CharacterArt = person({
  id: 'mahone',
  palette: { ...COMMON, s: '#eec3a0', S: '#c9977a', m: '#94504a', h: '#3a2d24', H: '#5a4636', J: '#5d636b', K: '#484d54', i: '#e9ecef', t: '#3b4a5e', T: '#2a3644', n: '#5d636b', N: '#484d54' },
  head: {
    down: MAHONE_FRONT,
    up: backOf(MAHONE_FRONT),
    right: manSide(['.....oooo.......', '...oohhhhoo.....', '..ohhhhhhHhoo...', '..ohhhhhhhhHho..']),
  },
  garment: { kind: 'suit' },
});

const ABRUZZI_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohHhhhhHho...',
  '..ohhhhhhhhhho..',
  '..ohhsssssshho..',
  '..ohssssssssho..',
  '..ohsessssesho..',
  '..ooSssssssSoo..',
  '...oSssmmssSo...',
  '....ooSSSSoo....',
];

/** John Abruzzi: black hair slicked back, a dark stubble on the jaw, a hard look, the uniform buttoned up. */
export const ABRUZZI: CharacterArt = person({
  id: 'abruzzi',
  palette: { ...COMMON, ...UNIFORM, s: '#dcae88', S: '#6b5446', m: '#7a3e36', h: '#15120f', H: '#34302c' },
  head: {
    down: ABRUZZI_FRONT,
    up: backOf(ABRUZZI_FRONT),
    right: [...manSide(['.....oooo.......', '...oohHhhoo.....', '..ohhhhhhHhoo...', '..ohhhhhhhhhho..']).slice(0, 7), '...ohssssssSSo..', '....oSsssSmSo...', '.....oSSSSoo....'],
  },
  garment: { kind: 'shirt' },
});

const WESTMORELAND_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhhhhhho...',
  '..ohhhhHhhhhho..',
  '..ohssssssssho..',
  '..ohssssssssho..',
  '..ohsessssesho..',
  '..ohhsssssshho..',
  '...ohhhmmhhho...',
  '....oohhhhoo....',
];

/** Charles Westmoreland: white hair and a full white beard, a wise old face, the uniform of the oldest inmate. */
export const WESTMORELAND: CharacterArt = person({
  id: 'westmoreland',
  palette: { ...COMMON, ...UNIFORM, s: '#e8bc98', S: '#c49374', m: '#8a4a42', h: '#e4e2dc', H: '#c4c1b8' },
  head: {
    down: WESTMORELAND_FRONT,
    up: backOf(WESTMORELAND_FRONT),
    right: [...manSide(['.....oooo.......', '...oohhhhoo.....', '..ohhhhHhhhoo...', '..ohhhhhhhhhho..']).slice(0, 7), '...ohhhsssshho..', '....ohhhhhmho...', '.....ohhhhoo....'],
  },
  garment: { kind: 'shirt' },
});

const SUCRE_FRONT = ['......oooo......', '....oohhhhoo....', '...ohhhhHhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', ...manFace('...oshhmmhhso...').slice(0, 4), '....ooshhsoo....'];

/** Fernando Sucre: short black hair, a warm tan face with a thin moustache and goatee, short sleeves. */
export const SUCRE: CharacterArt = person({
  id: 'sucre',
  palette: { ...COMMON, ...UNIFORM, s: '#c99a6e', S: '#a57852', m: '#7a3a30', h: '#1c1612', H: '#3a2e26' },
  head: {
    down: SUCRE_FRONT,
    up: backOf(SUCRE_FRONT),
    right: [...manSide().slice(0, 8), '....oshhhhmso...', '.....oshhsoo....'],
  },
  garment: { kind: 'shirt', short: true },
});

const TBAG_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhhHhhho...',
  '..ohhhhHHhhhho..',
  '..ohhhssssshho..',
  '..ohhsssssshho..',
  '..ohsessssesho..',
  '..ohssssssssho..',
  '...ohshmmhsho...',
  '....oossssoo....',
];

/** T-Bag: greasy brown hair long over the ears, a thin moustache round a sly smile, short sleeves. */
export const TBAG: CharacterArt = person({
  id: 'tbag',
  palette: { ...COMMON, ...UNIFORM, s: '#eec29c', S: '#c8966f', m: '#8a3e38', h: '#6b4f30', H: '#8a6a44' },
  head: {
    down: TBAG_FRONT,
    up: backOf(TBAG_FRONT),
    right: [...manSide(['.....oooo.......', '...oohhHhoo.....', '..ohhhHHhhhoo...', '..ohhhhhhhhhho..']).slice(0, 4), '..ohhhhhhhssso..', '..ohhhhhssssso..', '..ohhhSsssseso..', '...ohhssssssso..', '....ohssshmso...', '.....ossssoo....'],
  },
  garment: { kind: 'shirt', short: true },
});

/** The people of the theme Fox River in the order of pack.json: `SERIES` of originals.ts takes them after the others. */
export const PRISON_BREAK: readonly { art: CharacterArt; name: string }[] = [
  { art: SARA, name: 'Sara' },
  { art: SCOFIELD, name: 'Michael' },
  { art: LINCOLN, name: 'Lincoln' },
  { art: MAHONE, name: 'Mahone' },
  { art: ABRUZZI, name: 'Abruzzi' },
  { art: WESTMORELAND, name: 'Westmoreland' },
  { art: SUCRE, name: 'Sucre' },
  { art: TBAG, name: 'T-Bag' },
];
