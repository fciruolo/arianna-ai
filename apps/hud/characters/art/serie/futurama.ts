import type { CharacterArt, CostumeLayer, Direction, Part } from '../../compose.ts';
import { COMMON, person, type PersonSpec, type Rows } from './person.ts';

/**
 * The crew of the Planet Express of Futurama, for the theme Planet Express
 * (D-242): fan art drawn by Claude for the user's personal use, in the pack
 * `serie`, to be removed (history of git included) before the repository is
 * shared. The faces are the show's: big round white eyes (`E`) with a dot for
 * the pupil (`e`), Leela's one eye, Bender's visor, Zoidberg's eyes on their
 * stalks; so the poses that move the eyes are drawn here, as for the Simpsons
 * (D-237), instead of by `person`, which would leave skin inside the white.
 * The helpers are copied, not imported, so that the theme comes and goes whole.
 */

const HEAD = 7;
const WHITE = { E: '#ffffff' } as const;

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
  const rows = front.slice(0, 8).map((line) => line.replace(/[^o.hH]/g, fill));
  return [...rows, `...o${fill.repeat(8)}o...`, neck];
}

interface CrewSpec extends Omit<PersonSpec, 'head' | 'parts'> {
  front: Rows;
  right: Rows;
  /** The letter of the back of the head: `h` for hair, `s` for a bald head or a robot's. */
  back: string;
  /** A layer drawn over the head in every pose (Leela's ponytail), moving with it. */
  over?: Readonly<Record<Direction, Part>>;
}

function crew(spec: CrewSpec): CharacterArt {
  const { front, right, back, over, ...rest } = spec;
  const up = backFrom(front, back);
  const at = (rows: Rows): Part => ({ top: HEAD, rows });
  const art = person({
    ...rest,
    palette: { ...COMMON, ...WHITE, ...rest.palette },
    head: { down: front, up, right },
    parts: {
      down: {
        head: at(front),
        'head-blink': at(shut(front)),
        'head-work': at(lookAt(front, 1)),
        'head-up': at(lookAt(front, -1)),
        'head-up2': at(lookAt(front, -1, 1)),
        'head-sleep': at(shut(front)),
      },
      up: { head: at(up) },
      right: { head: at(right), 'head-blink': at(shut(right)), 'head-work': at(lookAt(right, 1)) },
    },
  });
  if (over === undefined) return art;
  const layer = (direction: Direction): CostumeLayer[] => [{ name: 'hair-top', after: 'head', part: over[direction] }];
  return { ...art, extra: { down: layer('down'), up: layer('up'), right: layer('right') } };
}

const PONYTAIL: Part = { top: 4, rows: ['.......oo.......', '......ohho......', '......ohHo......'] };
const PONYTAIL_SIDE: Part = { top: 4, rows: ['....oo..........', '...ohho.........', '...ohHo.........'] };

/** Leela: the one big eye, the purple hair in a high ponytail, a white tank top, black trousers. */
export const LEELA: CharacterArt = crew({
  id: 'leela',
  palette: { s: '#f7d3b8', S: '#d6a88a', m: '#b8545e', h: '#7b3fa0', H: '#a066c8', J: '#f4f2ec', K: '#cfccc4', i: '#f4f2ec', t: '#f4f2ec', T: '#cfccc4', n: '#2b2b33', N: '#1d1d24' },
  front: [
    '......oooo......',
    '....oohhhhoo....',
    '...ohhhhHhhho...',
    '..ohhhhhhhhhho..',
    '..ohhsssssshho..',
    '..ohssEEEEssho..',
    '..ohssEeeEssho..',
    '..ohssEEEEssho..',
    '..ohsssmmsssho..',
    '..ohhossssohho..',
  ],
  right: [
    '.....oooo.......',
    '...oohhhhoo.....',
    '..ohhhhhhhhoo...',
    '..ohhhhhhhhhho..',
    '..ohhhhhhsssso..',
    '..ohhhhhsEEEso..',
    '..ohhhhSsEeEso..',
    '..ohhhhssEEEso..',
    '...ohhssssmso...',
    '....ohossoo.....',
  ],
  back: 'h',
  over: { down: PONYTAIL, up: PONYTAIL, right: PONYTAIL_SIDE },
  garment: { kind: 'shirt', short: true },
});

