import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { isAtMost, type Label } from '@arianna/policy';

import { ChatError, loadConversation, loadMessage, writeConversation, writeUserMessage } from '../conversations.ts';
import type { Queryable, Sql } from '../db/client.ts';
import type { DirectPolicy } from '../direct-chat.ts';
import { appendEvent } from '../events.ts';
import {
  createSubtaskClone,
  GOD_AGENT,
  GOD_CONTAINER,
  GOD_MAIN,
  GOD_MARKER,
  godCloneRefusal,
  godGit,
  godPartDir,
  godPartOf,
  godWorkspace,
  subtaskBranch,
  type GitRunner,
} from './clone.ts';
import { overlaps, partName, planOfAnswer, type GodPlanProposal } from './plan.ts';
import { concurrencyFor, projection, quotaReadings } from './quota.ts';

/**
 * The work of GOD (D-127, G2-G3): a plan the user approved becomes subtasks,
 * each in a clone of its own (repos/arianna/<part>, branch god/<part>) with a
 * direct chat of the Coder that does it (D-111: the same chain of every
 * delegation, gateway and sandbox included) started by the code with the
 * subtask as its first message; when the Coder answers, the Reviewer reviews
 * the change in its own direct chat on the same clone. The tick below moves
 * each subtask from what its chats say, starts the next ones within the
 * quota, and never runs anything of the clones: git with no hooks only for
 * "Prepara il ramo", at the user's click.
 *
 * States: queued → working → reviewing → reviewed → branch; attention when
 * the Coder did not finish (the user writes in its chat, and the subtask goes
 * on); stopped by "Ferma"; discarded by "Scarta". A message of the user to
 * the Coder after the review starts the work again, and a new review after.
 */
export const SUBTASK_STATES = ['queued', 'working', 'reviewing', 'reviewed', 'attention', 'stopped', 'branch', 'discarded'] as const;
export type SubtaskState = (typeof SUBTASK_STATES)[number];
export type ReviewVerdict = 'ok' | 'changes' | 'unknown';

export const CODER_AGENT = 'coder';
export const REVIEWER_AGENT = 'reviewer';
/** Who signs the commit of "Prepara il ramo": the core, at the user's click (the agents never commit, D-174). */
export const COMMIT_IDENTITY = ['-c', 'user.name=Arianna GOD', '-c', 'user.email=god@arianna.invalid', '-c', 'commit.gpgsign=false'];

export class GodError extends Error {
  override name = 'GodError';
  readonly code: 'invalid' | 'not-found' | 'conflict';

  constructor(code: 'invalid' | 'not-found' | 'conflict', message: string) {
    super(message);
    this.code = code;
  }
}

