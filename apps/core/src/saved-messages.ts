import { isAtMost, type LabelRules } from '@arianna/policy';

import { captureNote, type CaptureInput, type CaptureResult } from './capture.ts';
import { eachInboxNote, headerFields, MESSAGE_SOURCE, noteLabel } from './notes.ts';

/**
 * Messages of the chat saved in kb/inbox (D-089, request 7 of the user): the
 * note says where it came from with `source: message:<id>`, a line written
 * only by capture.ts, and a message is saved once. The check and the creation
 * run in one synchronous stretch, with no await between them: the core is one
 * process, so two saves of the same message arriving together are serialized
 * by the event loop and the second one finds the note of the first.
 */
export class AlreadySavedError extends Error {
  override name = 'AlreadySavedError';
  /** The file name of the note already saved; null when the note is above L2 (it is not named). */
  readonly note: string | null;

  constructor(note: string | null) {
    super('the message is already saved in the inbox');
    this.note = note;
  }
}

/** The message id of a note's `source:` line, or undefined. */
function messageIdOf(raw: string): string | undefined {
  return MESSAGE_SOURCE.exec(headerFields(raw).get('source') ?? '')?.[1];
}

/**
 * The note of kb/inbox saved from this message, if any. Notes above L2 by
 * their own label count too (the message is saved), but only a note up to L2
 * is named. Notes above L2 by their folder are never opened.
 */
export function findSavedNote(home: string, rules: LabelRules, messageId: string): { path: string; name: string; visible: boolean } | undefined {
  const needle = `message:${messageId}`;
  let found: { path: string; name: string; visible: boolean } | undefined;
  eachInboxNote(home, rules, (path, raw) => {
    if (!raw.includes(needle) || messageIdOf(raw) !== messageId) return true;
    found = { path, name: path.split('/').at(-1) ?? path, visible: isAtMost(noteLabel(rules, path, raw), 'L2') };
    return false;
  });
  return found;
}

/**
 * Every message with a note in kb/inbox: id → the note's file name, or null
 * when the note is above L2 by its own label (it is not named).
 */
export function savedMessageNotes(home: string, rules: LabelRules): Map<string, string | null> {
  const notes = new Map<string, string | null>();
  eachInboxNote(home, rules, (path, raw) => {
    if (raw.includes('message:')) {
      const id = messageIdOf(raw);
      if (id !== undefined && !notes.has(id)) notes.set(id, isAtMost(noteLabel(rules, path, raw), 'L2') ? (path.split('/').at(-1) ?? path) : null);
    }
    return true;
  });
  return notes;
}

/**
 * Saves a message as a new note, unless one with its source exists: then
 * AlreadySavedError and nothing is written. Synchronous on purpose (above).
 */
export function captureMessage(input: Omit<CaptureInput, 'source'> & { messageId: string }): CaptureResult {
  const { messageId, ...rest } = input;
  const existing = findSavedNote(input.home, input.rules, messageId);
  if (existing !== undefined) throw new AlreadySavedError(existing.visible ? existing.name : null);
  return captureNote({ ...rest, source: { messageId } });
}
