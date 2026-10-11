import type { Project } from '@arianna/config';

import type { Queryable } from '../db/client.ts';
import { cloneState, GOD_AGENT, GOD_CONTAINER, GOD_MAIN, GOD_PROJECT, godWorkspace, syncGodClone, type CloneState } from './clone.ts';

/**
 * What the page of GOD shows (D-127): whether the project is registered as it
 * must be, the clone GOD reads, and GOD's conversations. Names, paths of the
 * container and counts only: nothing of the clone's files.
 */
export interface GodStatus {
  /** `missing`: no project `arianna`; `wrong-path`: one that is not repos/arianna; `ok`. */
  project: 'missing' | 'wrong-path' | 'ok';
  /** The part GOD's chat opens on. */
  workspace: string;
  container: string;
  main: CloneState;
  /** GOD can answer now: its card is active and one of its cloud executors is on. */
  available: boolean;
  conversations: GodConversation[];
}

export interface GodConversation {
  id: string;
  title: string | null;
  workspace: string | null;
  model: string | null;
  lastAt: Date;
}

export interface GodApiOptions {
  sql: Queryable;
  home: string;
  data: string;
  /** The projects of arianna.toml as they are now. */
  projects: () => readonly Project[];
  /** GOD can answer a direct chat now (direct-chat.ts). */
  available: () => boolean;
}

export interface GodApi {
  status(): Promise<GodStatus>;
  /** "Aggiorna il clone": creates or updates repos/arianna/main (pnpm god:clone). */
  syncClone(): Promise<GodStatus>;
}

/** The conversations with GOD, the latest active first: not archived, not deleted. */
export async function godConversations(sql: Queryable, limit = 30): Promise<GodConversation[]> {
  return sql<GodConversation[]>`
    SELECT c.id::text, c.title, c.workspace, c.model,
           coalesce((SELECT max(m.ts) FROM messages m WHERE m.conversation_id = c.id), c.created_at) AS "lastAt"
    FROM conversations c
    WHERE c.agent = ${GOD_AGENT} AND c.purged_at IS NULL AND c.archived_at IS NULL
    ORDER BY "lastAt" DESC, c.id DESC
    LIMIT ${limit}`;
}

/** Whether the project `arianna` is registered on the container of the clones. */
export function projectState(projects: readonly Project[]): GodStatus['project'] {
  const project = projects.find((item) => item.name === GOD_PROJECT);
  if (project === undefined) return 'missing';
  return project.path === GOD_CONTAINER ? 'ok' : 'wrong-path';
}

export function createGodApi(options: GodApiOptions): GodApi {
  const { sql, home, data } = options;
  const status = async (): Promise<GodStatus> => ({
    project: projectState(options.projects()),
    workspace: godWorkspace(GOD_MAIN),
    container: GOD_CONTAINER,
    main: await cloneState(home, data, GOD_MAIN),
    available: options.available(),
    conversations: await godConversations(sql),
  });
  // One sync at a time: a second click waits for the first.
  let syncing: Promise<unknown> = Promise.resolve();
  return {
    status,
    async syncClone() {
      const run = syncing.then(() => syncGodClone(home, data));
      syncing = run.catch(() => undefined);
      await run;
      return status();
    },
  };
}
