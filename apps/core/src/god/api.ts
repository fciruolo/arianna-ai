import type { Project } from '@arianna/config';

import type { Conversation } from '../conversations.ts';
import type { Queryable } from '../db/client.ts';
import type { ChangelogRef } from './changelog-carry.ts';
import { cloneState, GOD_AGENT, GOD_CONTAINER, GOD_MAIN, GOD_PROJECT, godWorkspace, syncGodClone, type CloneState } from './clone.ts';
import { concurrencyFor, projection, quotaReadings } from './quota.ts';
import type { GodWork, MessagePlan, PlanView, SubtaskView } from './work.ts';

/**
 * What the page of GOD shows (D-127): whether the project is registered as it
 * must be, the clone GOD reads, GOD's conversations, the quota and how many
 * subtasks work at once. Names, paths of the container and counts only:
 * nothing of the clone's files.
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
  /** The projected share of the fullest window of Claude (null: no reading), and the subtasks at once it allows. */
  quota: { projection: number | null; concurrency: number };
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
  /** Makes a new clone usable (prepare.ts). */
  prepare?: (dir: string) => Promise<void>;
  /** Plans and subtasks (G2-G3); absent, their routes answer 404. */
  work?: GodWork;
}

export type SubtaskAction = 'stop' | 'resume' | 'discard' | 'branch';

export interface GodApi {
  status(): Promise<GodStatus>;
  /** "Aggiorna il clone": creates or updates repos/arianna/main (pnpm god:clone). */
  syncClone(): Promise<GodStatus>;
  work?: {
    plans(): Promise<PlanView[]>;
    messagePlan(messageId: string): Promise<MessagePlan>;
    approve(messageId: string): Promise<PlanView>;
    act(subtaskId: string, action: SubtaskAction): Promise<SubtaskView>;
    restart(conversationId: string): Promise<Conversation>;
    carry(conversationId: string): Promise<{ body: string; from: string | null; changelog: string | null } | null>;
    /** "Parlane con GOD" (I-6, D-178): a new conversation with GOD about an entry of the register of the versions. */
    discuss(ref: ChangelogRef): Promise<Conversation>;
  };
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
  const { sql, home, data, work } = options;
  const status = async (): Promise<GodStatus> => {
    const now = new Date();
    const projected = projection(await quotaReadings(sql, now), now);
    return {
      project: projectState(options.projects()),
      workspace: godWorkspace(GOD_MAIN),
      container: GOD_CONTAINER,
      main: await cloneState(home, data, GOD_MAIN),
      available: options.available(),
      conversations: await godConversations(sql),
      quota: { projection: projected ?? null, concurrency: concurrencyFor(projected) },
    };
  };
  // One sync at a time: a second click waits for the first.
  let syncing: Promise<unknown> = Promise.resolve();
  return {
    status,
    async syncClone() {
      const run = syncing.then(() => syncGodClone(home, data, undefined, options.prepare));
      syncing = run.catch(() => undefined);
      await run;
      return status();
    },
    ...(work === undefined
      ? {}
      : {
          work: {
            plans: () => work.plans(),
            messagePlan: (messageId) => work.messagePlan(messageId),
            approve: (messageId) => work.approve(messageId),
            act: (subtaskId, action) => {
              if (action === 'stop') return work.stop(subtaskId);
              if (action === 'resume') return work.resume(subtaskId);
              if (action === 'discard') return work.discard(subtaskId);
              return work.prepareBranch(subtaskId);
            },
            restart: (conversationId) => work.restart(conversationId),
            carry: (conversationId) => work.carry(conversationId),
            discuss: (ref) => work.discuss(ref),
          },
        }),
  };
}
