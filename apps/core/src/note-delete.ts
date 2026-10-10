import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { LabelRules } from '@arianna/policy';

import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { listPageIds, readKnowledgePage, resolveWikilink } from './knowledge.ts';
import { eachInboxNote, NoteError, replaceNote, sha256 } from './notes.ts';
import { KB_DIR, KB_INBOX } from './orchestrator/kb.ts';
import { ORGANIZE_QUEUE } from './organize.ts';
import { unlinkPlainFile } from './plain-file.ts';

/**
 * "Elimina" of a note (D-157, the user's choice of 2026-10-10): the file goes
 * from the disk for good, only on a click of the user in the web chat; no
 * tool of Arianna deletes a note. Here the notes of kb/ (the inbox of the
 * Pensieri and the other pages of the Conoscenza); the notes of a project are
 * deleted by deleteProjectNote (project-knowledge.ts) with the same unlink.
 * Nothing outside kb/ or the management folders of a project is ever reached:
 * not the documents of development, not a file behind a link.
 */

/** Where a deleted note was, the only thing its event says (no path, no title: the name of a note comes from its text). */
export type DeletedWhere = 'inbox' | 'kb' | 'project';

/** What a link to a deleted note becomes in the notes that named it. */
export const DELETED_LINK = 'nota eliminata';

/** kb/ of this home as a real folder (never a link), as its real path. */
function kbBase(home: string): string {
  try {
    const base = join(realpathSync(home), KB_DIR);
    if (realpathSync(base) !== base || !lstatSync(base).isDirectory()) throw new Error('kb/ is a link');
    return base;
  } catch {
    throw new NoteError('not-found', 'note not found');
  }
}

/**
 * Deletes a page of kb/ (`id` relative to kb/, as the Conoscenza names it).
 * Only a page the chat can read (up to L2, as readKnowledgePage reads it): any
 * other answers the same 404 and stays. The links to it in the notes of the
 * inbox (the organizer writes them, D-086) become plain words.
 */
export function deleteKbPage(home: string, rules: LabelRules, id: string): { where: DeletedWhere; path: string } {
  // The same checks as the reading: a valid page path, a real folder all the way, a label up to L2.
  readKnowledgePage(home, rules, id);
  const base = kbBase(home);
  const ids = listPageIds(base);
  if (!unlinkPlainFile(base, id.split('/'))) throw new NoteError('not-found', 'note not found');
  const path = `${KB_DIR}/${id}`;
  unlinkFromInbox(home, rules, id, ids);
  return { where: path.startsWith(`${KB_INBOX}/`) ? 'inbox' : 'kb', path };
}

/**
 * The links to the deleted page in the notes of kb/inbox, as the graph
 * resolves them among the pages there were (`ids`), become DELETED_LINK. A
 * note changed meanwhile, or above L2, is left as it is.
 */
function unlinkFromInbox(home: string, rules: LabelRules, deleted: string, ids: readonly string[]): void {
  eachInboxNote(home, rules, (path, raw) => {
    const changed = raw.replace(/!?\[\[([^[\]\n]{1,300})\]\]/g, (match, inner: string) => {
      const target = inner.split('|')[0]?.split('#')[0]?.trim() ?? '';
      return target !== '' && resolveWikilink(target, ids) === deleted ? DELETED_LINK : match;
    });
    if (changed !== raw) {
      try {
        replaceNote(home, path, changed, sha256(raw));
      } catch (error) {
        if (!(error instanceof NoteError)) throw error;
      }
    }
    return true;
  });
}

/**
 * After a note is deleted: its organizing job, queued or not, forgets the
 * path (the core has no DELETE, D-046: the row stays without it) and stops,
 * and one event says a note was deleted and where, without its path.
 */
export async function recordNoteDeleted(sql: Sql, where: DeletedWhere, path: string): Promise<void> {
  await sql.begin(async (tx) => {
    if (where === 'inbox') await forgetOrganize(tx, path);
    await appendEvent(tx, { kind: 'note.deleted', label: 'L0', payload: { where } });
  });
}

async function forgetOrganize(tx: Queryable, path: string): Promise<void> {
  await tx`
    UPDATE jobs SET
      payload = '{}'::jsonb, key = NULL, locked_at = NULL, locked_by = NULL,
      status = CASE WHEN status IN ('queued', 'running') THEN 'failed' ELSE status END,
      last_error = CASE WHEN status IN ('queued', 'running') THEN 'deleted' ELSE last_error END
    WHERE queue = ${ORGANIZE_QUEUE} AND (payload ->> 'path' = ${path} OR key = ${`note-organize:${path}`})`;
}
