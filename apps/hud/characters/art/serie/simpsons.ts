import type { CharacterArt, CostumeLayer, Direction, Part } from '../../compose.ts';
import { COMMON, person, type PersonSpec, type Rows } from './person.ts';

/**
 * The people of Springfield of The Simpsons, for the theme Springfield
 * (D-237): fan art drawn by Claude for the user's personal use, in the pack
 * `serie`, to be removed (history of git included) before the repository is
 * shared. The faces are the show's: yellow skin, big round white eyes (`E`)
 * with a dot for the pupil (`e`), so the poses that move the eyes are drawn
 * here instead of by `person`, which would leave skin inside the white.
 */

const HEAD = 7;
/** The yellow of the show and its shade, the white of the eyes. */
const FACE = { s: '#ffd90f', S: '#d9a600', E: '#ffffff' } as const;

/** The pupils moved by `dy` rows and `dx` columns, only inside the white of the eye; else the nearest that stays inside. */
function lookAt(rows: Rows, dy: number, dx = 0): string[] {
  const out = rows.map((line) => line.replaceAll('e', 'E'));
  rows.forEach((line, y) => {
    for (let x = line.indexOf('e'); x >= 0; x = line.indexOf('e', x + 1)) {
      const target = [[dy, dx], [dy, 0], [0, 0]].find(([ry = 0, rx = 0]) => out[y + ry]?.[x + rx] === 'E') ?? [0, 0];
      const [ty = 0, tx = 0] = target;
      const row = out[y + ty] ?? '';
      out[y + ty] = row.slice(0, x + tx) + 'e' + row.slice(x + tx + 1);
    }
  });
  return out;
}

/** The eyes shut: the lids, in the shade of the skin, over white and pupil. */
function shut(rows: Rows): string[] {
  return rows.map((line) => line.replace(/[Ee]/g, 'S'));
}

/** The back of a head from its front: `fill` for skin and eyes (hair stays hair), the nape and the neck below. */
function backFrom(front: Rows, fill: string, neck = '....oossssoo....'): string[] {
  const rows = front.slice(0, 8).map((line) => line.replace(/[^o.hHr]/g, fill));
  return [...rows, `...o${fill.repeat(8)}o...`, neck];
}

/** A head seen from the right: the hair in rows 0–3, the back of the head in `back`, the big eye, the nose that sticks out, the mouth and chin. */
function sideOf(hair: Rows, back: string, mouth = '...osssssmmso...', chin = '....oossssoo....'): string[] {
  const q = back;
  return [...hair, `..o${q}${q}ssssssso...`, `..o${q}${q}sssssEEEo..`, `..o${q}SsssssEeEo..`, `..o${q}ssssssssssso`, mouth, chin];
}

interface SimpsonSpec extends Omit<PersonSpec, 'head' | 'parts'> {
  front: Rows;
  right: Rows;
  /** The letter of the back of the head: `h` for hair, `s` for a bald head. */
  back: string;
  /** Layers drawn over the head in every pose (Marge's beehive), moving with it. */
  over?: Readonly<Record<Direction, Part>>;
}

function simpson(spec: SimpsonSpec): CharacterArt {
  const { front, right, back, over, ...rest } = spec;
  const up = backFrom(front, back);
  const at = (rows: Rows): Part => ({ top: HEAD, rows });
  const art = person({
    ...rest,
    palette: { ...COMMON, ...FACE, ...rest.palette },
    head: { down: front, up, right },
    parts: {
      down: {
        head: at(front),
        'head-blink': at(shut(front)),
        'head-work': at(lookAt(front, 0)),
        'head-up': at(lookAt(front, -1)),
        'head-up2': at(lookAt(front, -1, 1)),
        'head-sleep': at(shut(front)),
      },
      up: { head: at(up) },
      right: { head: at(right), 'head-blink': at(shut(right)), 'head-work': at(lookAt(right, 0)) },
    },
  });
  if (over === undefined) return art;
  const layer = (direction: Direction): CostumeLayer[] => [{ name: 'hair-top', after: 'head', part: over[direction] }];
  return { ...art, extra: { down: layer('down'), up: layer('up'), right: layer('right') } };
}

