/**
 * "Copia" on a code block (D-084): the exact text of the block to the
 * clipboard. `navigator.clipboard` exists only in a secure context (HTTPS or
 * loopback); on the phone over plain HTTP it is missing, and the button says so.
 */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export type CopyResult = 'copied' | 'unavailable';

/** How long "Copiato" (or "Copia non disponibile") stays on the button. */
export const COPY_FEEDBACK_MS = 2000;

export async function copyText(text: string, clipboard: ClipboardLike | undefined): Promise<CopyResult> {
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return 'unavailable';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    // Refused by the browser (permission, page not focused): nothing was copied.
    return 'unavailable';
  }
}
