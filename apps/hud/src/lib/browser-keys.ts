/**
 * The keys of the «Tastiera» button on a phone (D-264, passo 5): the screen
 * of noVNC takes no text from the keyboard of a phone (no field has the
 * focus), so a hidden field receives it and every character goes to the
 * browser as an X keysym. Pure: tested without a browser.
 *
 * Keysyms (X11): Latin-1 characters are their own code; any other character
 * is 0x01000000 plus its code point; the keys that write nothing have their
 * own codes (Backspace, Enter, the arrows…). The core drops F1-F35, Super,
 * Meta and Hyper anyway (rfb-filter.ts), so none of them is here.
 */

/** Keys of the hidden field that write nothing, by `KeyboardEvent.key`, with their keysym and `code`. */
export const SPECIAL_KEYS: Readonly<Record<string, { keysym: number; code: string }>> = {
  Backspace: { keysym: 0xff08, code: 'Backspace' },
  Tab: { keysym: 0xff09, code: 'Tab' },
  Enter: { keysym: 0xff0d, code: 'Enter' },
  Escape: { keysym: 0xff1b, code: 'Escape' },
  Delete: { keysym: 0xffff, code: 'Delete' },
  Home: { keysym: 0xff50, code: 'Home' },
  ArrowLeft: { keysym: 0xff51, code: 'ArrowLeft' },
  ArrowUp: { keysym: 0xff52, code: 'ArrowUp' },
  ArrowRight: { keysym: 0xff53, code: 'ArrowRight' },
  ArrowDown: { keysym: 0xff54, code: 'ArrowDown' },
  End: { keysym: 0xff57, code: 'End' },
};

/** The keysym of one character; undefined for a control character (a newline goes as Enter). */
export function keysymOf(character: string): number | undefined {
  const code = character.codePointAt(0);
  if (code === undefined || Array.from(character).length !== 1) return undefined;
  if (code === 0x0a || code === 0x0d) return SPECIAL_KEYS.Enter?.keysym;
  if (code === 0x09) return SPECIAL_KEYS.Tab?.keysym;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return undefined;
  if (code <= 0xff) return code;
  return 0x01000000 + code;
}

/** The keysyms of a text the phone inserted, character by character; control characters are left out. */
export function keysymsOf(text: string): number[] {
  const keysyms: number[] = [];
  for (const character of Array.from(text)) {
    const keysym = keysymOf(character);
    if (keysym !== undefined) keysyms.push(keysym);
  }
  return keysyms;
}