export interface GodWorkEnv {
  sql: Sql;
  home: string;
  data: string;
  /** The names of the approved work parts now (`arianna:main`, `arianna:g001-…`, other projects). */
  parts: () => readonly string[];
  /** The direct chat policy of an agent now (direct-chat.ts), undefined when it cannot answer. */
  policy: (agent: string) => DirectPolicy | undefined;
  /** The cloud models a work conversation may choose now. */
  models: () => readonly string[];
  /** Stops the step of a task the worker runs now; false when none runs (engine.ts, cause `god`). */
  stopTask: (taskId: string) => boolean;
  /** Makes a new clone usable: dependencies and the development configuration (best effort). */
  prepareClone?: (dir: string) => Promise<void>;
  git?: GitRunner;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

interface SubtaskRow {
  id: string;
  planId: string;
  position: number;
  part: string;
  title: string;
  goal: string;
  files: string[];
  blockedBy: number[];
  state: SubtaskState;
  reason: string | null;
  review: ReviewVerdict | null;
  conversationId: string | null;
  reviewConversationId: string | null;
  commitSha: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PlanRow {
  id: string;
  conversationId: string;
  messageId: string;
  title: string;
  model: string | null;
  label: Label;
  createdAt: Date;
}

export interface SubtaskView extends Omit<SubtaskRow, 'planId'> {
  branch: string;
  /** The folder of its clone, relative to the home. */
  path: string;
  /** Files the Coder changed, from its answers. */
  changed: string[];
  /** Of those, the ones outside the files the subtask owns. */
  outside: string[];
  /** For a branch ready: whether it is already in the installation's main. */
  merged?: boolean;
  /** For a branch ready: the commands that merge it, run in the folder of the installation. */
  mergeCommands?: string[];
}

export interface PlanView extends PlanRow {
  subtasks: SubtaskView[];
}

/** What the chat shows under an answer of GOD with a plan block. */
export interface MessagePlan {
  proposal?: GodPlanProposal;
  error?: string;
  /** Once approved: the plan with its subtasks. */
  approved?: PlanView;
}

const SUBTASK_COLUMNS = `s.id::text, s.plan_id::text AS "planId", s.position, s.part, s.title, s.goal, s.files, s.blocked_by AS "blockedBy", s.state, s.reason,
  s.review, s.conversation_id::text AS "conversationId", s.review_conversation_id::text AS "reviewConversationId", s.commit_sha AS "commitSha",
  s.created_at AS "createdAt", s.updated_at AS "updatedAt"`;
const PLAN_COLUMNS = `p.id::text, p.conversation_id::text AS "conversationId", p.message_id::text AS "messageId", p.title, p.model, p.label, p.created_at AS "createdAt"`;

/** The commands that bring a subtask's branch into the installation, run in its folder. */
export function mergeCommandsOf(part: string): string[] {
  return [`git fetch ${GOD_CONTAINER}/${part} ${subtaskBranch(part)}`, 'git merge --no-ff FETCH_HEAD'];
}

/** The first message of a subtask's Coder, as the user reads it in its chat (in Italian: it is the user's side of the chat). */
export function subtaskBrief(plan: Pick<PlanRow, 'title'>, subtask: Pick<SubtaskRow, 'position' | 'title' | 'goal' | 'files' | 'part'>, total: number): string {
  return [
    `Sottocompito ${String(subtask.position)} di ${String(total)} del piano «${plan.title}» (GOD, D-127): ${subtask.title}`,
    subtask.goal,
    ['I file tuoi (non cambiarne altri: un altro sottocompito lavora in parallelo sugli altri):', ...subtask.files.map((file) => `- ${file}`)].join('\n'),
    [
      `Sei nel clone ${GOD_CONTAINER}/${subtask.part}, sul ramo ${subtaskBranch(subtask.part)}, con soli dati finti.`,
      'Lavora come dice CLAUDE.md del clone, con i test. Nella sandbox lancia pnpm build, pnpm lint, pnpm eval e i test dei pacchetti che tocchi: database, server, Docker e rete sono negati, e non servono.',
      'Non aggiornare CHANGELOG.md, docs/HANDOFF.md né docs/DECISIONS.md: li aggiorna chi unisce. Non fare commit.',
      'Alla fine di\' cosa hai cambiato, come l\'hai verificato e cosa resta.',
    ].join(' '),
  ].join('\n\n');
}

/** The Reviewer's message: the subtask, its files, and the line of the verdict the tick reads. */
export function reviewBrief(subtask: Pick<SubtaskRow, 'title' | 'goal' | 'files' | 'part'>, again: boolean): string {
  return [
    again
      ? `Il Coder ha cambiato di nuovo il lavoro del sottocompito «${subtask.title}» (GOD, D-127): rivedi le modifiche non committate di adesso.`
      : `Rivedi il lavoro del sottocompito «${subtask.title}» (GOD, D-127) nel clone ${GOD_CONTAINER}/${subtask.part}, ramo ${subtaskBranch(subtask.part)}: le modifiche non committate (git status, git diff).`,
    `Obiettivo del sottocompito:\n${subtask.goal}`,
    ['File previsti (segnala ogni file cambiato fuori da questi):', ...subtask.files.map((file) => `- ${file}`)].join('\n'),
    'Puoi lanciare build, lint, eval e i test nella sandbox. Nella prima riga scrivi «ESITO: approvato» oppure «ESITO: da correggere», poi i punti con file e riga.',
  ].join('\n\n');
}

/** The Reviewer's verdict in its answer: the line «ESITO: …». */
export function verdictOf(body: string | undefined): ReviewVerdict {
  if (body === undefined) return 'unknown';
  const match = /ESITO\s*:\s*(approvato|da correggere)/i.exec(body);
  if (match === null) return 'unknown';
  return match[1]?.toLowerCase() === 'approvato' ? 'ok' : 'changes';
}

/** The files the Coder changed that the subtask does not own. */
export function outsideFiles(owned: readonly string[], changed: readonly string[]): string[] {
  return changed.filter((path) => !owned.some((entry) => overlaps(entry, path) && (entry.endsWith('/') || entry.toLowerCase() === path.toLowerCase())));
}

interface LatestTask {
  id: string;
  status: string;
  createdAt: Date;
  delegation: string | null;
  pending: boolean;
}

/** The latest task of a conversation, its delegation's status and whether an approval waits. */
async function latestTask(sql: Queryable, conversationId: string): Promise<LatestTask | undefined> {
  const [row] = await sql<LatestTask[]>`
    SELECT t.id::text, t.status::text, t.created_at AS "createdAt",
           (SELECT d.status FROM task_delegations d WHERE d.task_id = t.id ORDER BY d.step DESC LIMIT 1) AS delegation,
           EXISTS (SELECT FROM approvals a WHERE a.task_id = t.id AND a.state = 'pending') AS pending
    FROM tasks t WHERE t.conversation_id = ${conversationId}
    ORDER BY t.created_at DESC, t.id DESC LIMIT 1`;
  return row;
}

type Outcome = 'busy' | 'answered' | 'stuck';

function outcomeOf(task: LatestTask | undefined): Outcome {
  if (task === undefined) return 'stuck';
  if (task.status === 'ready' || task.status === 'running' || task.status === 'inbox' || (task.status === 'waiting_user' && task.pending)) return 'busy';
  if (task.status === 'done') return 'answered';
  return 'stuck';
}

/** The tasks of a conversation still at work: the ones "Ferma" stops. */
async function activeTasks(sql: Queryable, conversationId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT id::text FROM tasks WHERE conversation_id = ${conversationId} AND status IN ('ready', 'running')`;
  return rows.map((row) => row.id);
}

/** The latest answer of the agent of a conversation. */
async function latestAnswer(sql: Queryable, conversationId: string): Promise<string | undefined> {
  const [row] = await sql<{ body: string }[]>`
    SELECT body FROM messages WHERE conversation_id = ${conversationId} AND role = 'assistant' AND agent IS NOT NULL
    ORDER BY ts DESC, id DESC LIMIT 1`;
  return row?.body;
}

/** The files the Coder changed in its answers of a conversation (D-082), each once. */
async function changedFiles(sql: Queryable, conversationId: string): Promise<string[]> {
  const rows = await sql<{ path: string }[]>`
    SELECT DISTINCT f.value ->> 'path' AS path FROM task_delegations d
      JOIN tasks t ON t.id = d.task_id, jsonb_array_elements(coalesce(d.files, '[]'::jsonb)) f
    WHERE t.conversation_id = ${conversationId} AND d.status = 'ok' AND f.value ->> 'path' IS NOT NULL
    ORDER BY 1`;
  return rows.map((row) => row.path);
}

async function setState(sql: Queryable, id: string, state: SubtaskState, extra: { reason?: string | null; review?: ReviewVerdict | null; conversationId?: string; reviewConversationId?: string; commitSha?: string } = {}): Promise<void> {
  await sql`
    UPDATE god_subtasks SET state = ${state}, reason = ${extra.reason ?? null},
      conversation_id = coalesce(${extra.conversationId ?? null}::uuid, conversation_id),
      review_conversation_id = coalesce(${extra.reviewConversationId ?? null}::uuid, review_conversation_id),
      commit_sha = coalesce(${extra.commitSha ?? null}::text, commit_sha),
      updated_at = now()
    WHERE id = ${id}`;
  if (extra.review !== undefined) await sql`UPDATE god_subtasks SET review = ${extra.review} WHERE id = ${id}`;
  await appendEvent(sql, { kind: 'god.subtask', label: 'L0', payload: { subtaskId: id, state } });
}

/** A short reason in our words, kept within the column. */
function reason(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}

export function createGodWork(env: GodWorkEnv) {
  const { sql, home, data } = env;
  const git = env.git ?? godGit(home, data);
  const now = env.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  /** One change of the subtasks at a time (tick and actions): the core is one process. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work);
    chain = run.catch(() => undefined);
    return run;
  };

  async function isMerged(commit: string): Promise<boolean> {
    return git(['merge-base', '--is-ancestor', commit, `refs/heads/${GOD_MAIN}`], home).then(
      () => true,
      () => false,
    );
  }

  async function loadPlan(id: string): Promise<PlanRow | undefined> {
    const [row] = await sql.unsafe<PlanRow[]>(`SELECT ${PLAN_COLUMNS} FROM god_plans p WHERE p.id = $1`, [id]);
    return row;
  }

  async function loadSubtasks(where: string, values: unknown[]): Promise<SubtaskRow[]> {
    return sql.unsafe<SubtaskRow[]>(`SELECT ${SUBTASK_COLUMNS} FROM god_subtasks s WHERE ${where} ORDER BY s.created_at, s.position`, values as never[]);
  }

  async function view(row: SubtaskRow): Promise<SubtaskView> {
    const changed = row.conversationId === null ? [] : await changedFiles(sql, row.conversationId);
    const base: SubtaskView = {
      id: row.id,
      position: row.position,
      part: row.part,
      title: row.title,
      goal: row.goal,
      files: row.files,
      blockedBy: row.blockedBy,
      state: row.state,
      reason: row.reason,
      review: row.review,
      conversationId: row.conversationId,
      reviewConversationId: row.reviewConversationId,
      commitSha: row.commitSha,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      branch: subtaskBranch(row.part),
      path: `${GOD_CONTAINER}/${row.part}`,
      changed,
      outside: outsideFiles(row.files, changed),
    };
    if (row.state === 'branch' && row.commitSha !== null) return { ...base, merged: await isMerged(row.commitSha), mergeCommands: mergeCommandsOf(row.part) };
    return base;
  }

  async function planView(plan: PlanRow): Promise<PlanView> {
    const rows = await loadSubtasks('s.plan_id = $1', [plan.id]);
    return { ...plan, subtasks: await Promise.all(rows.map(view)) };
  }

  /** The GOD answer `messageId`, when it is one: an assistant message of GOD in a conversation with GOD. */
  async function godAnswer(messageId: string): Promise<{ body: string; label: Label; conversationId: string; model: string | null } | undefined> {
    if (!/^[1-9][0-9]{0,17}$/.test(messageId)) return undefined;
    const message = await loadMessage(sql, messageId);
    if (message === undefined || message.role !== 'assistant' || message.agent !== GOD_AGENT) return undefined;
    const conversation = await loadConversation(sql, message.conversationId);
    if (conversation?.agent !== GOD_AGENT || godPartOf(conversation.workspace) === undefined) return undefined;
    return { body: message.body, label: message.label, conversationId: conversation.id, model: conversation.model };
  }

  /** The plan under an answer of GOD: the proposal checked now, and the approved plan if any. */
  async function messagePlan(messageId: string): Promise<MessagePlan> {
    const answer = await godAnswer(messageId);
    if (answer === undefined) throw new GodError('not-found', 'not an answer of GOD');
    const checked = planOfAnswer(answer.body);
    const [approved] = await sql.unsafe<PlanRow[]>(`SELECT ${PLAN_COLUMNS} FROM god_plans p WHERE p.message_id = $1::bigint`, [messageId]);
    return {
      ...(checked === undefined ? { error: 'nessun piano in questa risposta' } : 'error' in checked ? { error: checked.error } : { proposal: checked }),
      ...(approved === undefined ? {} : { approved: await planView(approved) }),
    };
  }

  /** "Approva e avvia": the plan of the answer, checked again here, becomes queued subtasks; then the tick starts them. */
  async function approve(messageId: string): Promise<PlanView> {
    const answer = await godAnswer(messageId);
    if (answer === undefined) throw new GodError('not-found', 'not an answer of GOD');
    const checked = planOfAnswer(answer.body);
    if (checked === undefined) throw new GodError('invalid', 'nessun piano in questa risposta');
    if ('error' in checked) throw new GodError('invalid', checked.error);
    if (!isAtMost(answer.label, 'L1')) throw new GodError('invalid', 'il piano è sopra Interno: non va ai sottocompiti');
    const id = await sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string }[]>`SELECT id::text FROM god_plans WHERE message_id = ${messageId}::bigint`;
      if (existing !== undefined) throw new GodError('conflict', 'questo piano è già approvato');
      // One numbering for every subtask ever made: a part's folder is never reused (the column is unique).
      const [{ last } = { last: 0 }] = await tx<{ last: number }[]>`SELECT coalesce(max(substring(part from 2 for 3)::int), 0) AS last FROM god_subtasks`;
      if (last + checked.subtasks.length > 999) throw new GodError('conflict', 'i sottocompiti di GOD sono arrivati a 999');
      const model = answer.model !== null && /^[a-z][a-z0-9-]{0,31}$/.test(answer.model) ? answer.model : null;
      const [plan] = await tx<{ id: string }[]>`
        INSERT INTO god_plans (conversation_id, message_id, title, model, label)
        VALUES (${answer.conversationId}, ${messageId}::bigint, ${checked.title}, ${model}, ${answer.label}::privacy_label)
        RETURNING id::text`;
      if (plan === undefined) throw new Error('INSERT INTO god_plans returned no row');
      for (const [index, subtask] of checked.subtasks.entries()) {
        await tx`
          INSERT INTO god_subtasks (plan_id, position, part, title, goal, files, blocked_by)
          VALUES (${plan.id}, ${index + 1}, ${partName(last + index + 1, subtask.title)}, ${subtask.title}, ${subtask.goal}, ${tx.json(subtask.files)}, ${subtask.blockedBy})`;
      }
      await appendEvent(tx, { kind: 'god.plan', label: 'L0', payload: { planId: plan.id, subtasks: checked.subtasks.length } });
      return plan.id;
    });
    const plan = await loadPlan(id);
    if (plan === undefined) throw new Error('the plan is missing');
    void tick().catch((error: unknown) => env.onError?.(error));
    return planView(plan);
  }

  /** The latest plans, the newest first, with their subtasks. */
  async function plans(limit = 20): Promise<PlanView[]> {
    const rows = await sql.unsafe<PlanRow[]>(`SELECT ${PLAN_COLUMNS} FROM god_plans p ORDER BY p.created_at DESC LIMIT $1`, [limit]);
    return Promise.all(rows.map(planView));
  }

  /** Opens a direct chat of `agent` on the subtask's clone with its first message, in one transaction. */
  async function openChat(agent: string, policy: DirectPolicy, part: string, model: string | null, body: string): Promise<string> {
    return sql.begin(async (tx) => {
      const conversation = await writeConversation(tx, {
        mode: 'work',
        project: godWorkspace(part),
        projects: env.parts(),
        agent: { name: agent, modes: policy.modes, project: policy.project },
        ...(model !== null && env.models().includes(model) ? { model } : {}),
      });
      await writeUserMessage(tx, conversation.id, body);
      return conversation.id;
    });
  }

  /** A new clone, usable: made, prepared; one left by a start that failed after it is taken again. */
  async function cloneFor(part: string): Promise<void> {
    const dir = godPartDir(home, part);
    if (existsSync(dir)) {
      if (!existsSync(join(dir, '.git', GOD_MARKER))) throw new GodError('conflict', `la cartella ${GOD_CONTAINER}/${part} c'è già e non è un clone di GOD`);
      const refusal = godCloneRefusal(dir);
      if (refusal !== undefined) throw new GodError('conflict', refusal);
      return;
    }
    await createSubtaskClone(home, data, part, git);
    await env.prepareClone?.(dir).catch((error: unknown) => env.onError?.(error));
  }