/** Homer: bald with two hairs on top and the M over the ears, the grey-brown stubble, a white short-sleeved shirt and blue trousers. */
export const HOMER: CharacterArt = simpson({
  id: 'homer',
  palette: { m: '#7a2a1a', h: '#3a2a1a', X: '#c9a46a', J: '#f4f4ee', K: '#cfcfc6', i: '#f4f4ee', t: '#f4f4ee', T: '#cfcfc6', n: '#3d6fb5', N: '#2c548c' },
  front: [
    '......o.o.......',
    '....oooooooo....',
    '...ossssssssso..',
    '..osssssssssso..',
    '..osssssssssso..',
    '..osEEEsEEEsso..',
    '.ohsEeEsEeEssho.',
    '..ohssssssssho..',
    '...oXXXmmXXXo...',
    '....ooXXXXoo....',
  ],
  right: sideOf(['.....o.o........', '....oooooo......', '...ossssssoo....', '..osssssssssoo..'], 's', '...osssXXXmXXo..', '....ooXXXXXoo...'),
  back: 's',
  garment: { kind: 'shirt', short: true },
});

const BEEHIVE: Part = {
  top: 0,
  rows: ['.....oooooo.....', '....ohhhhhho....', '...ohhhhhHhho...', '...ohhhhhhHho...', '...ohhhhhhhho...', '...ohhHhhhhho...', '...ohhhhhhhho...'],
};

/** Marge: the tall blue beehive, a green dress, the red pearls at the neck. */
export const MARGE: CharacterArt = simpson({
  id: 'marge',
  palette: { m: '#a8322e', h: '#3f63c9', H: '#6d8fe6', x: '#d8322c', J: '#8cc63f', K: '#6c9e2c', i: '#8cc63f', t: '#ffd90f', T: '#d9a600', n: '#8cc63f', N: '#6c9e2c' },
  front: [
    '...ohhhhhhhho...',
    '..ohhhhhhhhhho..',
    '..ohhhhhhhhhho..',
    '..ohssssssssho..',
    '..ohssssssssho..',
    '..ohEEEsEEEsho..',
    '..ohEeEsEeEsho..',
    '..ohssssssssho..',
    '..ohsssmmsssho..',
    '....oxxxxxxo....',
  ],
  right: [
    '...ohhhhhhho....',
    '..ohhhhhhhhho...',
    '..ohhhhhhhhhho..',
    '..ohhhhhhsssso..',
    '..ohhhhhsssssso.',
    '..ohhhhssssEEEo.',
    '..ohhhSssssEeEo.',
    '..ohhhssssssssso',
    '...ohhssssmsso..',
    '.....oxxxxxo....',
  ],
  back: 'h',
  over: { down: BEEHIVE, up: BEEHIVE, right: BEEHIVE },
  garment: { kind: 'shirt', short: true },
  legs: 'skirt',
});

/** Bart: the spiky hair the colour of his skin, a red T-shirt, blue shorts. */
export const BART: CharacterArt = simpson({
  id: 'bart',
  palette: { m: '#8a2a20', J: '#e8432b', K: '#b8301f', i: '#e8432b', t: '#e8432b', T: '#b8301f', n: '#2f6cc0', N: '#22528f' },
  front: [
    '...o.o.o.o.o....',
    '..osososososoo..',
    '..osssssssssso..',
    '..osssssssssso..',
    '..osssssssssso..',
    '..osEEEsEEEsso..',
    '..osEeEsEeEsso..',
    '..osssssssssso..',
    '...ossmmmmsso...',
    '....oossssoo....',
  ],
  right: sideOf(['...o.o.o.o......', '..ososososo.....', '..osssssssso....', '..ossssssssso...'], 's'),
  back: 's',
  garment: { kind: 'shirt', short: true },
});

