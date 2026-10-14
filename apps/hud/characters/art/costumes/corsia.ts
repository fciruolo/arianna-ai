import type { Costume } from '../../compose.ts';

/**
 * Corsia (D-103, the hospital of the series): Arianna in blue scrubs with the
 * theatre cap and a stethoscope round her neck; the Coder in a white coat,
 * a cap under the antenna and a green cross on the chest (green, never red on
 * white: that one is a protected emblem). Variants of the original maps.
 */
const EMPTY = { top: 0, rows: [] };

export const ARIANNA_CORSIA: Costume = {
  theme: 'corsia',
  recolor: { d: '#5f9fd8', D: '#3d6fa6' },
  palette: { c: '#6aa8de', C: '#3d6fa6', g: '#5d6670', G: '#c8d0d8' },
  layers: {
    down: [
      {
        name: 'cap',
        after: 'head',
        part: {
          top: 6,
          rows: ['.....oooooo.....', '....occcccco....', '...occcCcccco...', '..occcccccccco..', '..oCCCCCCCCCCo..'],
        },
      },
      {
        name: 'stethoscope',
        after: 'body',
        skip: ['body-read'],
        part: { top: 18, rows: ['......g..g......', '......g..g......', '.......gG.......'] },
      },
    ],
    up: [
      {
        name: 'cap',
        after: 'head',
        part: {
          top: 6,
          rows: ['.....oooooo.....', '....occcccco....', '...occcCcccco...', '..occcccccccco..', '..oCCCCCCCCCCo..', '.......CC.......'],
        },
      },
      // Round the neck, hidden by the hair from behind.
      { name: 'stethoscope', after: 'body', part: EMPTY },
    ],
    right: [
      {
        name: 'cap',
        after: 'head',
        part: { top: 6, rows: ['....oooooo......', '...occcccco.....', '..occccCccco....', '..occcccccccco..', '..oCCCCCCCCCo...'] },
      },
      {
        name: 'stethoscope',
        after: 'body',
        skip: ['body-read'],
        part: { top: 18, rows: ['.........g......', '.........g......', '.........G......'] },
      },
    ],
  },
};

export const CODER_CORSIA: Costume = {
  theme: 'corsia',
  recolor: { b: '#e6ecef', B: '#b3c0c7' },
  palette: { q: '#6aa8de', Q: '#3d6fa6', x: '#2f9e5b' },
  layers: {
    down: [
      { name: 'cap', after: 'head', part: { top: 8, rows: ['....oqq..qqo....', '...oqqqQQqqqo...', '...oQQQQQQQQo...'] } },
      { name: 'cross', after: 'body', skip: ['body-read'], part: { top: 19, rows: ['..........x.....', '.........xxx....', '..........x.....'] } },
    ],
    up: [
      { name: 'cap', after: 'head', part: { top: 8, rows: ['....oqq..qqo....', '...oqqqQQqqqo...', '...oQQQQQQQQo...'] } },
      { name: 'cross', after: 'body', skip: ['body-read'], part: { top: 20, rows: ['.......x........', '......xxx.......', '.......x........'] } },
    ],
    right: [
      { name: 'cap', after: 'head', part: { top: 8, rows: ['....oqq..qqo....', '...oqqqQQqqqo...', '...oQQQQQQQQo...'] } },
      // On the sleeve, where the side shows it.
      { name: 'cross', after: 'body', skip: ['body-read', 'body-type'], part: { top: 20, rows: ['.......x........', '......xxx.......', '.......x........'] } },
    ],
  },
};
