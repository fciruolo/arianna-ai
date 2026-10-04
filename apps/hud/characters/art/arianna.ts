import type { CharacterArt } from '../compose.ts';

/**
 * Arianna: auburn hair, teal dress and the red thread she leaves behind
 * (Ariadne's). Original art of the project (D-060). Rows 7–16 head, 17–25
 * body, 26–31 legs; the thread hangs from her left hand.
 */
const HEAD = 7;
const BODY = 17;
const LEGS = 26;

const headFront = [
  '......oooo......',
  '....oohhHhoo....',
  '...ohhhHHhhho...',
  '..ohhhhhhhhhho..',
  '..ohhsssssshho..',
  '..ohssssssssho..',
  '..ohsessssesho..',
  '..ohpsssssspho..',
  '..ohsssmmsssho..',
  '..ohhossssohho..',
];

/** The head with some lines replaced: index → line. */
function variant(base: readonly string[], lines: Record<number, string>): string[] {
  return base.map((line, index) => lines[index] ?? line);
}

const bodyFront = [
  '..ohhhossohhho..',
  '..ohhoddddohho..',
  '..ooddddddddoo..',
  '.osDddddddddDso.',
  '.osDddDddDddDso.',
  '.osDddddddddDsr.',
  '..oDddddddddDo.r',
  '.oddddddddddddor',
  '.oooooooooooooor',
];

const legsFront = ['....oso..oso...r', '....oso..oso..r.', '....oso..oso...r', '....oko..oko..r.', '...okko..okko.r.', '...oooo..oooo..r'];

const headBack = [
  '......oooo......',
  '....oohhHhoo....',
  '...ohhhHHhhho...',
  '..ohhhhHhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhHhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
];

const bodyBack = [
  '..ohhhhhhhhhho..',
  '..ohhhhhhhhhho..',
  '..oohhhhhhhhoo..',
  '.osDdhhhhhhdDso.',
  '.osDddhhhhddDso.',
  '.rsDddddddddDso.',
  'r.oDddddddddDo..',
  'roddddddddddddo.',
  'roooooooooooooo.',
];

const legsBack = ['r...oso..oso....', '.r..oso..oso....', 'r...oso..oso....', '.r..oko..oko....', '.rokko..okko....', 'r..oooo..oooo...'];

const headSide = [
  '.....oooo.......',
  '...oohhHhoo.....',
  '..ohhhHHhhho....',
  '..ohhhhhhhhho...',
  '..ohhhhhsssso...',
  '..ohhhhsssssso..',
  '..ohhhhsssseso..',
  '..ohhhhssssspo..',
  '..ohhhhsssssmo..',
  '..ohhhhhossso...',
];

const bodySide = [
  '..ohhhhhoso.....',
  '..ohhhhoddo.....',
  '..ohhhoddddo....',
  '...ohoddsddo....',
  '....oddDsddo....',
  '....oddsdddo....',
  '...oddddddddo...',
  '..oddddddddddo..',
  '..oooooooooooo..',
];

