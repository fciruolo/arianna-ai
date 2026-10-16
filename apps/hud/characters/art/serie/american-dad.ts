import type { CharacterArt } from '../../compose.ts';
import { backOf } from './heads.ts';
import { COMMON, person } from './person.ts';

/**
 * The Smiths of American Dad! and the deputy director of the CIA, for the
 * theme Langley (D-239): fan art drawn by Claude for the user's personal use,
 * in the pack `serie`, to be removed (history of git included) before the
 * repository is shared.
 */

/** Hair on the shoulders, front, back and side (Francine, Hayley). */
const LONG_HAIR = {
  down: ['..ohhho..ohhho..', '..ohho....ohho..'],
  up: ['..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '...ohhhhhhhho...', '....ohhhhhho....'],
  right: ['..ohhhhh........', '..ohhhho........', '..ohhho.........', '...oho..........'],
};

const STAN_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhhHhhho...',
  '..ohhhhhhhhhho..',
  '..ohhsssssshho..',
  '..ohssssssssho..',
  '..ohsessssesho..',
  '.osssssssssssso.',
  '.osssssmmssssso.',
  '..ossssSSsssso..',
];

/** Stan: black hair with a side parting, the huge square chin, a charcoal suit and a red tie. */
export const STAN: CharacterArt = person({
  id: 'stan',
  palette: { ...COMMON, s: '#f2c6a0', S: '#c99670', m: '#8a3a36', h: '#16161c', H: '#3a3c48', J: '#4a505c', K: '#363b45', i: '#f4f5f7', t: '#c0303a', T: '#8c1f28', n: '#4a505c', N: '#363b45' },
  head: {
    down: STAN_FRONT,
    up: backOf(STAN_FRONT),
    right: [
      '.....oooo.......',
      '...oohhhhoo.....',
      '..ohhhhhhhhoo...',
      '..ohhhhhhhhhho..',
      '..ohhhhhhsssso..',
      '..ohhhhhssssso..',
      '..ohhhSsssseso..',
      '..oohsssssssso..',
      '...osssssssmsso.',
      '....osssssssso..',
    ],
  },
  garment: { kind: 'suit' },
});

/** Francine: big blonde hair on the shoulders, a coral cardigan on a white blouse, a navy skirt. */
export const FRANCINE: CharacterArt = person({
  id: 'francine',
  palette: { ...COMMON, s: '#f6d0b0', S: '#d6a283', m: '#c0505e', p: '#f0a3a0', h: '#efcd6a', H: '#fae6a4', J: '#ea7f7a', K: '#c65c5a', i: '#fbfaf5', n: '#2f4a7c', N: '#22375e' },
  head: {
    down: [
      '....oooooooo....',
      '...ohhhHHhhho...',
      '..ohhhHHhhhhho..',
      '.ohhhhhhhhhhhho.',
      '.ohhhhsssshhhho.',
      '.ohhsssssssshho.',
      '.ohhsesssseshho.',
      '.ohhpssssssphho.',
      '.ohhsssmmssshho.',
      '..ohhossssohho..',
    ],
    up: [
      '....oooooooo....',
      '...ohhhHHhhho...',
      '..ohhhHHhhhhho..',
      '.ohhhhhhhhhhhho.',
      '.ohhhhhhhhhhhho.',
      '.ohhhhhHhhhhhho.',
      '.ohhhhhhhhhhhho.',
      '.ohhhhhhhhhhhho.',
      '.ohhhhhhhhhhhho.',
      '..ohhhhhhhhhho..',
    ],
    right: [
      '....ooooo.......',
      '..oohhhHHoo.....',
      '.ohhhhHHhhhoo...',
      '.ohhhhhhhhhhho..',
      '.ohhhhhhhhssso..',
      '.ohhhhhhsssssso.',
      '.ohhhhhhsssseso.',
      '.ohhhhhhssssspo.',
      '.ohhhhhhsssssmo.',
      '..ohhhhhhossso..',
    ],
  },
  garment: { kind: 'cardigan' },
  legs: 'skirt',
  hair: LONG_HAIR,
});

const ROGER_FRONT = [
  '.....oooooo.....',
  '...oossssssoo...',
  '..osssssssssso..',
  '.osssssssssssso.',
  '.osssssssssssso.',
  '.osssEEssEEssso.',
  '.ossseesseessso.',
  '..osssssssssso..',
  '...osssmmssso...',
  '....oossssoo....',
];

/** Roger: the grey alien, a big round bald head with large dark eyes, in one of his disguises: a plum coat on a pink shirt. */
export const ROGER: CharacterArt = person({
  id: 'roger',
  palette: { ...COMMON, s: '#c3c7cf', S: '#979ca6', E: '#4a4a5c', m: '#6e4e5a', h: '#c3c7cf', H: '#d8dbe1', J: '#7a3f6e', K: '#5a2c52', i: '#f2b8c8', n: '#3a3048', N: '#2a2236' },
  head: {
    down: ROGER_FRONT,
    up: backOf(ROGER_FRONT, '..ohhhhhhhhhho..', '....oossssoo....'),
    right: [
      '.....oooooo.....',
      '...oossssssoo...',
      '..osssssssssso..',
      '.osssssssssssso.',
      '.osssssssssssso.',
      '.osssssssssEEso.',
      '.ossssssssseeso.',
      '..osssssssssso..',
      '...osssssssmso..',
      '....oossssoo....',
    ],
  },
  garment: { kind: 'coat' },
});