/** Fry: the orange hair swept up, a red jacket open on a white T-shirt, blue jeans. */
export const FRY: CharacterArt = crew({
  id: 'fry',
  palette: { s: '#f6cfa8', S: '#d4a27c', m: '#a0473c', h: '#e8641c', H: '#f5894a', J: '#c8342c', K: '#9a2620', i: '#f4f2ec', t: '#f4f2ec', T: '#d0cdc4', n: '#3d63a8', N: '#2e4c82' },
  front: [
    '....oooooo......',
    '...ohhhhhhoo....',
    '..ohhhHhhhhhoo..',
    '..ohhhhhhhhhho..',
    '..ohssssssssho..',
    '..osEEEssEEEso..',
    '..osEeEssEeEso..',
    '..oossssssssoo..',
    '...osssmmssso...',
    '....oossssoo....',
  ],
  right: [
    '....oooooo......',
    '...ohhhhhhoo....',
    '..ohhhhhhhhhoo..',
    '..ohhhhhhhhhho..',
    '..ohhssssssso...',
    '..ohhssssEEEo...',
    '..ohSssssEeEo...',
    '..ohssssssssso..',
    '...ossssssmso...',
    '....oossssoo....',
  ],
  back: 'h',
  garment: { kind: 'suit' },
});

/** Bender: the grey robot, the antenna with its ball, the visor with the two eyes, the grille of the mouth. */
export const BENDER: CharacterArt = crew({
  id: 'bender',
  palette: { s: '#a9b4bd', S: '#7f8b95', E: '#f6f1cf', m: '#4f5860', X: '#dfe4e8', x: '#3a3f45', h: '#a9b4bd', H: '#c4cdd4', J: '#a9b4bd', K: '#8a96a0', i: '#949fa8', t: '#949fa8', T: '#7f8b95', n: '#a9b4bd', N: '#8a96a0', k: '#5d666e' },
  front: [
    '.......oo.......',
    '......osso......',
    '.......oo.......',
    '....oossssoo....',
    '...osssssssso...',
    '..oxEEExxEEExo..',
    '..oxEeExxEeExo..',
    '..osssssssssso..',
    '..osmXmXmXmXso..',
    '...oooooooooo...',
  ],
  right: [
    '......oo........',
    '.....osso.......',
    '......oo........',
    '....oossssoo....',
    '...osssssssso...',
    '...osssssxEEEo..',
    '...osssssxEeEo..',
    '...ossssssssso..',
    '...ossssmXmXso..',
    '...oooooooooo...',
  ],
  back: 's',
  garment: { kind: 'shirt' },
});

/** The Professor: bald with white tufts over the ears, the thick glasses, the white lab coat on a light blue shirt. */
export const FARNSWORTH: CharacterArt = crew({
  id: 'farnsworth',
  palette: { s: '#f2cfb0', S: '#cfa587', m: '#8a4a42', h: '#e9e7e1', H: '#c9c6be', g: '#2b2b33', J: '#f4f4f0', K: '#cfcfc6', i: '#a8c8e0', t: '#a8c8e0', T: '#86a6c0', n: '#6a7360', N: '#545c4b' },
  front: [
    '.....oooooo.....',
    '...oossssssoo...',
    '..osssssssssso..',
    '..osssssssssso..',
    '.ohssssssssssho.',
    '.ohgEEEggEEEgho.',
    '.ohgEeEggEeEgho.',
    '..ohssssssssho..',
    '...osssmmssso...',
    '....oossssoo....',
  ],
  right: [
    '.....ooooo......',
    '...oossssoo.....',
    '..ossssssssoo...',
    '..osssssssssso..',
    '.ohhhsssssssso..',
    '.ohhhssssgEEEo..',
    '.ohhSssssgEeEo..',
    '..ohsssssssssso.',
    '...ossssssmso...',
    '....oossssoo....',
  ],
  back: 's',
  garment: { kind: 'coat' },
});

