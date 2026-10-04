/**
 * "/nota" in the composer (D-080): the text does not go to Arianna but to
 * POST /api/capture, which writes a new L2 note in kb/inbox without a model.
 */
export interface NoteCommand {
  text: string;
  kind: 'note' | 'link';
  /** Only when the whole text is one http(s) address. */
  url?: string;
}

const COMMAND = /^\/nota(?:\s+|$)/i;
/** "/" and a word, then a space or the end: a command, known or not ("/etc/hosts" is not one). */
const ANY_COMMAND = /^\/(\p{L}+)(?:\s|$)/u;

/** The note a draft asks for, or undefined for an ordinary message. */
export function parseNoteCommand(draft: string): NoteCommand | undefined {
  const start = draft.trimStart();
  const match = COMMAND.exec(start);
  if (match === null) return undefined;
  const text = start.slice(match[0].length).trim();
  if (/^\S+$/.test(text)) {
    try {
      const url = new URL(text);
      if (url.protocol === 'http:' || url.protocol === 'https:') return { text, kind: 'link', url: text };
    } catch {
      // Not an address: an ordinary note.
    }
  }
  return { text, kind: 'note' };
}

/**
 * Why a draft is not sent, in Italian: a command this page does not know
 * ("/note" for "/nota") must not reach Arianna as a message.
 */
export function commandError(draft: string): string | undefined {
  const start = draft.trimStart();
  if (COMMAND.test(start)) return undefined;
  const name = ANY_COMMAND.exec(start)?.[1];
  return name === undefined ? undefined : `Comando sconosciuto: /${name}. Per salvare una nota scrivi /nota seguito dal testo.`;
}

/** What the chat says once the note is saved: path and label, never the text. */
export function savedText(note: { path: string; label: string }): string {
  return `Nota salvata in ${note.path} (${note.label})`;
}
