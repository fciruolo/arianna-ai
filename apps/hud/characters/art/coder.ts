import type { CharacterArt } from '../compose.ts';

/**
 * The Coder: a small robot with a visor, an amber antenna and a cyan light.
 * Original art of the project (D-060). Same rows as Arianna: 7–16 head,
 * 17–25 body, 26–31 legs.
 */
const HEAD = 7;
const BODY = 17;
const LEGS = 26;

function variant(base: readonly string[], lines: Record<number, string>): string[] {
  return base.map((line, index) => lines[index] ?? line);
}

const headFront = [
  '.......ao.......',
  '.......oo.......',
  '....oooooooo....',
  '...oggggggggo...',
  '...ogvvvvvvgo...',
  '...ogvcvvcvgo...',
  '...ogvvvvvvgo...',
  '...oggggggggo...',
  '...ogGGGGGGgo...',
  '....oooooooo....',
];

const bodyFront = [
  '.....oGGGGo.....',
  '..oooooooooooo..',
  '.ogobbbbbbbbogo.',
  '.ogobbccbbbbogo.',
  '.ogobbbbbbbbogo.',
  '.okobbbbbbbboko.',
  '...oGGGGGGGGo...',
  '...oggggggggo...',
  '...oooooooooo...',
];

const legsFront = ['....ogo..ogo....', '....ogo..ogo....', '....ogo..ogo....', '...oGGo..oGGo...', '...okko..okko...', '...oooo..oooo...'];

const headBack = [
  '.......ao.......',
  '.......oo.......',
  '....oooooooo....',
  '...oggggggggo...',
  '...ogGGGGGGgo...',
  '...ogGggggGgo...',
  '...ogGggggGgo...',
  '...ogGGGGGGgo...',
  '...oggggggggo...',
  '....oooooooo....',
];

const bodyBack = [
  '.....oGGGGo.....',
  '..oooooooooooo..',
  '.ogobbbbbbbbogo.',
  '.ogobBBBBBBbogo.',
  '.ogobBbbbbBbogo.',
  '.okobBBBBBBboko.',
  '...oGGGGGGGGo...',
  '...oggggggggo...',
  '...oooooooooo...',
];

const headSide = [
  '.......ao.......',
  '.......oo.......',
  '....ooooooo.....',
  '...oggggggggo...',
  '...ogggggvvvo...',
  '...ogggggvvco...',
  '...ogggggvvvo...',
  '...oggggggggo...',
  '...ogGGGGGGGo...',
  '....oooooooo....',
];

const bodySide = [
  '......oGGo......',
  '....oooooooo....',
  '....obbbbbbo....',
  '....obbgbbbo....',
  '....obbgbbbo....',
  '....obbkbbbo....',
  '....oGGGGGGo....',
  '....oggggggo....',
  '....oooooooo....',
];

const raisedArm = [
  '..............oo',
  '.............oko',
  '.............oko',
  '.............ogo',
  '.............ogo',
  '.............ogo',
  '.............ogo',
  '.............ogo',
  '............ogo.',
];