/** Amy: the black bob with the fringe, the lipstick, a pink tracksuit. */
export const AMY: CharacterArt = crew({
  id: 'amy',
  palette: { s: '#f4d2b4', S: '#d4a688', m: '#d0507a', p: '#f0a0a8', h: '#1a1418', H: '#3a3036', J: '#f07aa8', K: '#c8588a', i: '#f8b6d0', t: '#f8b6d0', T: '#e090b0', n: '#f07aa8', N: '#c8588a' },
  front: [
    '......oooo......',
    '....oohhhhoo....',
    '...ohhhhHhhho...',
    '..ohhhhhhhhhho..',
    '..ohhhhhhhhhho..',
    '..ohsEEssEEsho..',
    '..ohsEessEesho..',
    '..ohpsssssspho..',
    '..ohsssmmsssho..',
    '..ohhossssohho..',
  ],
  right: [
    '.....oooo.......',
    '...oohhHhoo.....',
    '..ohhhHHhhho....',
    '..ohhhhhhhhho...',
    '..ohhhhhhhhhho..',
    '..ohhhhhssEEso..',
    '..ohhhhSssEeso..',
    '..ohhhhssssspo..',
    '..ohhhhssssmso..',
    '..ohhhhhossso...',
  ],
  back: 'h',
  garment: { kind: 'shirt' },
});

/** Hermes: the black flat-top, a dark red short-sleeved shirt, grey trousers: the bureaucrat of the company. */
export const HERMES: CharacterArt = crew({
  id: 'hermes',
  palette: { s: '#7a4a2c', S: '#5c3620', m: '#3a1a14', h: '#141210', H: '#2e2a26', J: '#a8322e', K: '#7e2420', i: '#a8322e', t: '#a8322e', T: '#7e2420', n: '#5a5f66', N: '#44484e' },
  front: [
    '...oooooooooo...',
    '...ohhhhhhhho...',
    '...ohhhHhhhho...',
    '..oohhhhhhhhoo..',
    '..osssssssssso..',
    '..osEEEssEEEso..',
    '..osEeEssEeEso..',
    '..oossssssssoo..',
    '...osssmmssso...',
    '....oossssoo....',
  ],
  right: [
    '...oooooooo.....',
    '...ohhhhhhho....',
    '...ohhhHhhho....',
    '..oohhhhhhhhoo..',
    '..ohhssssssso...',
    '..ohsssssEEEo...',
    '..ohSssssEeEo...',
    '..osssssssssso..',
    '...ossssssmso...',
    '....oossssoo....',
  ],
  back: 'h',
  garment: { kind: 'shirt', short: true },
});

/** Zoidberg: the red crustacean, the eyes on their stalks, the tentacles in place of the mouth, the white coat of the doctor. */
export const ZOIDBERG: CharacterArt = crew({
  id: 'zoidberg',
  palette: { s: '#e8806a', S: '#c05a48', m: '#a8443a', J: '#f4f4f0', K: '#cfcfc6', i: '#d84c3c', t: '#d84c3c', T: '#a8443a', n: '#3c4a6a', N: '#2e3a54' },
  front: [
    '..ooo......ooo..',
    '.oEEEo....oEEEo.',
    '.oEeEo....oEeEo.',
    '..oossssssssoo..',
    '..osssssssssso..',
    '.osssssssssssso.',
    '.osssSssssSssso.',
    '.osssssssssssso.',
    '..osmmsmmsmmso..',
    '...omomoomomo...',
  ],
  right: [
    '.......ooo......',
    '......oEEEo.....',
    '......oEeEo.....',
    '....oossssoo....',
    '...osssssssso...',
    '..osssssssssso..',
    '..oSssssssssssso',
    '..ossssssssssso.',
    '...ossssmmsmmo..',
    '....oossomomo...',
  ],
  back: 's',
  garment: { kind: 'coat' },
});

/** The crew of the theme Planet Express in the order of pack.json: `SERIES` of originals.ts takes them after the others. */
export const FUTURAMA: readonly { art: CharacterArt; name: string }[] = [
  { art: LEELA, name: 'Leela' },
  { art: BENDER, name: 'Bender' },
  { art: FARNSWORTH, name: 'Prof. Farnsworth' },
  { art: AMY, name: 'Amy' },
  { art: HERMES, name: 'Hermes' },
  { art: ZOIDBERG, name: 'Zoidberg' },
  { art: FRY, name: 'Fry' },
];
