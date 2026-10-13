import type { CharacterArt } from '../compose.ts';

/**
 * GOD (D-127): an old developer in a purple robe with a golden trim, a white
 * beard and a golden halo over the head, holding a glowing tablet when he
 * reads. Original art of the project (D-060), in the rows of the others:
 * the head starts higher (row 4) to fit the halo, 17–25 body, 26–31 legs.
 */
const HEAD = 4;
const BODY = 17;
const LEGS = 26;

function variant(base: readonly string[], lines: Record<number, string>): string[] {
  return base.map((line, index) => lines[index] ?? line);
}

const halo = ['.....yyyyyy.....', '....y......y....', '.....YYYYYY.....'];
/** A face row without eyes: looking down or up. */
const FACE = `...o${'s'.repeat(8)}o...`;
const dimHalo = ['.....YYYYYY.....', '....Y......Y....', '.....YYYYYY.....'];

const headFront = [
  ...halo,
  '.....oooooo.....',
  '....owwwwwwo....',
  '...owssssssWo...',
  '...osossssoso...',
  '...ossssSssso...',
  '...owwwwwwwwo...',
  '...owwWooWwwo...',
  '....owwwwwwo....',
  '.....owWWwo.....',
  '......oooo......',
];

const bodyFront = [
  '.....owwwwo.....',
  '..oooppttppooo..',
  '.opopppttpppopo.',
  '.opopppttpppopo.',
  '.oPopppttpppoPo.',
  '.osoppPttPpposo.',
  '...oppPttPppo...',
  '...oPPPttPPPo...',
  '...oooooooooo...',
];

const legsFront = ['...oppppppppo...', '...oppppppppo...', '...oPPPPPPPPo...', '....oPPooPPo....', '....okko.okko...', '....oooo.oooo...'];
const stepFront1 = ['...oppppppppo...', '...oppppppppo...', '...oPPPPPPPPo...', '...oPPo..oPPo...', '..okkko..okko...', '..oooo...oooo...'];
const stepFront2 = ['...oppppppppo...', '...oppppppppo...', '...oPPPPPPPPo...', '...oPPo..oPPo...', '...okko..okkko..', '...oooo...oooo..'];

const headBack = [
  ...halo,
  '.....oooooo.....',
  '....owwwwwwo....',
  '...owwwwwwwwo...',
  '...owwwwwwwwo...',
  '...owwwWwwwwo...',
  '...owwwwwwwwo...',
  '...owwwwWwwwo...',
  '....owwwwwwo....',
  '.....owWWwo.....',
  '......oooo......',
];

const bodyBack = [
  '.....oppppo.....',
  '..oooppppppooo..',
  '.opopppPPpppopo.',
  '.opopppPPpppopo.',
  '.opopppPPpppopo.',
  '.osopppPPppposo.',
  '...opppPPpppo...',
  '...oPPPPPPPPo...',
  '...oooooooooo...',
];

const headSide = [
  ...halo,
  '.....oooooo.....',
  '....owwwwwwo....',
  '....owwwssso....',
  '....owwwssoso...',
  '....owwwsssSo...',
  '....owwwwwwwo...',
  '....owwwwwWwo...',
  '.....owwwwwwo...',
  '......owwwWo....',
  '.......ooo......',
];

const bodySide = [
  '......owwo......',
  '....oooppooo....',
  '....opppptpo....',
  '....oppPptpo....',
  '....oppPptpo....',
  '....opsPptpo....',
  '....oppPptpo....',
  '....oPPPPtPo....',
  '....oooooooo....',
];

const legsSide = ['.....opppppo....', '.....opppppo....', '.....oPPPPPo....', '......oPPo......', '......okkko.....', '......ooooo.....'];

const raisedArm = [
  '..............oo',
  '.............oso',
  '.............oso',
  '.............opo',
  '.............opo',
  '.............opo',
  '.............opo',
  '.............opo',
  '............opo.',
];

