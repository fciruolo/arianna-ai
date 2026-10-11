/** A slide of the Studio's export (docs/STUDIO-API.md). */
export interface Slide {
  title?: string;
  subtitle?: string;
  paragraphs?: string[];
  bullets?: string[];
  notes?: string;
  /** `#rrggbb` */
  background?: string;
  /** `#rrggbb`, the text colour */
  color?: string;
  /** `#rrggbb`, the title colour */
  accent?: string;
}

export interface Deck {
  title: string;
  slides: Slide[];
}

export class DeckError extends Error {
  override name = 'DeckError';
}

/** Checks an untrusted value against the limits of docs/STUDIO-API.md. */
export function parseDeck(raw: unknown): Deck {
  throw new DeckError(`not implemented yet: ${typeof raw}`);
}
