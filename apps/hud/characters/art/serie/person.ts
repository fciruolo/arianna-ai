import type { CharacterArt, Direction, Part } from '../../compose.ts';

/**
 * A person of a series (D-211), built from a few maps instead of 28 poses
 * drawn one by one: the head in three directions, the garment, the legs and
 * optional overlays (long hair on the shoulders, a stethoscope). The poses
 * of the format of D-060 (blink, look down, look up, sleep, type, read,
 * think, wait) are derived here from the same skeleton, so every person
 * moves the same way. Rows as the originals: 7–16 head, 17–25 body, 26–31 legs.
 *
 * Letters are roles, the colours come from each person's palette:
 * o outline, s/S skin and its shade, e eyes, m mouth, p cheeks, h/H hair,
 * J/K the outer garment and its shade, i the inner one (shirt, blouse),
 * t/T tie, n/N trousers or skirt, k shoes, b/B/w a sheet of paper,
 * g/G glasses, x/X an accessory.
 */
const HEAD = 7;
const BODY = 17;
const LEGS = 26;

export type Rows = readonly string[];
type Three = Readonly<Record<Direction, Rows>>;

function variant(base: Rows, lines: Record<number, string>): string[] {
  return base.map((line, index) => lines[index] ?? line);
}

function put(line: string, at: number, text: string): string {
  return line.slice(0, at) + text + line.slice(at + text.length);
}

/** `mask` drawn over `rows`: every letter but `.` wins. */
function overlay(rows: Rows, mask: Rows | undefined, top = 0): string[] {
  if (mask === undefined) return [...rows];
  return rows.map((line, index) => {
    const over = mask[index - top];
    if (over === undefined) return line;
    return line.replace(/./g, (letter, x: number) => (over[x] !== undefined && over[x] !== '.' ? over[x] : letter));
  });
}

// ---------------------------------------------------------------- garments

/**
 * The garments, front / back / side, 9 rows from row 17. Front: the arms
 * are columns 1–3 and 12–14 (outline, sleeve, outline), the torso 4–11.
 * Side, facing right: the torso 4–11, the arm on column 7, the chest on 10.
 */
export type GarmentKind = 'scrubs' | 'shirt' | 'suit' | 'coat' | 'cardigan';

export interface Garment {
  kind: GarmentKind;
  /** Short sleeves show the forearm (scrubs, Dwight's shirt). */
  short?: boolean;
  /** A tie on the shirt (shirt, suit, coat). */
  tie?: boolean;
}