/** Lisa: the star of points of her hair, the pearl necklace, the orange-red dress. */
export const LISA: CharacterArt = simpson({
  id: 'lisa',
  palette: { m: '#a8322e', x: '#f4f1e8', J: '#f0682a', K: '#c44f1c', i: '#f0682a', t: '#ffd90f', T: '#d9a600', n: '#f0682a', N: '#c44f1c' },
  front: [
    '...o..o..o..o...',
    '..osoosoosooso..',
    '.osssssssssssso.',
    '..osssssssssso..',
    '..osEEEsEEEsso..',
    '..osEeEsEeEsso..',
    '..osssssssssso..',
    '..oosssmmsssoo..',
    '...osssssssso...',
    '....oxxxxxxo....',
  ],
  right: sideOf(['...o..o..o......', '..osoosoosoo....', '.ossssssssssso..', '..ossssssssssoo.'], 's', '...osssssmmso...', '.....oxxxxxo....'),
  back: 's',
  garment: { kind: 'shirt', short: true },
  legs: 'skirt',
});

/** Mr. Burns: bald with grey wisps at the sides, the frown, an olive suit, a dark red tie. */
export const BURNS: CharacterArt = simpson({
  id: 'burns',
  palette: { m: '#7a2a1a', h: '#c9c9b6', J: '#6b7a3a', K: '#525e2b', i: '#f1f3f5', t: '#7a2a2a', T: '#561d1d', n: '#6b7a3a', N: '#525e2b' },
  front: [
    '.....oooooo.....',
    '...oossssssoo...',
    '..osssssssssso..',
    '..osssssssssso..',
    '..osSSssssSSso..',
    '..osEEEsEEEsso..',
    '.ohsEeEsEeEssho.',
    '..ohsssSSsssho..',
    '...osssmmssso...',
    '....oossssoo....',
  ],
  right: sideOf(['......oooo......', '....oossssoo....', '...osssssssso...', '..osssssssssso..'], 'h'),
  back: 's',
  garment: { kind: 'suit' },
});

/** Smithers: dark hair with a side parting, round glasses, a charcoal-blue suit and a red tie. */
export const SMITHERS: CharacterArt = simpson({
  id: 'smithers',
  palette: { m: '#8a3a30', h: '#4a3322', H: '#6b4c34', g: '#2b2b33', J: '#3e4a66', K: '#2c3549', i: '#f1f3f5', t: '#b8302c', T: '#8a221f', n: '#3e4a66', N: '#2c3549' },
  front: [
    '......oooo......',
    '....oohhhhoo....',
    '...ohhhhhHhho...',
    '..ohhhhhhhhhho..',
    '..ohssssssssho..',
    '..ogEEEgEEEgso..',
    '..ogEeEgEeEgso..',
    '..oossssssssoo..',
    '...osssmmssso...',
    '....oossssoo....',
  ],
  right: [
    '.....oooo.......',
    '...oohhhhoo.....',
    '..ohhhhhhhhoo...',
    '..ohhhhhhhhhho..',
    '..ohhssssssso...',
    '..ohhssssgEEEo..',
    '..ohSssssgEeEo..',
    '..ohssssssssssso',
    '...osssssmmso...',
    '....oossssoo....',
  ],
  back: 'h',
  garment: { kind: 'suit' },
});

/** Boe (Moe in the original): grey hair in tufts, the heavy brow and the big lip, a grey-blue short-sleeved shirt. */
export const BOE: CharacterArt = simpson({
  id: 'boe',
  palette: { m: '#6a2a20', h: '#8d8f94', H: '#b1b3b8', J: '#b9c6d3', K: '#93a2b3', i: '#b9c6d3', t: '#b9c6d3', T: '#93a2b3', n: '#4a4038', N: '#37302a' },
  front: [
    '....oo.oo.oo....',
    '...ohhohhohho...',
    '..ohhhhhhhhhho..',
    '..ohhsssssshho..',
    '..ohsSSssSSsho..',
    '..ohsEEssEEsho..',
    '..ohsEessEesho..',
    '..oossSSSSssoo..',
    '...oSmmmmmmSo...',
    '....oossssoo....',
  ],
  right: sideOf(['....oo.oo.......', '...ohhohhoo.....', '..ohhhhhhhhoo...', '..ohhhhhhhhhho..'], 'h', '...osssSSmmSo...'),
  back: 'h',
  garment: { kind: 'shirt', short: true },
});