export const ARIANNA: CharacterArt = {
  id: 'arianna',
  palette: {
    o: '#1a1c2c',
    h: '#8a3b2a',
    H: '#b5523a',
    s: '#f2c6a0',
    S: '#c98f6c',
    e: '#1b1b2a',
    p: '#e88f86',
    m: '#b2504a',
    d: '#2fb3a3',
    D: '#1f7f74',
    r: '#e0483e',
    k: '#2b2b3a',
    b: '#f4ecd8',
    B: '#c9b98f',
  },
  parts: {
    down: {
      head: { top: HEAD, rows: headFront },
      'head-blink': { top: HEAD, rows: variant(headFront, { 6: '..ohsSssssSsho..' }) },
      'head-work': { top: HEAD, rows: variant(headFront, { 6: '..ohssssssssho..', 7: '..ohpessssepho..' }) },
      'head-up': { top: HEAD, rows: variant(headFront, { 5: '..ohsessssesho..', 6: '..ohssssssssho..' }) },
      'head-up2': { top: HEAD, rows: variant(headFront, { 5: '..ohssesssseho..', 6: '..ohssssssssho..' }) },
      'head-sleep': { top: HEAD, rows: variant(headFront, { 6: '..ohsSSssSSsho..', 8: '..ohssssmsssho..' }) },
      body: { top: BODY, rows: bodyFront },
      'body-type': {
        top: BODY,
        rows: variant(bodyFront, { 4: '..osdDddddDsso..', 5: '..oDssddddddDo.r' }),
      },
      'body-type2': {
        top: BODY,
        rows: variant(bodyFront, { 4: '..ossDddddDdso..', 5: '..oDddddddssDo.r' }),
      },
      'body-read': {
        top: BODY,
        rows: variant(bodyFront, { 3: '.osDdbbbbbbdDso.', 4: '.osDsbbBBbbsDso.', 5: '.osDdbbbbbbdDsr.' }),
      },
      'body-read2': {
        top: BODY,
        rows: variant(bodyFront, { 3: '.osDdbbbbBbdDso.', 4: '.osDsbbBBbbsDso.', 5: '.osDdbbbbbbdDsr.' }),
      },
      // A hand to the chin.
      'body-think': {
        top: BODY,
        rows: variant(bodyFront, {
          0: '..ohhhossossho..',
          1: '..ohhoddddDsho..',
          2: '..oodddddddDso..',
          3: '.osDddddddddDo..',
          4: '.osDddDddDddDo..',
          5: '.osDddddddddDo.r',
        }),
      },
      // The right arm goes up in the overlay.
      'body-wait': {
        top: BODY,
        rows: variant(bodyFront, { 3: '.osDddddddddDo..', 4: '.osDddDddDddDo..', 5: '.osDddddddddDo.r' }),
      },
      'over-wait': {
        top: 10,
        rows: [
          '..............oo',
          '.............oso',
          '.............oso',
          '.............oso',
          '.............oso',
          '.............oso',
          '.............oso',
          '............oso.',
          '............oso.',
        ],
      },
      'over-wait2': {
        top: 9,
        rows: [
          '..............oo',
          '.............oso',
          '.............oso',
          '.............oso',
          '.............oso',
          '.............oso',
          '.............oso',
          '.............oso',
          '............oso.',
          '............oso.',
        ],
      },
      legs: { top: LEGS, rows: legsFront },
      'legs-step1': {
        top: LEGS,
        rows: ['....oso..oso...r', '....oso..oso..r.', '...okko..oso...r', '...oooo..oko..r.', '.........okko.r.', '.........oooo..r'],
      },
      'legs-step2': {
        top: LEGS,
        rows: ['....oso..oso...r', '....oso..oso..r.', '....oso..okko..r', '....oko..oooo.r.', '...okko........r', '...oooo.......r.'],
      },
    },
    up: {
      head: { top: HEAD, rows: headBack },
      body: { top: BODY, rows: bodyBack },
      'body-type': {
        top: BODY,
        rows: variant(bodyBack, { 3: '.osDdhhhhhhdDso.', 4: '..oDddhhhhddDo..', 5: '.r.DddddddddDo..' }),
      },
      'body-type2': {
        top: BODY,
        rows: variant(bodyBack, { 3: '.osDdhhhhhhdDo..', 4: '..oDddhhhhddDso.', 5: '.r.DddddddddDo..' }),
      },
      'body-read': {
        top: BODY,
        rows: variant(bodyBack, { 4: '..oDddhhhhddDo..', 5: '.r.DddddddddDo..' }),
      },
      legs: { top: LEGS, rows: legsBack },
      'legs-step1': {
        top: LEGS,
        rows: ['r...oso..oso....', '.r..oso..oso....', 'r..okko..oso....', '.r.oooo..oko....', 'r........okko...', '.r.......oooo...'],
      },
      'legs-step2': {
        top: LEGS,
        rows: ['r...oso..oso....', '.r..oso..oso....', 'r...oso..okko...', '.r..oko..oooo...', 'r..okko.........', '.r.oooo.........'],
      },
    },
    right: {
      head: { top: HEAD, rows: headSide },
      'head-blink': { top: HEAD, rows: variant(headSide, { 6: '..ohhhhssssSso..' }) },
      'head-work': { top: HEAD, rows: variant(headSide, { 6: '..ohhhhsssssso..', 7: '..ohhhhsssseso..' }) },
      body: { top: BODY, rows: bodySide },
      'body-type': { top: BODY, rows: variant(bodySide, { 3: '...ohoddddsso...', 4: '....oddddddo....', 5: '....oddddddo....' }) },
      'body-type2': { top: BODY, rows: variant(bodySide, { 3: '...ohoddddssso..', 4: '....oddddddo....', 5: '....oddddddo....' }) },
      'body-read': { top: BODY, rows: variant(bodySide, { 3: '...ohoddsbbbo...', 4: '....odddsbbo....', 5: '....oddddddo....' }) },
      'body-read2': { top: BODY, rows: variant(bodySide, { 3: '...ohoddsbBbo...', 4: '....odddsbbo....', 5: '....oddddddo....' }) },
      legs: { top: LEGS, rows: ['......osso......', '......osso......', '......osso......', '......okko......', '......okkko.....', 'rrr...ooooo.....'] },
      'legs-step1': {
        top: LEGS,
        rows: ['......osso......', '.....os..so.....', '....os....so....', '....ok....ko....', '...okk....kko...', 'rr.ooo....ooo...'],
      },
      'legs-step2': {
        top: LEGS,
        rows: ['......osso......', '......osso......', '.....os..so.....', '.....ok..ko.....', '....okk..kko....', '.rr.ooo..ooo....'],
      },
    },
  },
};
