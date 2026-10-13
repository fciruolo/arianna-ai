import type { Project } from '@arianna/config';

import { secretaryConversationId } from './commitments.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { cardOfShortId } from './im-cards.ts';
import { fixAllClosedPrices } from './im-billing.ts';
import { localImDate, longDate, meetingTime } from './im-format.ts';
import { finishImClosing, ImError, isLastIm, listIms, markCardItems, readIm, type ImSummary } from './im.ts';
import { KnowledgeError, type KnowledgeEnv } from './project-knowledge.ts';

/**
 * The IM between meetings (D-167, P4b), looked at every half minute:
 * - once the meeting of an IM is over (the moved call, else the date), the
 *   closing: with items still open, a message of Arianna in the secretary
 *   conversation asks item by item (the web chat shows the buttons under it,
 *   `im_closings`); with none, the IM is closed at once;
 * - a card that arrived in "Fatto" checks its items (`#card-<short id>`).
 * The messages are written here, never by a model, and name only the project
 * and the number and date of the IM.
 */

/** The label of the messages of the closing: the secretary conversation is private. */
const CLOSING_LABEL = 'L2';

export interface ImClosing {
  id: string;
  project: string;
  im: number;
  messageId: string | null;
  openedAt: string;
  closedAt: string | null;
}

export async function listImClosings(sql: Queryable, open = false): Promise<ImClosing[]> {
  const rows = await sql<ImClosing[]>`
    SELECT id::text, project, im, message_id::text AS "messageId", opened_at::text AS "openedAt", closed_at::text AS "closedAt"
    FROM im_closings ${open ? sql`WHERE closed_at IS NULL` : sql``}
    ORDER BY opened_at DESC, id DESC LIMIT 100`;
  return [...rows];
}

export async function loadImClosing(sql: Queryable, id: string): Promise<ImClosing | undefined> {
  const [row] = await sql<ImClosing[]>`
    SELECT id::text, project, im, message_id::text AS "messageId", opened_at::text AS "openedAt", closed_at::text AS "closedAt"
    FROM im_closings WHERE id = ${id}`;
  return row;
}

/** The text that asks: the project, the IM and how many items are open, nothing of the items. */
export function closingText(project: string, im: ImSummary): string {
  const open = im.counts.todo + im.counts.doing;
  const when = im.date === null ? '' : ` (${longDate(im.date)})`;
  const items = open === 1 ? "C'è una voce ancora aperta" : `Ci sono ${String(open)} voci ancora aperte`;
  return `È passato l'IM-${String(im.number)} di ${project}${when}. ${items}: dimmi qui sotto, voce per voce, se è finita. Quelle non finite passano all'IM successivo.`;
}

/** The text at the end of the closing of the last IM of the project (D-169). */
export function endedText(project: string, number: number): string {
  return `Chiuso l'IM-${String(number)} di ${project}, l'ultimo: gli IM del progetto sono terminati. Le voci non finite restano come card nel cardwall.`;
}

/** The text at the end of a closing. */
export function closedText(project: string, number: number): string {
  return `Chiuso l'IM-${String(number)} di ${project}: le voci rimaste sono nell'IM successivo.`;
}

async function postMessage(tx: Queryable, text: string, payload: Record<string, unknown>): Promise<string> {
  const conversationId = await secretaryConversationId(tx);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, channel, label, body)
    VALUES (${conversationId}, 'assistant', 'web', ${CLOSING_LABEL}::privacy_label, ${text})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO messages returned no row');
  await appendEvent(tx, { kind: 'message.created', label: 'L0', payload: { conversationId, messageId: row.id, role: 'assistant', ...payload } });
  return row.id;
}

