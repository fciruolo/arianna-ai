import { resolveDraft, stripLeading } from './commands.ts';
import { MESSAGE_ABOVE_L2_TEXT, MESSAGE_EMPTY_TEXT, MESSAGE_TOO_LARGE_TEXT } from './italian.ts';
import type { Label } from './types.ts';

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

/** "/nota" or its shortcut "/n" (D-090). */
const COMMAND = /^\/(?:nota|n)(?:\s+|$)/i;

/** The note a draft asks for, or undefined for an ordinary message. */
export function parseNoteCommand(draft: string): NoteCommand | undefined {
  const start = stripLeading(draft);
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
 * ("/note" for "/nota") must not reach Arianna as a message. The known
 * commands are those of lib/commands.ts (D-090).
 */
export function commandError(draft: string): string | undefined {
  const meaning = resolveDraft(draft);
  return meaning.kind === 'error' ? meaning.text : undefined;
}

/** What the chat says once the note is saved: path and label, never the text. */
export function savedText(note: { path: string; label: string }): string {
  return `Nota salvata in ${note.path} (${note.label})`;
}

/** The core's limit on a captured text (MAX_CAPTURE_BYTES in apps/core/src/capture.ts). */
export const MAX_NOTE_BYTES = 64 * 1024;
export const MAX_NOTE_TITLE = 80;

/** Control, format and line-separator characters: never in a title, which goes to the note's header. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A title from the start of a message (D-084): its first line with text, on
 * one line, without control characters, at most 80 characters (an ellipsis
 * when cut). Undefined when nothing is left: the core then names the note
 * from the text.
 */
export function noteTitle(text: string): string | undefined {
  const line = text
    .split(/\r\n|[\n\r\u2028\u2029]/u)
    .map((part) => part.replace(UNSAFE, ' ').replace(/\s+/gu, ' ').trim())
    .find((part) => part !== '');
  if (line === undefined) return undefined;
  const chars = Array.from(line);
  return chars.length <= MAX_NOTE_TITLE ? line : `${chars.slice(0, MAX_NOTE_TITLE - 1).join('').trimEnd()}…`;
}

export interface MessageNote {
  text: string;
  kind: 'note';
  title?: string;
  /** The message's label: the core can only raise the note with it, and refuses above L2. */
  from: Label;
}

/** Only a message up to L2 can become a note: kb/inbox stops at L2 (D-080). */
export function canSaveToInbox(label: Label): boolean {
  return label !== 'L3';
}

/**
 * "Salva in inbox" under a message (D-084): the note to send to POST
 * /api/capture, or why it is not sent (in Italian). The text stays as it is;
 * the core writes it as an L2 note, or refuses it when the label is higher.
 */
export function messageNote(text: string, label: Label): { note: MessageNote } | { error: string } {
  if (!canSaveToInbox(label)) return { error: MESSAGE_ABOVE_L2_TEXT };
  if (new TextEncoder().encode(text).length > MAX_NOTE_BYTES) return { error: MESSAGE_TOO_LARGE_TEXT };
  if (text.trim() === '') return { error: MESSAGE_EMPTY_TEXT };
  const title = noteTitle(text);
  return { note: { text, kind: 'note', ...(title === undefined ? {} : { title }), from: label } };
}
