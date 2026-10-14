import { terminalText, type ClaudeEvent } from '@arianna/executors';
import { isAtMost, type KnownSecrets, type Label } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import type { Sql } from './db/client.ts';
import { noticePieces } from './live-edit.ts';

/**
 * The terminal of a run (D-095, tappa 1): the commands the Coder runs with
 * Bash and what they print, already cut by @arianna/executors, shown in the
 * "Computer" panel of the chat, read only. Like the live changes of D-117 they
 * go to the web chat only, through `pg_notify`, and are never stored (the
 * user's choice of 2026-10-14): once the page is reloaded they are gone.
 *
 * Only for projects at most L1, with the label of the project (or of the
 * brief, when higher), and only when the task's clearance, which is within the
 * conversation's, reaches that label. A line holding a value revealed by the
 * vault is replaced; a value split over lines hides the whole text. The values
 * of a project's own `.env` are not known to the vault: those are shown.
 */
export type TerminalPart = 'command' | 'output';

/** One command or output, as the chat shows it. */
export interface TerminalEntry {
  /** Pairs a command with its output. */
  callId: string;
  part: TerminalPart;
  label: Label;
  text: string;
  /** Lines or bytes were cut by the executor. */
  truncated: boolean;
  /** Lines replaced because they held a value of the vault. */
  hidden: number;
  /** A value of the vault could not be cut out: nothing of the text is shown. */
  refused?: true;
  /** The binary marked the output as an error. */
  error?: true;
}

/** Longest call id taken from the binary. */
const MAX_CALL_ID = 128;

/**
 * The entry of a `command` or `command-output` event, or nothing when it must
 * not reach the chat: a label above L1 or above the clearance of the task.
 */
export function terminalEntryOf(
  event: Extract<ClaudeEvent, { type: 'command' | 'command-output' }>,
  options: { label: Label; clearance: Label },
  secrets: KnownSecrets = knownSecrets,
): TerminalEntry | undefined {
  if (!isAtMost(options.label, 'L1') || !isAtMost(options.label, options.clearance)) return undefined;
  if (event.callId === '' || event.callId.length > MAX_CALL_ID || /\p{Cc}/u.test(event.callId)) return undefined;
  const raw = event.type === 'command' ? event.command : event.output;
  // The vault first, on the whole text, then the cut (terminalText): a cut never leaves half a value.
  const shown = terminalText(raw, secrets);
  const base = { callId: event.callId, part: event.type === 'command' ? ('command' as const) : ('output' as const), label: options.label };
  const error = event.type === 'command-output' && event.error ? { error: true as const } : {};
  if (shown === undefined) return { ...base, text: '', truncated: event.truncated, hidden: 0, refused: true, ...error };
  return { ...base, text: shown.text, truncated: event.truncated || shown.truncated, hidden: shown.hidden, ...error };
}

/**
 * Where and what a run sends for a `command` or `command-output` event, or
 * nothing: a task outside a conversation, or an entry terminalEntryOf refuses.
 * `label` is the highest of the project's and the brief's (as for the live
 * changes of D-117); the clearance is the task's, within its conversation's.
 */
export function terminalFor(
  task: { id: string; conversationId: string | null; clearance: Label },
  step: number,
  label: Label,
  event: Extract<ClaudeEvent, { type: 'command' | 'command-output' }>,
  secrets: KnownSecrets = knownSecrets,
): { where: { conversationId: string; taskId: string; step: number }; entry: TerminalEntry } | undefined {
  if (task.conversationId === null) return undefined;
  const entry = terminalEntryOf(event, { label, clearance: task.clearance }, secrets);
  return entry === undefined ? undefined : { where: { conversationId: task.conversationId, taskId: task.id, step }, entry };
}

/** Channel of the terminal: one per schema, like the fragments. */
export function terminalChannel(schema: string): string {
  return `arianna_terminal:${schema}`;
}

/** One piece of a terminal entry: the text is cut in pieces under the pg_notify limit, put back together by the page. */
export interface TerminalNotice {
  callId: string;
  conversationId: string;
  taskId: string;
  step: number;
  part: TerminalPart;
  label: Label;
  truncated: boolean;
  hidden: number;
  refused?: true;
  error?: true;
  /** Position of the piece, from 0, of `total`. */
  seq: number;
  total: number;
  text: string;
}

/** Most pieces of one entry: 16 KiB of text never needs more, even all escaped. */
export const MAX_TERMINAL_PIECES = 64;

/** The JSON notices of an entry, each under the pg_notify limit; nothing when it would take too many. */
export function terminalNotices(where: { conversationId: string; taskId: string; step: number }, entry: TerminalEntry): string[] {
  const { text, ...rest } = entry;
  const base: Omit<TerminalNotice, 'seq' | 'total' | 'text'> = { ...rest, ...where };
  const pieces = noticePieces(base, text);
  if (pieces.length > MAX_TERMINAL_PIECES) return [];
  return pieces.map((piece, seq) => JSON.stringify({ ...base, seq, total: pieces.length, text: piece }));
}

/** Sends a terminal entry to the web chat; nothing is stored. */
export async function postTerminal(sql: Sql, where: { conversationId: string; taskId: string; step: number }, entry: TerminalEntry): Promise<void> {
  for (const notice of terminalNotices(where, entry)) {
    // Same channel the live feed listens on: terminalChannel(current_schema()).
    await sql`SELECT pg_notify(${terminalChannel('')} || current_schema(), ${notice})`;
  }
}

const LABELS: readonly Label[] = ['L0', 'L1'];
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A notice of the terminal channel, or nothing for anything malformed. */
export function parseTerminal(payload: string): TerminalNotice | undefined {
  try {
    const value = JSON.parse(payload) as Partial<TerminalNotice> | null;
    if (
      value !== null &&
      typeof value.callId === 'string' &&
      typeof value.conversationId === 'string' &&
      typeof value.taskId === 'string' &&
      count(value.step) &&
      (value.part === 'command' || value.part === 'output') &&
      LABELS.some((label) => label === value.label) &&
      typeof value.truncated === 'boolean' &&
      count(value.hidden) &&
      [undefined, true].includes(value.refused) &&
      [undefined, true].includes(value.error) &&
      count(value.seq) &&
      count(value.total) &&
      value.seq < value.total &&
      typeof value.text === 'string'
    ) {
      const { callId, conversationId, taskId, step, part, label, truncated, hidden, refused, error, seq, total, text } = value;
      return {
        callId,
        conversationId,
        taskId,
        step,
        part,
        label: label as Label,
        truncated,
        hidden,
        ...(refused === true ? { refused } : {}),
        ...(error === true ? { error } : {}),
        seq,
        total,
        text,
      };
    }
  } catch {
    // Not ours: ignored.
  }
  return undefined;
}

/** What the log says when a terminal entry cannot be sent: the class and code of the error, never its message. */
export function terminalFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return `terminal not sent: ${name}${code === '' ? '' : ` (${code})`}`;
}