/** Hayley: long dark hair with a headband and a flower, an olive top with short sleeves, jeans. */
export const HAYLEY: CharacterArt = person({
  id: 'hayley',
  palette: { ...COMMON, s: '#f4cfae', S: '#d4a080', m: '#b8545e', p: '#eea69c', h: '#3a2418', H: '#5a3a28', x: '#d0574c', X: '#f2d35c', J: '#6f7d3c', K: '#56622c', i: '#6f7d3c', t: '#f4cfae', T: '#d4a080', n: '#4f6f9e', N: '#3c5680' },
  head: {
    down: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhhhhhho...',
      '..oxxxxxxxxXxo..',
      '..ohhhhhhhhhho..',
      '..ohhsssssshho..',
      '..ohsessssesho..',
      '..ohpsssssspho..',
      '..ohsssmmsssho..',
      '..ohhossssohho..',
    ],
    up: [
      '......oooo......',
      '....oohhhhoo....',
      '...ohhhhhhhho...',
      '..oxxxxxxxxxxo..',
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
      '..oxxxxxxxxXo...',
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

const STEVE_FRONT = [
  '......oooo......',
  '....oohhhhoo....',
  '...ohhhHhhhho...',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohgggssgggho..',
  '..ohGeGggGeGho..',
  '..oossssssssoo..',
  '...ossmmmmsso...',
  '....oossssoo....',
];

/** Steve: light brown hair with a fringe, big round glasses, a yellow t-shirt, jeans. */
export const STEVE: CharacterArt = person({
  id: 'steve',
  palette: { ...COMMON, s: '#f6d2b2', S: '#d6a486', m: '#a8505a', h: '#7a5634', H: '#9a7448', g: '#2b2b33', G: '#d8e6f0', J: '#f0c64a', K: '#cc9f2c', i: '#f0c64a', t: '#f6d2b2', T: '#d6a486', n: '#4f6f9e', N: '#3c5680' },
  head: {
    down: STEVE_FRONT,
    up: backOf(STEVE_FRONT),
    right: [
      '.....oooo.......',
      '...oohhHhoo.....',
      '..ohhhhHhhhoo...',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhhho.',
      '..ohhhhhhsssso..',
      '..ohhhSgggGeGo..',
      '...ohsssssssso..',
      '....osssssmso...',
      '.....ossssoo....',
    ],
  },
  garment: { kind: 'shirt', short: true },
});

/** Klaus: the goldfish in his bowl (a glass bowl for a head, the fish inside), on a brown jacket. */
export const KLAUS: CharacterArt = person({
  id: 'klaus',
  palette: { ...COMMON, s: '#f08a2c', S: '#c4641a', m: '#c4641a', e: '#1b1b2a', h: '#d9eef6', H: '#f4fbfd', g: '#a9d6e8', w: '#7fc0de', J: '#7a5232', K: '#5c3c22', i: '#e6e2d6', t: '#2b2b33', T: '#1a1a20', n: '#4a4238', N: '#38322a' },
  head: {
    down: [
      '....oooooooo....',
      '....oHHHHHHo....',
      '...oggggggggo...',
      '..ogwwwwwwwwgo..',
      '.ogwwwwwwwwwwgo.',
      '.ogwwwssssswwgo.',
      '.ogwwsesssswsgo.',
      '.ogwwwssssswwgo.',
      '..ogwwwwwwwwgo..',
      '....oggggggo....',
    ],
    up: [
      '....oooooooo....',
      '....oHHHHHHo....',
      '...oggggggggo...',
      '..ogwwwwwwwwgo..',
      '.ogwwwwwwwwwwgo.',
      '.ogwwssssswwwgo.',
      '.ogwswssssswwgo.',
      '.ogwwssssswwwgo.',
      '..ogwwwwwwwwgo..',
      '....oggggggo....',
    ],
    right: [
      '....oooooooo....',
      '....oHHHHHHo....',
      '...oggggggggo...',
      '..ogwwwwwwwwgo..',
      '.ogwwwwwwwwwwgo.',
      '.ogwSwwssssswgo.',
      '.ogwsssssseswgo.',
      '.ogwSwwssssswgo.',
      '..ogwwwwwwwwgo..',
      '....oggggggo....',
    ],
  },
  garment: { kind: 'suit' },
});

const BULLOCK_FRONT = [
  '......oooo......',
  '....oossssoo....',
  '...ossLLsssso...',
  '..osssssssssso..',
  '..ohhsssssshho..',
  '..ohHHssssHHho..',
  '..ohsessssesho..',
  '.oSssssssssssSo.',
  '.oSssmmmmmmssSo.',
  '..oossssssssoo..',
];

/** Bullock: the deputy director, bald on top with white hair at the sides and bushy brows, heavy jowls, a navy suit and a burgundy tie. */
export const BULLOCK: CharacterArt = person({
  id: 'bullock',
  palette: { ...COMMON, s: '#eec4a2', S: '#c99a7a', L: '#fadcc6', m: '#8a4a42', h: '#e6e4de', H: '#bdbab2', J: '#26344f', K: '#1b263b', i: '#eef1f5', t: '#7a2a3c', T: '#561c2a', n: '#26344f', N: '#1b263b' },
  head: {
    down: BULLOCK_FRONT,
    up: [
      '......oooo......',
      '....oossssoo....',
      '...ossLLsssso...',
      '..osssssssssso..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '..ohhhhhhhhhho..',
      '.oohhhhhhhhhhoo.',
      '..ohhhhhhhhhho..',
      '...oossssssoo...',
    ],
    right: [
      '.....oooo.......',
      '...oossssoo.....',
      '..ossLLsssso....',
      '..osssssssssso..',
      '..ohhsssssssso..',
      '..ohhhssssHHso..',
      '..ohhhSsssseso..',
      '..oSssssssssso..',
      '...oSsssssmsso..',
      '....oossssooo...',
    ],
  },
  garment: { kind: 'suit' },
});