/** The closing of one IM whose meeting is over, once: a question when items are open, else closed at once. */
async function openClosing(sql: Sql, projects: readonly Project[], env: KnowledgeEnv, project: string, im: ImSummary, now: Date): Promise<void> {
  const open = im.counts.todo + im.counts.doing;
  if (open === 0) {
    // The file first: the row says closed only for an IM that is.
    if (!finishImClosing(projects, project, env, im.number, now)) return;
    await sql`
      INSERT INTO im_closings (project, im, closed_at) VALUES (${project}, ${im.number}, now())
      ON CONFLICT (project, im) DO NOTHING`;
    return;
  }
  await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO im_closings (project, im) VALUES (${project}, ${im.number})
      ON CONFLICT (project, im) DO NOTHING RETURNING id::text`;
    if (row === undefined) return;
    const messageId = await postMessage(tx, closingText(project, im), { imClosing: row.id });
    await tx`UPDATE im_closings SET message_id = ${messageId} WHERE id = ${row.id}`;
  });
}

/**
 * The closing answered to the end (D-167): when no item of the IM is open,
 * the postponed ones go to the next IM, the IM becomes `chiuso`, the row is
 * closed and Arianna says so. Returns true when it closed.
 */
export async function finishClosing(sql: Sql, projects: readonly Project[], env: KnowledgeEnv, closing: ImClosing, now = new Date()): Promise<boolean> {
  if (closing.closedAt !== null) return true;
  // Asked before: the last IM of the project (D-169) makes no next one, and says so.
  const last = isLastIm(projects, closing.project, env, closing.im, now);
  if (!finishImClosing(projects, closing.project, env, closing.im, now)) return false;
  await sql.begin(async (tx) => {
    const closed = await tx`UPDATE im_closings SET closed_at = now() WHERE id = ${closing.id} AND closed_at IS NULL RETURNING id`;
    if (closed.length > 0) await postMessage(tx, last ? endedText(closing.project, closing.im) : closedText(closing.project, closing.im), { imClosing: closing.id });
  });
  return true;
}

export interface ImWatcher {
  /** One look at every project; exported for the tests. */
  check(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface ImWatcherOptions {
  sql: Sql;
  projects: () => readonly Project[];
  env: KnowledgeEnv;
  onError: (error: unknown) => void;
  now?: () => Date;
  intervalMs?: number;
}

export function createImWatcher(options: ImWatcherOptions): ImWatcher {
  const { sql, env, onError } = options;
  const now = options.now ?? (() => new Date());
  // The events of cards moved to "Fatto" read so far: from the start of the core on.
  let cursor: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function cardsDone(): Promise<{ project: string; id: string }[]> {
    if (cursor === undefined) {
      // At start: every card of a project in "Fatto" now (one moved while the core was off counts too).
      const [row] = await sql<{ id: string | null }[]>`SELECT max(id)::text AS id FROM events`;
      cursor = row?.id ?? '0';
      const rows = await sql<{ project: string; id: string }[]>`
        SELECT project, id::text FROM tasks WHERE conversation_id IS NULL AND project IS NOT NULL AND status = 'done'`;
      return rows.map(({ project, id }) => ({ project, id }));
    }
    const rows = await sql<{ event: string; project: string; id: string }[]>`
      SELECT e.id::text AS event, t.project, t.id::text AS id
      FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.id > ${cursor}::bigint AND e.kind = 'task.status' AND e.payload->>'to' = 'done'
        AND t.conversation_id IS NULL AND t.project IS NOT NULL
      ORDER BY e.id`;
    // Only as far as what was read: an event written meanwhile is read at the next look.
    cursor = rows.at(-1)?.event ?? cursor;
    return rows.map(({ project, id }) => ({ project, id }));
  }

  async function check(): Promise<void> {
    const projects = options.projects();
    const names = new Set(projects.map((project) => project.name));
    for (const card of await cardsDone()) {
      if (!names.has(card.project)) continue;
      const short = card.id.slice(0, 8);
      // A short id two cards of the project share names neither.
      if ((await cardOfShortId(sql, card.project, short))?.id !== card.id) continue;
      try {
        markCardItems(projects, card.project, env, short);
      } catch (error) {
        if (!(error instanceof KnowledgeError)) onError(error);
      }
    }
    // The price of the project fixed on the IM closed meanwhile (P4d, D-169), in Obsidian too.
    await fixAllClosedPrices(sql, projects, env, onError);
    const moment = now();
    const at = localImDate(moment);
    // A closing whose last item was closed elsewhere (Obsidian, the cardwall, a card) ends here.
    for (const closing of await listImClosings(sql, true)) {
      if (!names.has(closing.project)) continue;
      try {
        await finishClosing(sql, projects, env, closing, moment);
      } catch (error) {
        if (!(error instanceof KnowledgeError || error instanceof ImError)) onError(error);
      }
    }
    for (const project of projects) {
      let ims: ImSummary[];
      try {
        ims = listIms(projects, project.name, env);
      } catch (error) {
        // A project without its folder, or not readable: nothing to close there.
        if (!(error instanceof KnowledgeError)) onError(error);
        continue;
      }
      // Only the last IM whose meeting is over: older ones left open are closed by hand, never in a chain.
      const due = ims.filter((im) => {
        const when = meetingTime(im);
        return when !== null && when <= at;
      }).at(-1);
      if (due === undefined || due.status === 'chiuso') continue;
      try {
        await openClosing(sql, projects, env, project.name, due, moment);
      } catch (error) {
        if (!(error instanceof ImError)) onError(error);
      }
    }
  }

  return {
    check,
    start() {
      if (timer !== undefined) return;
      const tick = (): void => {
        if (running) return;
        running = true;
        check()
          .catch(onError)
          .finally(() => {
            running = false;
          });
      };
      tick();
      timer = setInterval(tick, options.intervalMs ?? 30_000);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** For a closing answered in the chat: the IM as the buttons show it. */
export function closingIm(projects: readonly Project[], env: KnowledgeEnv, closing: ImClosing) {
  return readIm(projects, closing.project, env, closing.im);
}
