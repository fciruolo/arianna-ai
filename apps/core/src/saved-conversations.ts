import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { isAtMost, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { captureNote, CaptureError, inboxDir, MAX_CAPTURE_BYTES, sameInbox, type CaptureResult } from './capture.ts';
import { CONVERSATION_SOURCE, eachInboxNote, headerFields, noteLabel } from './notes.ts';

/**
 * A whole conversation saved in kb/inbox (I-7, D-131): the messages of the
 * user, of Arianna and the reports of the agents, never the lines of the
 * system, as one note with `source: conversation:<id>`. The organizer of the
 * inbox (D-086) writes its title and summary with the local model, as for any
 * capture. A second save of the same conversation replaces that note: the
 * old file goes once the new one is written. Synchronous, like the save of a
 * message (saved-messages.ts): two saves arriving together are serialized.
 */
export interface SavedLine {
  role: 'user' | 'assistant' | 'system';
  agent: string | null;
  label: Label;
  body: string;
}

/** Who wrote a line, as the note says it. */
function speaker(line: SavedLine): string {
  if (line.role === 'user') return 'Tu';
  if (line.agent === null) return 'Arianna';
  return line.agent === 'coder' ? 'Coder' : line.agent;
}

const CUT = '(Inizio tagliato: la conversazione era più lunga di quanto una nota può tenere.)';

/**
 * The text of the note: one paragraph per message, oldest first, with who
 * wrote it. Above MAX_CAPTURE_BYTES the oldest messages go, and the note says so.
 */
export function conversationText(lines: readonly SavedLine[]): string {
  const parts = lines.filter((line) => line.role !== 'system').map((line) => `**${speaker(line)}:** ${line.body.trim()}`);
  const whole = parts.join('\n\n');
  if (Buffer.byteLength(whole, 'utf8') <= MAX_CAPTURE_BYTES) return whole;
  // Something goes: the warning always comes first, and what is kept fits after it.
  const room = MAX_CAPTURE_BYTES - Buffer.byteLength(`${CUT}\n\n`, 'utf8');
  for (let first = 1; first < parts.length; first += 1) {
    const text = parts.slice(first).join('\n\n');
    if (Buffer.byteLength(text, 'utf8') <= room) return `${CUT}\n\n${text}`;
  }
  // The last message alone is above the limit: its end is kept, without a character cut in half.
  const last = parts.at(-1) ?? '';
  const tail = Buffer.from(last, 'utf8').subarray(-room).toString('utf8').replace(/^�+/, '');
  return `${CUT}\n\n${tail}`;
}

/** The note of kb/inbox saved from this conversation, if any; only a note up to L2 is named. */
export function findConversationNote(home: string, rules: LabelRules, conversationId: string): { path: string; visible: boolean } | undefined {
  const needle = `conversation:${conversationId}`;
  let found: { path: string; visible: boolean } | undefined;
  eachInboxNote(home, rules, (path, raw) => {
    if (!raw.includes(needle) || CONVERSATION_SOURCE.exec(headerFields(raw).get('source') ?? '')?.[1] !== conversationId) return true;
    found = { path, visible: isAtMost(noteLabel(rules, path, raw), 'L2') };
    return false;
  });
  return found;
}

export interface SaveConversationInput {
  home: string;
  rules: LabelRules;
  conversationId: string;
  /** The conversation's title, when it has one: the note's until the organizer writes its own. */
  title: string | null;
  lines: readonly SavedLine[];
  /** The label the conversation has reached (its effective label): the note is never below it. */
  floor?: Label;
  now?: Date;
}

/** The note written and whether it replaced an earlier save of the same conversation. */
export type SavedConversation = CaptureResult & { replaced: boolean };

export function saveConversation(input: SaveConversationInput): SavedConversation {
  const kept = input.lines.filter((line) => line.role !== 'system');
  if (kept.length === 0) throw new CaptureError('invalid', 'the conversation has no message to save');
  // The highest label of the messages saved: above L2 nothing is written (capture.ts says it).
  const label = kept.reduce<Label>((top, line) => maxLabel(top, line.label), input.floor ?? 'L0');
  const existing = findConversationNote(input.home, input.rules, input.conversationId);
  if (existing !== undefined && !existing.visible) throw new CaptureError('not-allowed', 'the note of this conversation is above L2');
  // Whole characters up to the 200 UTF-16 units capture.ts allows: an emoji is never cut in half.
  let title = '';
  for (const character of (input.title ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim()) {
    if (title.length + character.length > 200) break;
    title += character;
  }
  const note = captureNote({
    home: input.home,
    rules: input.rules,
    text: conversationText(kept),
    kind: 'note',
    source: { conversationId: input.conversationId },
    from: label,
    ...(title === '' ? {} : { title }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (existing === undefined) return { ...note, replaced: false };
  // The earlier note goes: a regular file in the inbox only, never a link.
  const dir = inboxDir(input.home);
  const old = join(dir, existing.path.split('/').at(-1) ?? '');
  try {
    if (sameInbox(input.home, dir) && lstatSync(old).isFile()) unlinkSync(old);
  } catch {
    // Already gone, or moved meanwhile: the new note stands.
  }
  return { ...note, replaced: true };
}