function garmentRows(garment: Garment): Three {
  const short = garment.short === true;
  // Rows 2–5 of the arms, front: sleeve, sleeve, sleeve or forearm, hand.
  const arm = short ? ['J', 'K', 's', 's'] : ['J', 'J', 'K', 's'];
  const sideArm = short ? ['J', 'K', 's', 's'] : ['J', 'J', 'K', 's'];
  const front = (torso: Rows, top: readonly [string, string]): string[] => [
    top[0],
    top[1],
    ...torso.slice(0, 4).map((middle, index) => `.o${arm[index] ?? 'J'}o${middle}o${arm[index] ?? 'J'}o.`),
    `...o${torso[4] ?? ''}o...`,
    '...onnnnnnnno...',
    '...onnnnnnnno...',
  ];
  const back = (top: string, torso: string, hem: string): string[] => [
    top,
    '..oJJJJJJJJJJo..',
    ...arm.map((letter) => `.o${letter}o${torso}o${letter}o.`),
    `...o${hem}o...`,
    '...onnnnnnnno...',
    '...onnnnnnnno...',
  ];
  const side = (neck: string, chest: readonly string[], hem: string, legs = 'nnnnnn'): string[] => [
    neck,
    `....oJJJJ${chest[0] ?? 'JJ'}o....`,
    ...sideArm.map((letter, index) => `....oJJ${letter}J${chest[index + 1] ?? 'JJ'}o....`),
    `....o${hem}o....`,
    `....o${legs}o....`,
    `....o${legs}o....`,
  ];
  const tie = garment.tie === true;
  switch (garment.kind) {
    case 'scrubs':
      return {
        down: front(['JJJJJJJJ', 'JJJJJJJJ', 'JJJJJJKJ', 'JJJJJJJJ', 'KKKKKKKK'],['...ooJssssJoo...', '..oJJJJssJJJJo..']),
        up: back('...ooJJJJJJoo...', 'JJJJJJJJ', 'KKKKKKKK'),
        right: side('......osso......', ['ss', 'sJ', 'JJ', 'JJ', 'JJ'], 'KKKKKK'),
      };
    case 'shirt':
      return {
        down: front(tie ? ['JJJttJJJ', 'JJJttJJJ', 'JJJTTJJJ', 'JJJttJJJ', 'JJJJJJJJ'] : ['JJJiJJJJ', 'JJJiJJJJ', 'JJJiJJJJ', 'JJJiJJJJ', 'JJJJJJJJ'], [
          '...ooiittiioo...',
          '..oJJJittiJJJo..',
        ]),
        up: back('...ooiiiiiioo...', 'JJJJJJJJ', 'JJJJJJJJ'),
        right: side('......oiio......', tie ? ['it', 'Jt', 'Jt', 'JT', 'Jt'] : ['iJ', 'JJ', 'JJ', 'JJ', 'JJ'], 'JJJJJJ'),
      };
    case 'suit':
      return {
        down: front(['JJittiJJ', 'JJKttKJJ', 'JJJKKJJJ', 'JJJKKJJJ', 'JJJJJJJJ'], ['...ooJittiJoo...', '..oJJJittiJJJo..']),
        up: back('...ooJJJJJJoo...', 'JJJJJJJJ', 'JJJJJJJJ'),
        right: side('......oiio......', ['it', 'it', 'Jt', 'JK', 'JK'], 'JJJJJJ'),
      };
    case 'coat': {
      const inner = tie ? ['JJittiJJ', 'JJittiJJ', 'JKiTTiKJ', 'JJittiJJ', 'JJiiiiJJ'] : ['JJiiiiJJ', 'JJiiiiJJ', 'JKiiiiKJ', 'JJiiiiJJ', 'JJiiiiJJ'];
      const rows = front(inner, ['...ooJiiiiJoo...', '..oJJJiiiiJJJo..']);
      return {
        down: [...rows.slice(0, 7), '...oJJnnnnJJo...', '...oJJnnnnJJo...'],
        up: [...back('...ooJJJJJJoo...', 'JJJJJJJJ', 'JJJJJJJJ').slice(0, 7), '...oJJJKKJJJo...', '...oJJJKKJJJo...'],
        right: side('......oiio......', tie ? ['it', 'Jt', 'Jt', 'JT', 'Ji'] : ['ii', 'Ji', 'Ji', 'Ji', 'Ji'], 'JJJJJi', 'JJJJnn'),
      };
    }
    case 'cardigan':
      return {
        down: front(['JJissiJJ', 'JJiiiiJJ', 'JJKiiKJJ', 'JJJiiJJJ', 'JJJJJJJJ'], ['...ooJissiJoo...', '..oJJJissiJJJo..']),
        up: back('...ooJJJJJJoo...', 'JJJJJJJJ', 'JJJJJJJJ'),
        right: side('......osso......', ['si', 'Ji', 'Ji', 'Ji', 'JJ'], 'JJJJJJ'),
      };
  }
}

// ---------------------------------------------------------------- legs

export type LegsKind = 'trousers' | 'skirt';

const LEGS_ROWS: Readonly<Record<LegsKind, Readonly<Record<'front' | 'step1' | 'step2' | 'side' | 'side1' | 'side2', Rows>>>> = {
  trousers: {
    front: ['...onno..onno...', '...onno..onno...', '...onNo..oNno...', '...onno..onno...', '...okko..okko...', '...oooo..oooo...'],
    step1: ['...onno..onno...', '...onno..onno...', '...okko..onNo...', '...oooo..onno...', '.........okko...', '.........oooo...'],
    step2: ['...onno..onno...', '...onno..onno...', '...onNo..okko...', '...onno..oooo...', '...okko.........', '...oooo.........'],
    side: ['.....onnnno.....', '.....onnnno.....', '......onno......', '......onno......', '......okkko.....', '......ooooo.....'],
    side1: ['.....onnnno.....', '....onno.ono....', '...onno...ono...', '...ono....ono...', '..okko....okko..', '..oooo....oooo..'],
    side2: ['.....onnnno.....', '.....onnnno.....', '....onno.ono....', '....ono..ono....', '...okko..okko...', '...oooo..oooo...'],
  },
  skirt: {
    front: ['...oNNNNNNNNo...', '....oso..oso....', '....oso..oso....', '....oso..oso....', '...okko..okko...', '...oooo..oooo...'],
    step1: ['...oNNNNNNNNo...', '....oso..oso....', '...okko..oso....', '...oooo..oso....', '.........okko...', '.........oooo...'],
    step2: ['...oNNNNNNNNo...', '....oso..oso....', '....oso..okko...', '....oso..oooo...', '...okko.........', '...oooo.........'],
    side: ['....oNNNNNNo....', '......osso......', '......osso......', '......osso......', '......okkko.....', '......ooooo.....'],
    side1: ['....oNNNNNNo....', '.....os..so.....', '....os....so....', '....os....so....', '...okk....kko...', '...ooo....ooo...'],
    side2: ['....oNNNNNNo....', '......osso......', '.....os..so.....', '.....os..so.....', '....okk..kko....', '....ooo..ooo....'],
  },
};

