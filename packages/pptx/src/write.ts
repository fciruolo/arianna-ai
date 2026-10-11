import type { Deck } from './deck.ts';

/** The bytes of a .pptx file for a checked deck. */
export function writePptx(deck: Deck): Buffer {
  throw new Error(`not implemented yet: ${deck.title}`);
}
