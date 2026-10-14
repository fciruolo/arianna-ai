import type { Rows } from './person.ts';

/**
 * Shared shapes of the heads of the series (D-211): the lower face of a man,
 * front and side, and the back of a head from its front. Each person writes
 * only the hair on top.
 */

/** Front, rows 5–9 of a man: forehead, eyes on row 6, cheeks, mouth, chin. */
export function manFace(mouth = '...osssmmssso...', eyes = '..ohsessssesho..', forehead = '..ohssssssssho..'): string[] {
  return [forehead, eyes, '..oossssssssoo..', mouth, '....oossssoo....'];
}

/** The hair of a man seen from the side, rows 0–3, facing right. */
export const SIDE_HAIR: readonly [string, string, string, string] = ['.....oooo.......', '...oohhhhoo.....', '..ohhhhhhhhoo...', '..ohhhhhhhhhho..'];

/** Side, a man with short hair facing right: rows 0–3 of hair, then the face with the eye on column 11. */
export function manSide(hair: Rows = SIDE_HAIR, mouth = '....osssssmso...'): string[] {
  return [...hair, '..ohhhhhhsssso..', '..ohhhhhssssso..', '..ohhhSsssseso..', '...ohsssssssso..', mouth, '.....ossssoo....'];
}

/** The back of a head from its front: hair everywhere above the nape, the neck below. */
export function backOf(front: Rows, nape = '...ohhhhhhhho...', neck = '....oossssoo....'): string[] {
  const rows = front.slice(0, 8).map((line) => line.replace(/[^o.H]/g, 'h'));
  return [...rows, nape, neck];
}