// ---------------------------------------------------------------- the person

export interface PersonSpec {
  id: string;
  palette: Readonly<Record<string, string>>;
  /** 10 rows each, from row 7. The front has its eyes (`e`) on row 6 of the map, the side on row 6 too. */
  head: Three;
  garment: Garment;
  legs?: LegsKind;
  /** Drawn over every body pose of that direction, from row 17: long hair on the shoulders. */
  hair?: Partial<Three>;
  /** Drawn over every body pose but reading, from row 17 (a stethoscope): the sheet covers it. */
  accessory?: Partial<Three>;
  /** Parts drawn by hand, over the derived ones (`down.head-work`…). */
  parts?: Partial<Record<Direction, Readonly<Record<string, Part>>>>;
}

/** The columns of the eyes on a row. */
function eyes(line: string): number[] {
  const columns: number[] = [];
  for (let x = line.indexOf('e'); x >= 0; x = line.indexOf('e', x + 1)) columns.push(x);
  return columns;
}

/** The head with its eyes moved by `dy` rows (and `dx` columns); the cell they leave turns to skin. */
function look(rows: Rows, row: number, dy: number, dx = 0): string[] {
  const out = [...rows];
  const columns = eyes(rows[row] ?? '');
  out[row] = columns.reduce((line, x) => put(line, x, 's'), out[row] ?? '');
  const target = out[row + dy] ?? '';
  // Eyes looking up may cross a fringe: never an outline, never outside the head.
  out[row + dy] = columns.reduce((line, x) => (/[^o.]/.test(line[x + dx] ?? '.') ? put(line, x + dx, 'e') : line), target);
  return out;
}

const EYE_ROW = 6;

function headParts(head: Three): Record<Direction, Record<string, Part>> {
  const shut = (rows: Rows) => variant(rows, { [EYE_ROW]: (rows[EYE_ROW] ?? '').replaceAll('e', 'S') });
  const front = head.down;
  return {
    down: {
      head: { top: HEAD, rows: front },
      'head-blink': { top: HEAD, rows: shut(front) },
      'head-work': { top: HEAD, rows: look(front, EYE_ROW, 1) },
      'head-up': { top: HEAD, rows: look(front, EYE_ROW, -1) },
      'head-up2': { top: HEAD, rows: look(front, EYE_ROW, -1, 1) },
      'head-sleep': { top: HEAD, rows: variant(shut(front), { 8: (front[8] ?? '').replace('mm', 'sm') }) },
    },
    up: { head: { top: HEAD, rows: head.up } },
    right: {
      head: { top: HEAD, rows: head.right },
      'head-blink': { top: HEAD, rows: shut(head.right) },
      'head-work': { top: HEAD, rows: look(head.right, EYE_ROW, 1) },
    },
  };
}

/** The sleeve letter of a front row: column 2. */
function sleeve(rows: Rows, row: number): string {
  return (rows[row] ?? '')[2] ?? 'J';
}