export const CODER: CharacterArt = {
  id: 'coder',
  palette: {
    o: '#1a1c2c',
    g: '#8fa3ad',
    G: '#5d707a',
    v: '#1d2b3a',
    c: '#4fd1c1',
    C: '#2a8f84',
    w: '#dcebe8',
    a: '#f2b34b',
    b: '#3b6f8f',
    B: '#2c5570',
    k: '#2b2b3a',
  },
  parts: {
    down: {
      head: { top: HEAD, rows: headFront },
      'head-blink': { top: HEAD, rows: variant(headFront, { 5: '...ogvCvvCvgo...' }) },
      'head-work': { top: HEAD, rows: variant(headFront, { 5: '...ogvvvvvvgo...', 6: '...ogvcvvcvgo...' }) },
      'head-read2': { top: HEAD, rows: variant(headFront, { 5: '...ogvvvvvvgo...', 6: '...ogcvvcvvgo...' }) },
      'head-up': { top: HEAD, rows: variant(headFront, { 4: '...ogvcvvcvgo...', 5: '...ogvvvvvvgo...' }) },
      'head-up2': { top: HEAD, rows: variant(headFront, { 0: '.......ko.......', 4: '...ogvvcvvcgo...', 5: '...ogvvvvvvgo...' }) },
      'head-sleep': { top: HEAD, rows: variant(headFront, { 0: '.......ko.......', 5: '...ogvCCvCCgo...' }) },
      body: { top: BODY, rows: bodyFront },
      'body-type': {
        top: BODY,
        rows: variant(bodyFront, { 2: '..oobbbbbbbboo..', 3: '..ogbbccbbbbgo..', 4: '..ogkkbbbbbbgo..', 5: '..oobbbbbbkkoo..' }),
      },
      'body-type2': {
        top: BODY,
        rows: variant(bodyFront, { 2: '..oobbbbbbbboo..', 3: '..ogbbccbbbbgo..', 4: '..ogbbbbbbkkgo..', 5: '..ookkbbbbbboo..' }),
      },
      'body-read': {
        top: BODY,
        rows: variant(bodyFront, { 2: '..oobbbbbbbboo..', 3: '..ogbccccccbgo..', 4: '..okccwcccccko..', 5: '..oobbbbbbbboo..' }),
      },
      'body-read2': {
        top: BODY,
        rows: variant(bodyFront, { 2: '..oobbbbbbbboo..', 3: '..ogbccccccbgo..', 4: '..okcccccwccko..', 5: '..oobbbbbbbboo..' }),
      },
      'body-think': {
        top: BODY,
        rows: variant(bodyFront, {
          0: '.....oGGGGoko...',
          1: '..oooooooooogo..',
          2: '.ogobbbbbbbbgo..',
          3: '.ogobbccbbbbo...',
          4: '.ogobbbbbbbbo...',
          5: '.okobbbbbbbbo...',
        }),
      },
      'body-wait': {
        top: BODY,
        rows: variant(bodyFront, { 3: '.ogobbccbbbbo...', 4: '.ogobbbbbbbbo...', 5: '.okobbbbbbbbo...' }),
      },
      'over-wait': { top: 10, rows: raisedArm },
      'over-wait2': { top: 9, rows: [...raisedArm.slice(0, 8), '.............ogo', '............ogo.'] },
      legs: { top: LEGS, rows: legsFront },
      'legs-step1': {
        top: LEGS,
        rows: ['....ogo..ogo....', '....ogo..ogo....', '...oGGo..ogo....', '...okko..oGGo...', '...oooo..okko...', '.........oooo...'],
      },
      'legs-step2': {
        top: LEGS,
        rows: ['....ogo..ogo....', '....ogo..ogo....', '....ogo..oGGo...', '...oGGo..okko...', '...okko..oooo...', '...oooo.........'],
      },
    },
    up: {
      head: { top: HEAD, rows: headBack },
      'head-sleep': { top: HEAD, rows: variant(headBack, { 0: '.......ko.......' }) },
      body: { top: BODY, rows: bodyBack },
      'body-type': {
        top: BODY,
        rows: variant(bodyBack, { 2: '..oobbbbbbbboo..', 3: '..ogbBBBBBBbgo..', 4: '..ogbBbbbbBbgo..', 5: '..oobBBBBBBboo..' }),
      },
      'body-type2': {
        top: BODY,
        rows: variant(bodyBack, { 2: '..oobbbbbbbboo..', 3: '..ogbBBBBBBbgo..', 4: '..okbBbbbbBbgo..', 5: '..oobBBBBBBboo..' }),
      },
      'body-read': {
        top: BODY,
        rows: variant(bodyBack, { 2: '..oobbbbbbbboo..', 3: '..ogbBBBBBBbgo..', 4: '..ogbBbbbbBbgo..', 5: '..oobBBBBBBboo..' }),
      },
      legs: { top: LEGS, rows: legsFront },
      'legs-step1': {
        top: LEGS,
        rows: ['....ogo..ogo....', '....ogo..ogo....', '...oGGo..ogo....', '...okko..oGGo...', '...oooo..okko...', '.........oooo...'],
      },
      'legs-step2': {
        top: LEGS,
        rows: ['....ogo..ogo....', '....ogo..ogo....', '....ogo..oGGo...', '...oGGo..okko...', '...okko..oooo...', '...oooo.........'],
      },
    },
    right: {
      head: { top: HEAD, rows: headSide },
      'head-blink': { top: HEAD, rows: variant(headSide, { 5: '...ogggggvvCo...' }) },
      body: { top: BODY, rows: bodySide },
      'body-type': { top: BODY, rows: variant(bodySide, { 3: '....obbbbgggko..', 4: '....obbbbbbo....', 5: '....obbbbbbo....' }) },
      'body-type2': { top: BODY, rows: variant(bodySide, { 3: '....obbbbbggko..', 4: '....obbbbbbo....', 5: '....obbbbbbo....' }) },
      'body-read': { top: BODY, rows: variant(bodySide, { 3: '....obbbgggcco..', 4: '....obbbbbbcco..', 5: '....obbbbbbo....' }) },
      'body-read2': { top: BODY, rows: variant(bodySide, { 3: '....obbbgggcwo..', 4: '....obbbbbbcco..', 5: '....obbbbbbo....' }) },
      legs: { top: LEGS, rows: ['......oggo......', '......oggo......', '......oggo......', '......oGGo......', '......okkko.....', '......ooooo.....'] },
      'legs-step1': {
        top: LEGS,
        rows: ['......oggo......', '.....og..go.....', '....og....go....', '....oG....Go....', '...okk....kko...', '...ooo....ooo...'],
      },
      'legs-step2': {
        top: LEGS,
        rows: ['......oggo......', '......oggo......', '.....og..go.....', '.....oG..Go.....', '....okk..kko....', '....ooo..ooo....'],
      },
    },
  },
};