  async function start(row: SubtaskRow, plan: PlanRow, total: number): Promise<void> {
    const coder = env.policy(CODER_AGENT);
    if (coder === undefined) {
      if (row.reason === null) await sql`UPDATE god_subtasks SET reason = 'aspetta: il Coder non può lavorare ora (Claude e Codex spenti)', updated_at = now() WHERE id = ${row.id}`;
      return;
    }
    try {
      await cloneFor(row.part);
    } catch (error) {
      await setState(sql, row.id, 'attention', { reason: reason(`il clone non si è creato: ${error instanceof Error ? error.message : String(error)}`) });
      return;
    }
    if (!env.parts().includes(godWorkspace(row.part))) {
      await setState(sql, row.id, 'attention', { reason: `il progetto arianna non è registrato su ${GOD_CONTAINER}: il Coder non può aprire il clone` });
      return;
    }
    const conversationId = await openChat(CODER_AGENT, coder, row.part, plan.model, subtaskBrief(plan, row, total));
    await setState(sql, row.id, 'working', { conversationId });
  }

  async function startReview(row: SubtaskRow): Promise<void> {
    const reviewer = env.policy(REVIEWER_AGENT);
    if (reviewer === undefined) {
      await setState(sql, row.id, 'reviewed', { review: 'unknown', reason: 'nessun revisore può lavorare ora: rivedi tu le modifiche' });
      return;
    }
    if (row.reviewConversationId !== null) {
      try {
        await sql.begin((tx) => writeUserMessage(tx, row.reviewConversationId ?? '', reviewBrief(row, true)));
      } catch (error) {
        if (error instanceof ChatError && error.code === 'busy') return;
        throw error;
      }
      await setState(sql, row.id, 'reviewing', { review: null });
      return;
    }
    const reviewConversationId = await openChat(REVIEWER_AGENT, reviewer, row.part, null, reviewBrief(row, false));
    await setState(sql, row.id, 'reviewing', { review: null, reviewConversationId });
  }