function bodyParts(base: Three): Record<Direction, Record<string, Rows>> {
  const front = base.down;
  const torso = (row: number, from = 4, to = 12) => (front[row] ?? '').slice(from, to);
  const sleeveOf = sleeve(front, 2);
  const type = (first: 3 | 4): Rows =>
    variant(front, {
      2: `..oo${torso(2)}oo..`,
      3: first === 3 ? `..oss${torso(3, 5)}${sleeveOf}o..` : `..o${sleeveOf}${torso(3, 4, 11)}sso..`,
      4: first === 3 ? `..o${sleeveOf}${torso(4, 4, 11)}sso..` : `..oss${torso(4, 5)}${sleeveOf}o..`,
      5: `..oo${torso(5)}oo..`,
    });
  const read = (page: string): Rows =>
    variant(front, {
      2: `..oo${torso(2)}oo..`,
      3: `..o${sleeveOf}bbbbbbbb${sleeveOf}o..`,
      4: `..os${page}so..`,
      5: `..oo${sleeveOf}BBBBBB${sleeveOf}oo..`,
    });
  // The right arm leaves the side: up to the chin, or up in the air (the overlay of wait).
  const noRightArm = (rows: Rows): string[] => rows.map((line, index) => (index >= 2 && index <= 5 ? put(line, 12, 'o..') : line));
  const think = variant(noRightArm(front), {
    0: put(front[0] ?? '', 10, 'sso'),
    1: put(front[1] ?? '', 12, `${sleeveOf}${sleeveOf}o`),
    2: put(front[2] ?? '', 12, `o${sleeveOf}o`),
    3: put(front[3] ?? '', 12, 'oo.'),
  });

  const back = base.up;
  const backTorso = (row: number) => (back[row] ?? '').slice(4, 12);
  const backSleeve = sleeve(back, 2);
  const backWork = variant(back, {
    2: `..oo${backTorso(2)}oo..`,
    3: `..o${backSleeve}${backTorso(3)}${backSleeve}o..`,
    4: `..o${backSleeve}${backTorso(4)}${backSleeve}o..`,
    5: `..oo${backTorso(5)}oo..`,
  });

  const side = base.right;
  // The arm reaches forward: the hand where the keyboard or the sheet is; the hand at the side goes.
  const lowered = (rows: Rows) => rows.map((line, index) => (index >= 4 && index <= 5 ? put(line, 7, (side[3] ?? '')[6] ?? 'J') : line));
  const sideType = (at: number, reach: string): Rows => variant(lowered(side), { 3: put(side[3] ?? '', at, reach) });
  const sideRead = (page: string): Rows => variant(lowered(side), { 3: put(side[3] ?? '', 9, `${page}o`), 4: put(side[4] ?? '', 9, 'bbso') });
  return {
    down: {
      body: front,
      'body-type': type(3),
      'body-type2': type(4),
      'body-read': read('bbwbbbbb'),
      'body-read2': read('bbbbbwbb'),
      'body-think': think,
      'body-wait': noRightArm(front),
    },
    up: { body: back, 'body-type': backWork, 'body-read': backWork },
    right: {
      body: side,
      'body-type': sideType(10, 'ssso'),
      'body-type2': sideType(11, 'sso'),
      'body-read': sideRead('bbb'),
      'body-read2': sideRead('bwb'),
    },
  };
}

/** The raised right arm of the wait pose, from row 10: the hand, the forearm, the sleeve. */
function raisedArm(sleeveLetter: string, short: boolean, extra = 0): string[] {
  const forearm = short ? 4 : 2;
  const lines = ['..............oo'];
  for (let index = 0; index < 7 + extra; index++) lines.push(`.............o${index < forearm ? 's' : sleeveLetter}o`);
  lines.push(`............o${sleeveLetter}o.`);
  return lines;
}

export function person(spec: PersonSpec): CharacterArt {
  const garment = garmentRows(spec.garment);
  const bodies = bodyParts(garment);
  const legs = LEGS_ROWS[spec.legs ?? 'trousers'];
  const heads = headParts(spec.head);
  const short = spec.garment.short === true;
  const sleeveOf = sleeve(garment.down, 2);
  const parts = {} as Record<Direction, Record<string, Part>>;
  for (const direction of ['down', 'up', 'right'] as const) {
    const body: Record<string, Part> = {};
    for (const [name, rows] of Object.entries(bodies[direction])) {
      const dressed = name.startsWith('body-read') ? [...rows] : overlay(rows, spec.accessory?.[direction]);
      body[name] = { top: BODY, rows: overlay(dressed, spec.hair?.[direction]) };
    }
    const legParts: Record<string, Part> =
      direction === 'right'
        ? { legs: { top: LEGS, rows: legs.side }, 'legs-step1': { top: LEGS, rows: legs.side1 }, 'legs-step2': { top: LEGS, rows: legs.side2 } }
        : { legs: { top: LEGS, rows: legs.front }, 'legs-step1': { top: LEGS, rows: legs.step1 }, 'legs-step2': { top: LEGS, rows: legs.step2 } };
    parts[direction] = { ...heads[direction], ...body, ...legParts, ...spec.parts?.[direction] };
  }
  parts.down['over-wait'] = { top: 10, rows: raisedArm(sleeveOf, short) };
  parts.down['over-wait2'] = { top: 9, rows: raisedArm(sleeveOf, short, 1) };
  return { id: spec.id, palette: spec.palette, parts };
}

/** The colours every person shares: outline, eyes, the sheet of paper, shoes. */
export const COMMON: Readonly<Record<string, string>> = {
  o: '#1a1c2c',
  e: '#1b1b2a',
  b: '#f4ecd8',
  B: '#c9b98f',
  w: '#8a8f99',
  k: '#2b2b3a',
};