export const GOD: CharacterArt = {
  id: 'god',
  palette: {
    o: '#1a1c2c',
    s: '#e8b796',
    S: '#c98f6e',
    w: '#eef0f2',
    W: '#b9c0c8',
    y: '#f5d442',
    Y: '#c99a1e',
    p: '#6a4a9e',
    P: '#4a3275',
    t: '#e0b23a',
    b: '#4fd1c1',
    B: '#2a8f84',
    k: '#2b2b3a',
  },
  parts: {
    down: {
      head: { top: HEAD, rows: headFront },
      'head-blink': { top: HEAD, rows: variant(headFront, { 6: '...osSssssSso...' }) },
      'head-work': { top: HEAD, rows: variant(headFront, { 6: FACE, 7: '...osossssoso...' }) },
      'head-up': { top: HEAD, rows: variant(headFront, { 5: '...owossssowo...', 6: FACE }) },
      'head-up2': { top: HEAD, rows: variant(headFront, { 0: '......yyyyyy....', 5: '...owossssowo...', 6: FACE }) },
      'head-sleep': { top: HEAD, rows: variant(headFront, { 0: dimHalo[0] ?? '', 1: dimHalo[1] ?? '', 2: dimHalo[2] ?? '', 6: '...osSSssSSso...' }) },
      body: { top: BODY, rows: bodyFront },
      'body-type': { top: BODY, rows: variant(bodyFront, { 2: '..oopppttpppoo..', 3: '..ossppttppppo..', 4: '..oppppttppsso..', 5: '..oopppttpppoo..' }) },
      'body-type2': { top: BODY, rows: variant(bodyFront, { 2: '..oopppttpppoo..', 3: '..oppppttppsso..', 4: '..ossppttppppo..', 5: '..oopppttpppoo..' }) },
      'body-read': { top: BODY, rows: variant(bodyFront, { 2: '..oopppttpppoo..', 3: '..opbbbbbbbbpo..', 4: '..osbbwbbbbbso..', 5: '..oopBBBBBBpoo..' }) },
      'body-read2': { top: BODY, rows: variant(bodyFront, { 2: '..oopppttpppoo..', 3: '..opbbbbbbbbpo..', 4: '..osbbbbbwbbso..', 5: '..oopBBBBBBpoo..' }) },
      'body-think': { top: BODY, rows: variant(bodyFront, { 0: '.....owwwwos....', 1: '..oooppttppooso.', 2: '.opopppttpppopo.' }) },
      'body-wait': { top: BODY, rows: variant(bodyFront, { 2: '.opopppttpppo...', 3: '.opopppttpppo...', 4: '.oPopppttpppo...', 5: '.osoppPttPppo...' }) },
      'over-wait': { top: 10, rows: raisedArm },
      'over-wait2': { top: 9, rows: [...raisedArm.slice(0, 8), '.............opo', '............opo.'] },
      legs: { top: LEGS, rows: legsFront },
      'legs-step1': { top: LEGS, rows: stepFront1 },
      'legs-step2': { top: LEGS, rows: stepFront2 },
    },
    up: {
      head: { top: HEAD, rows: headBack },
      'head-sleep': { top: HEAD, rows: variant(headBack, { 0: dimHalo[0] ?? '', 1: dimHalo[1] ?? '', 2: dimHalo[2] ?? '' }) },
      body: { top: BODY, rows: bodyBack },
      'body-type': { top: BODY, rows: variant(bodyBack, { 2: '..oopppPPpppoo..', 3: '..opppPPPPpppo..', 4: '..opppPPPPpppo..', 5: '..oopppPPpppoo..' }) },
      'body-read': { top: BODY, rows: variant(bodyBack, { 2: '..oopppPPpppoo..', 3: '..opppPPPPpppo..', 4: '..opppPPPPpppo..', 5: '..oopppPPpppoo..' }) },
      legs: { top: LEGS, rows: legsFront },
      'legs-step1': { top: LEGS, rows: stepFront1 },
      'legs-step2': { top: LEGS, rows: stepFront2 },
    },
    right: {
      head: { top: HEAD, rows: headSide },
      'head-blink': { top: HEAD, rows: variant(headSide, { 6: '....owwwssSso...' }) },
      body: { top: BODY, rows: bodySide },
      'body-type': { top: BODY, rows: variant(bodySide, { 3: '....oppPppssso..', 4: '....oppPptpo....', 5: '....oppPptpo....' }) },
      'body-type2': { top: BODY, rows: variant(bodySide, { 3: '....oppPpppsso..', 4: '....oppPptpo....', 5: '....oppPptpo....' }) },
      'body-read': { top: BODY, rows: variant(bodySide, { 3: '....oppPpbbbo...', 4: '....oppPpbbso...', 5: '....oppPptpo....' }) },
      'body-read2': { top: BODY, rows: variant(bodySide, { 3: '....oppPpbwbo...', 4: '....oppPpbbso...', 5: '....oppPptpo....' }) },
      legs: { top: LEGS, rows: legsSide },
      'legs-step1': { top: LEGS, rows: ['.....opppppo....', '.....opppppo....', '.....oPPPPPo....', '.....oPo.oPo....', '....okko.okko...', '....oooo.oooo...'] },
      'legs-step2': { top: LEGS, rows: ['.....opppppo....', '.....opppppo....', '.....oPPPPPo....', '......oPPo......', '.....okkko......', '.....ooooo......'] },
    },
  },
};
