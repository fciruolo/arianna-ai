import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ClaudeEvent, FileEditTool } from '@arianna/executors';
import { isAtMost, type Label } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import type { Sql } from './db/client.ts';
import { diffLines } from './line-diff.ts';
import { chunk, MAX_NOTICE_BYTES } from './reply.ts';

/**
 * Live changes of the Coder (D-117, second stage): every call to Edit,
 * MultiEdit or Write of a run is shown in the activity card of the chat as a
 * small diff, while the run works. Like reply fragments (D-039) they go to the
 * web chat only, through `pg_notify`, and are never stored (D-095 is still a
 * proposal: no choice of the user to save them exists yet); the diff of the
 * files at the end of the run is the stored truth (stage one).
 *
 * Only for projects at most L1, with the label of the project; a path outside
 * the project or under `.git` is not shown at all, nor one holding a value of
 * the vault; a change holding one, or larger than MAX_EDIT_BYTES, is shown by
 * its path only, with the reason.
 */

/** Text of one change (old and new strings of all its parts) beyond which only "too large" is shown. */
export const MAX_EDIT_BYTES = 64 * 1024;
/** Longest path shown, in characters. */
const MAX_PATH = 1024;

export type LiveEditError = 'too-large' | 'refused';

/** One change, as the chat shows it. */
export interface LiveEdit {
  /** Relative to the project, with `/`. */
  path: string;
  tool: FileEditTool;
  label: Label;
  added: number;
  removed: number;
  /**
   * The diff lines, one per line of text: the first character is ` ` for
   * context, `+` added, `-` removed, `@` a gap between two hunks or parts
   * (nothing follows it). Empty with `error`.
   */
  lines: string;
  error?: LiveEditError;
}

/**
 * The path of a file as the chat may show it: relative to the project root,
 * never the root itself, never outside it, never under a `.git` folder (any
 * case). Lexical only: nothing is read from the disk here, the text shown is
 * the one the run sent.
 */
export function projectPath(root: string, filePath: string): string | undefined {
  if (filePath === '' || filePath.length > MAX_PATH || /\p{Cc}/u.test(filePath)) return undefined;
  const inside = relative(root, resolve(root, filePath));
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  const parts = inside.split(sep);
  if (parts.some((part) => part.toLowerCase() === '.git')) return undefined;
  return parts.join('/');
}

/**
 * The change of an `edit` event as the chat shows it, or nothing when it must
 * not be shown at all. `label` is the highest of the project's and the run's.
 */
export function liveEditOf(event: Extract<ClaudeEvent, { type: 'edit' }>, options: { root: string; label: Label }): LiveEdit | undefined {
  if (!isAtMost(options.label, 'L1')) return undefined;
  const path = projectPath(options.root, event.filePath);
  if (path === undefined || knownSecrets.find(path).length > 0) return undefined;
  const base = { path, tool: event.tool, label: options.label, added: 0, removed: 0, lines: '' };
  let bytes = 0;
  for (const part of event.parts) bytes += Buffer.byteLength(part.before) + Buffer.byteLength(part.after);
  if (bytes > MAX_EDIT_BYTES) return { ...base, error: 'too-large' };
  if (event.parts.some((part) => knownSecrets.find(part.before).length > 0 || knownSecrets.find(part.after).length > 0)) return { ...base, error: 'refused' };
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const part of event.parts) {
    const diff = diffLines(part.before, part.after);
    added += diff.added;
    removed += diff.removed;
    for (const hunk of diff.hunks) {
      if (lines.length > 0) lines.push('@');
      for (const line of hunk.lines) lines.push(`${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`);
    }
  }
  return { ...base, added, removed, lines: lines.join('\n') };
}

/** Channel of the live changes: one per schema, like the fragments. */
export function editChannel(schema: string): string {
  return `arianna_edits:${schema}`;
}

/** One piece of a live change: the lines are cut in pieces under the pg_notify limit, put back together by the page. */
export interface EditNotice {
  /** Correlates the pieces of one change. */
  editId: string;
  conversationId: string;
  taskId: string;
  step: number;
  path: string;
  tool: FileEditTool;
  label: Label;
  added: number;
  removed: number;
  error?: LiveEditError;
  /** Position of the piece, from 0, of `total`. */
  seq: number;
  total: number;
  text: string;
}

const COUNT_PLACEHOLDER = 99_999;
/** Most pieces of one change: the chat drops a change with more (MAX_PIECES of apps/hud/src/lib/chat-state.ts). */
export const MAX_EDIT_PIECES = 256;

/**
 * The JSON notices of a change, each under the pg_notify limit. A change that
 * would take more than MAX_EDIT_PIECES is sent as `too-large`, by its path only.
 */
export function editNotices(base: Omit<EditNotice, 'seq' | 'total' | 'text'>, text: string): string[] {
  const pieces = editPieces(base, text);
  if (pieces.length > MAX_EDIT_PIECES) return [JSON.stringify({ ...base, error: 'too-large', seq: 0, total: 1, text: '' })];
  return pieces.map((piece, seq) => JSON.stringify({ ...base, seq, total: pieces.length, text: piece }));
}

function editPieces(base: Omit<EditNotice, 'seq' | 'total' | 'text'>, text: string): string[] {
  const pieces: string[] = [];
  const fits = (piece: string): boolean => Buffer.byteLength(JSON.stringify({ ...base, seq: COUNT_PLACEHOLDER, total: COUNT_PLACEHOLDER, text: piece })) <= MAX_NOTICE_BYTES;
  const add = (points: string[]): void => {
    const piece = points.join('');
    if (points.length <= 1 || fits(piece)) {
      pieces.push(piece);
      return;
    }
    const half = Math.ceil(points.length / 2);
    add(points.slice(0, half));
    add(points.slice(half));
  };
  for (const piece of chunk(text)) add(Array.from(piece));
  if (pieces.length === 0) pieces.push('');
  return pieces;
}

/** What the log says when a live change cannot be sent: the class and code of the error, never its message (it may quote the text). */
export function liveEditFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return `live edit not sent: ${name}${code === '' ? '' : ` (${code})`}`;
}

/** Sends a live change to the web chat; nothing is stored. */
export async function postLiveEdit(sql: Sql, where: { conversationId: string; taskId: string; step: number }, edit: LiveEdit): Promise<void> {
  const base: Omit<EditNotice, 'seq' | 'total' | 'text'> = {
    editId: randomUUID(),
    ...where,
    path: edit.path,
    tool: edit.tool,
    label: edit.label,
    added: edit.added,
    removed: edit.removed,
    ...(edit.error === undefined ? {} : { error: edit.error }),
  };
  for (const notice of editNotices(base, edit.lines)) {
    // Same channel the live feed listens on: editChannel(current_schema()).
    await sql`SELECT pg_notify(${editChannel('')} || current_schema(), ${notice})`;
  }
}
