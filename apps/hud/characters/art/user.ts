import type { CharacterArt } from '../compose.ts';

/**
 * "Tu": the user's avatar in the office (D-106), original art of the project
 * (amber hoodie, jeans), from the preview docs/mockups/ufficio.html. Same
 * rows as the others: 7–16 head, 17–25 body, 26–31 legs. Poses it does not
 * draw (type, read, the fourth row) fall back to the plain parts. Not in the
 * pack of the originals yet: the office composes its sheet in the page.
 */
const LEGS_DOWN = ['....onno.onno...', '....onno.onno...', '....onNo.oNno...', '....onno.onno...', '...okkko.okkko..', '...ooooo.ooooo..'];
const STEP1_DOWN = ['....onno.onno...', '....onno.onno...', '...okkko.onno...', '...ooooo.onno...', '.........okkko..', '.........ooooo..'];
const STEP2_DOWN = ['....onno.onno...', '....onno.onno...', '....onno.okkko..', '....onno.ooooo..', '...okkko........', '...ooooo........'];

export const USER: CharacterArt = {
  id: 'user',
  palette: { o: '#1a1c2c', h: '#3a2a22', s: '#e8b48a', e: '#1b1b2a', m: '#b2504a', j: '#e0a040', J: '#b07a28', w: '#f4ecd8', n: '#3e5a8a', N: '#2c4268', k: '#2b2b3a' },
  parts: {
    down: {
      head: {
        top: 7,
        rows: ['......oooo......', '....oohhhhoo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhsssssshho..', '..ohsessssesho..', '..oossssssssoo..', '...osssmmssso...', '....oossssoo....'],
      },
      body: {
        top: 17,
        rows: ['...oojjwwjjoo...', '..ojjjjjjjjjjo..', '.ojjjjjjjjjjjjo.', '.ojJjjjjjjjjJjo.', '.ojJjjjjjjjjJjo.', '.osJjjjjjjjjJso.', '..oJJJJJJJJJJo..', '...onnnnnnnno...', '...onnnnnnnno...'],
      },
      legs: { top: 26, rows: LEGS_DOWN },
      'legs-step1': { top: 26, rows: STEP1_DOWN },
      'legs-step2': { top: 26, rows: STEP2_DOWN },
    },
    up: {
      head: {
        top: 7,
        rows: ['......oooo......', '....oohhhhoo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '...ohhhhhhhho...', '....oossssoo....'],
      },
      body: {
        top: 17,
        rows: ['...oojjjjjjoo...', '..ojjjjjjjjjjo..', '.ojjJJJJJJJJjjo.', '.ojjJjjjjjjJjjo.', '.ojjJJJJJJJJjjo.', '.osjjjjjjjjjjso.', '..oJJJJJJJJJJo..', '...onnnnnnnno...', '...onnnnnnnno...'],
      },
      legs: { top: 26, rows: LEGS_DOWN },
      'legs-step1': { top: 26, rows: STEP1_DOWN },
      'legs-step2': { top: 26, rows: STEP2_DOWN },
    },
    right: {
      head: {
        top: 7,
        rows: ['.....oooo.......', '....ohhhhoo.....', '...ohhhhhhho....', '..ohhhhhhhhho...', '..ohhhhhhsssso..', '..ohhhhhssssso..', '..ohhhhhssseso..', '..ohhhhsssssso..', '...ohhhssssmo...', '....oossssoo....'],
      },
      body: {
        top: 17,
        rows: ['.....ojjjjo.....', '....ojjjjjjo....', '....ojjjjjjo....', '....ojjJjjjo....', '....ojjJjjjo....', '....ojjsjjjo....', '....oJJJJJJo....', '....onnnnnno....', '....onnnnnno....'],
      },
      legs: { top: 26, rows: ['.....onnno......', '.....onnno......', '.....onnno......', '.....onnno......', '.....okkkko.....', '.....oooooo.....'] },
      'legs-step1': { top: 26, rows: ['.....onnno......', '....onnonno.....', '...onno.onno....', '...onno.onno....', '..okkko.okkko...', '..ooooo.ooooo...'] },
      'legs-step2': { top: 26, rows: ['.....onnno......', '.....onnno......', '....onnonno.....', '....onno.onno...', '...okkko.okkko..', '...ooooo.ooooo..'] },
    },
  },
};
