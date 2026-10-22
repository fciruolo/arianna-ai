/**
 * Texts that speak of the mouse or of the keys, and what they say to a finger
 * (D-294, the small open points of D-293). A finger has no right click, no
 * hover and no ⌘: the phone says «tocca» and names the button that is there.
 * The texts written in a template switch with the `touch:` variant of
 * style.css; those built in code ask `coarsePointer`. Same criterion for
 * both: the pointer is coarse, whatever the width of the screen (an iPad
 * has fingers too).
 */

/** The query of a finger: the same as the `touch:` variant of style.css. */
export const COARSE_QUERY = '(pointer: coarse)';

/** Whether the pointer is a finger now (false outside a browser). */
export function coarsePointer(matches?: (query: string) => boolean): boolean {
  if (matches !== undefined) return matches(COARSE_QUERY);
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
}

/** Where the Wiki is empty: the whole Wiki, or the folder that is open. */
export type WikiEmpty = 'wiki' | 'folder';

/**
 * The line of an empty Wiki or folder. With the mouse the actions are a
 * right click away; with a finger they are behind the «⋯» of a row (iOS
 * gives no right click to a long press).
 */
export function wikiEmptyText(where: WikiEmpty, touch: boolean): string {
  if (where === 'wiki') {
    return touch
      ? 'La Wiki è ancora vuota: le pagine arrivano dalle proposte del modello locale, o le scrivi tu col «+» in cima all’albero.'
      : 'La Wiki è ancora vuota: le pagine arrivano dalle proposte del modello locale, o le scrivi tu con «Nuova cartella» e «Nuova pagina» (clic destro nell’albero).';
  }
  return touch
    ? 'Cartella ancora vuota: crea qui una pagina col «+» o il «⋯» della cartella nell’albero.'
    : 'Cartella ancora vuota: crea qui una pagina (clic destro sulla cartella) o trascinane una dall’albero.';
}