  /** Moves the subtasks on from what their chats say, then starts the queued ones the quota allows. */
  async function step(): Promise<void> {
    const open = await loadSubtasks(`s.state IN ('queued', 'working', 'reviewing', 'reviewed', 'attention')`, []);
    for (const row of open) {
      if (row.conversationId === null) continue;
      const coder = await latestTask(sql, row.conversationId);
      const work = outcomeOf(coder);
      const review = row.reviewConversationId === null ? undefined : await latestTask(sql, row.reviewConversationId);
      // The user wrote to the Coder after the latest review: the work is on again.
      const newer = coder !== undefined && (review === undefined || coder.createdAt > review.createdAt);
      if (row.state === 'working' || row.state === 'attention' || ((row.state === 'reviewing' || row.state === 'reviewed') && newer)) {
        if (work === 'busy') {
          if (row.state !== 'working') await setState(sql, row.id, 'working');
        } else if (work === 'answered') {
          await startReview(row);
        } else if (row.state !== 'attention') {
          await setState(sql, row.id, 'attention', { reason: 'il Coder non ha finito: guarda la sua chat e scrivigli, oppure Prepara il ramo con quello che c\'è' });
        }
        continue;
      }
      if (row.state === 'reviewing' && row.reviewConversationId !== null) {
        const outcome = outcomeOf(review);
        if (outcome === 'answered') await setState(sql, row.id, 'reviewed', { review: verdictOf(await latestAnswer(sql, row.reviewConversationId)) });
        else if (outcome === 'stuck') await setState(sql, row.id, 'reviewed', { review: 'unknown', reason: 'la revisione non è finita: guarda la chat del Reviewer' });
      }
    }

    const queued = open.filter((row) => row.state === 'queued');
    if (queued.length === 0) return;
    const [active] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM god_subtasks WHERE state IN ('working', 'reviewing')`;
    let room = concurrencyFor(projection(await quotaReadings(sql, now()), now())) - (active?.count ?? 0);
    for (const row of queued) {
      if (room <= 0) break;
      const plan = await loadPlan(row.planId);
      if (plan === undefined) continue;
      const siblings = await loadSubtasks('s.plan_id = $1', [row.planId]);
      const waits = await waitingFor(row, siblings);
      if (waits !== undefined) {
        if (waits.discarded) await setState(sql, row.id, 'attention', { reason: waits.text });
        else if (row.reason !== waits.text) await sql`UPDATE god_subtasks SET reason = ${waits.text}, updated_at = now() WHERE id = ${row.id}`;
        continue;
      }
      await start(row, plan, siblings.length);
      room -= 1;
    }
  }

  /** What a queued subtask still waits for: each subtask it is blocked by, prepared as a branch and merged into main. */
  async function waitingFor(row: SubtaskRow, siblings: readonly SubtaskRow[]): Promise<{ text: string; discarded: boolean } | undefined> {
    for (const position of row.blockedBy) {
      const before = siblings.find((item) => item.position === position);
      if (before === undefined) continue;
      if (before.state === 'discarded') return { text: `dipende da «${before.title}», che è stato scartato`, discarded: true };
      if (before.state !== 'branch' || before.commitSha === null) return { text: `aspetta «${before.title}»`, discarded: false };
      if (!(await isMerged(before.commitSha))) return { text: `aspetta che «${before.title}» sia unito in main`, discarded: false };
    }
    return undefined;
  }

  function tick(): Promise<void> {
    return serial(step);
  }

  async function subtask(id: string): Promise<SubtaskRow> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new GodError('not-found', 'not found');
    const [row] = await loadSubtasks('s.id = $1::uuid', [id]);
    if (row === undefined) throw new GodError('not-found', 'not found');
    return row;
  }

  async function stopChats(row: SubtaskRow): Promise<void> {
    for (const conversationId of [row.conversationId, row.reviewConversationId]) {
      if (conversationId === null) continue;
      for (const taskId of await activeTasks(sql, conversationId)) env.stopTask(taskId);
    }
  }

  /** "Ferma": the steps at work stop, and nothing new starts for it until "Riprendi". */
  function stop(id: string): Promise<SubtaskView> {
    return serial(async () => {
      const row = await subtask(id);
      if (!['queued', 'working', 'reviewing', 'reviewed', 'attention'].includes(row.state)) throw new GodError('conflict', 'questo sottocompito non è al lavoro');
      await stopChats(row);
      await setState(sql, row.id, 'stopped', { reason: 'fermato da te' });
      return view(await subtask(id));
    });
  }

  /** "Riprendi": a subtask never started goes back in the queue; one started tells its Coder to go on. */
  function resume(id: string): Promise<SubtaskView> {
    return serial(async () => {
      const row = await subtask(id);
      if (row.state !== 'stopped') throw new GodError('conflict', 'solo un sottocompito fermato riprende');
      if (row.conversationId === null) {
        await setState(sql, row.id, 'queued');
      } else {
        try {
          await sql.begin((tx) => writeUserMessage(tx, row.conversationId ?? '', 'Riprendi il sottocompito da dove ti eri fermato: guarda le modifiche non committate e finisci il lavoro.'));
        } catch (error) {
          if (error instanceof ChatError && error.code === 'busy') throw new GodError('conflict', 'il Coder sta ancora lavorando: aspetta che si fermi');
          throw error;
        }
        await setState(sql, row.id, 'working');
      }
      return view(await subtask(id));
    });
  }

  /** "Scarta": the work stops and its clone is deleted (the branch was never merged, or the user does not want it). */
  function discard(id: string): Promise<SubtaskView> {
    return serial(async () => {
      const row = await subtask(id);
      if (row.state === 'discarded') throw new GodError('conflict', 'già scartato');
      await stopChats(row);
      const dir = godPartDir(home, row.part);
      // Only a clone of GOD: the mark in its git folder says so.
      if (existsSync(join(dir, '.git', GOD_MARKER))) rmSync(dir, { recursive: true, force: true });
      await setState(sql, row.id, 'discarded', { reason: 'scartato da te' });
      return view(await subtask(id));
    });
  }

  /**
   * "Prepara il ramo": the core commits what the Coder left in the clone on
   * the subtask's branch, at the user's click (the agents never commit,
   * D-174), with git and no hooks; then the page shows how to merge it.
   */
  function prepareBranch(id: string): Promise<SubtaskView> {
    return serial(async () => {
      const row = await subtask(id);
      if (!['reviewed', 'attention', 'stopped'].includes(row.state)) throw new GodError('conflict', 'il ramo si prepara dopo la revisione, o con il lavoro fermo');
      for (const conversationId of [row.conversationId, row.reviewConversationId]) {
        if (conversationId !== null && outcomeOf(await latestTask(sql, conversationId)) === 'busy') throw new GodError('conflict', 'un agente sta ancora lavorando su questo sottocompito');
      }
      const dir = godPartDir(home, row.part);
      const refusal = godCloneRefusal(dir);
      if (refusal !== undefined) throw new GodError('conflict', refusal);
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
      if (branch !== subtaskBranch(row.part)) throw new GodError('conflict', `il clone è sul ramo ${branch}, non su ${subtaskBranch(row.part)}`);
      if ((await git(['status', '--porcelain', '--untracked-files=all'], dir)).trim() !== '') {
        await git(['add', '--all'], dir);
        await git([...COMMIT_IDENTITY, 'commit', '--quiet', '--no-verify', '-m', `${row.title} (GOD ${row.part})`], dir);
      }
      const head = (await git(['rev-parse', 'HEAD'], dir)).trim();
      const base = (await git(['rev-parse', `origin/${GOD_MAIN}`], dir)).trim();
      if (head === base) throw new GodError('conflict', 'nel clone non c\'è nessuna modifica da preparare');
      await setState(sql, row.id, 'branch', { commitSha: head, reason: null });
      return view(await subtask(id));
    });
  }

  return { messagePlan, approve, plans, tick, stop, resume, discard, prepareBranch };
}

export type GodWork = ReturnType<typeof createGodWork>;
