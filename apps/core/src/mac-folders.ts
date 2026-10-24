import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { displayPath, MacPathError, pathRefusal, placeName, REFUSAL_ITALIAN, resolveMacPath, type MacEnv } from './mac-files.ts';

/**
 * The folders of the Mac Arianna may read (D-314, I-22, tappa M1): the
 * permanent list (`mac_folders`), written only by the user, in Impostazioni →
 * Cartelle del Mac or with «Sempre» on a card; and the grants of one
 * conversation, «Per tutta questa conversazione», read from its approvals of
 * kind `mac`. No agent writes either. A path is absolute, as written: the
 * core resolves it again with realpath at every call (mac-files.ts).
 */
export interface MacFolder {
  id: string;
  /** Absolute, as written. */
  path: string;
  addedAt: Date;
  /** «Sempre» on a card, or the page of the settings. */
  via: 'approval' | 'settings';
}

/** At most this many folders in the permanent list. */
export const MAX_MAC_FOLDERS = 50;

/** The event of a change of the list: ids only, never a path (L0). */
export const MAC_FOLDER_EVENT = 'mac.folder';

export async function listMacFolders(sql: Queryable): Promise<MacFolder[]> {
  return [
    ...(await sql<MacFolder[]>`
      SELECT id::text, path, added_at AS "addedAt", CASE WHEN approval_id IS NULL THEN 'settings' ELSE 'approval' END AS via
      FROM mac_folders WHERE removed_at IS NULL ORDER BY added_at, id`),
  ];
}

/** The folders of the permanent list, as written. */
export async function permanentMacFolders(sql: Queryable): Promise<string[]> {
  return (await sql<{ path: string }[]>`SELECT path FROM mac_folders WHERE removed_at IS NULL ORDER BY path`).map((row) => row.path);
}

/** The folders allowed «Per tutta questa conversazione»: approved cards of its tasks with that choice. */
export async function conversationMacFolders(sql: Queryable, conversationId: string): Promise<string[]> {
  const rows = await sql<{ folder: string }[]>`
    SELECT DISTINCT a.detail ->> 'folder' AS folder FROM approvals a JOIN tasks t ON t.id = a.task_id
    WHERE t.conversation_id = ${conversationId} AND a.kind = 'mac' AND a.state = 'approved' AND a.choice = 'conversation'
      AND a.detail ? 'folder'`;
  return rows.map((row) => row.folder);
}

/** A folder the user typed in the settings, checked: resolved, allowed by the rules, an existing folder. */
export async function checkFolderInput(raw: unknown, env: MacEnv): Promise<string> {
  let path: string;
  try {
    path = resolveMacPath(raw, env.home);
  } catch {
    throw new MacPathError('Scrivi il percorso dalla cartella Inizio, per esempio ~/Documents/Fatture, oppure il percorso di un disco esterno sotto /Volumes.');
  }
  const home = resolve(env.home);
  const refused = pathRefusal(path, [home], env.excluded);
  if (refused !== undefined) throw new MacPathError(REFUSAL_ITALIAN[refused]);
  let real: string;
  let isFolder: boolean;
  try {
    real = await realpath(path);
    isFolder = (await stat(real)).isDirectory();
  } catch {
    throw new MacPathError(`${displayPath(path, home)} non esiste`);
  }
  if (!isFolder) throw new MacPathError(`${displayPath(path, home)} non è una cartella`);
  // The folder as it really is: a link or a disk alias is checked and saved resolved (no ~/desktop next to ~/Desktop).
  let homes = [home];
  try {
    homes = [...new Set([home, await realpath(home)])];
  } catch {
    // A home that is not there: only the path as written.
  }
  const realRefused = pathRefusal(real, homes, env.excluded);
  if (realRefused !== undefined) throw new MacPathError(REFUSAL_ITALIAN[realRefused]);
  if (real === '/') throw new MacPathError(REFUSAL_ITALIAN.outside);
  return real;
}

/**
 * Adds a folder to the permanent list; the same folder again changes
 * nothing. `approvalId`: the card «Sempre» that added it. Only the user's
 * decision or the page of the settings call this.
 */
export async function addMacFolder(sql: Queryable, path: string, options: { approvalId?: string } = {}): Promise<{ added: boolean }> {
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mac_folders WHERE removed_at IS NULL`;
  if ((count?.n ?? 0) >= MAX_MAC_FOLDERS) throw new MacPathError(`al massimo ${String(MAX_MAC_FOLDERS)} cartelle`);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO mac_folders (path, approval_id) VALUES (${path}, ${options.approvalId ?? null})
    ON CONFLICT (path) WHERE removed_at IS NULL DO NOTHING RETURNING id::text`;
  if (row === undefined) return { added: false };
  await appendEvent(sql, { kind: MAC_FOLDER_EVENT, label: 'L0', payload: { action: 'added', id: row.id, via: options.approvalId === undefined ? 'settings' : 'approval' } });
  return { added: true };
}

/** Takes a folder off the permanent list; false when it was not there. */
export async function removeMacFolder(sql: Queryable, id: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`UPDATE mac_folders SET removed_at = now() WHERE id = ${id} AND removed_at IS NULL RETURNING id::text`;
  if (row === undefined) return false;
  await appendEvent(sql, { kind: MAC_FOLDER_EVENT, label: 'L0', payload: { action: 'removed', id } });
  return true;
}

/** A folder of the list as the page shows it: `~/Desktop` and «Scrivania». */
export function folderView(folder: MacFolder, home: string): { id: string; path: string; place: string; addedAt: Date; via: MacFolder['via'] } {
  const base = resolve(home);
  return { id: folder.id, path: displayPath(folder.path, base), place: placeName(folder.path, base), addedAt: folder.addedAt, via: folder.via };
}
