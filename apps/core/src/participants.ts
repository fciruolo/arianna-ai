import type { LoadedAgent } from '@arianna/agents';
import { maxLabel, type Label } from '@arianna/policy';

import { ChatError, isUuid } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * The agents that joined a conversation as colleagues (D-125, D-107 B1):
 * Arianna brings one in with her first delegation to it there, the user takes
 * it out with a click, and it comes back with the next delegation. The chat
 * shows each change as system lines with the task (`messages.role =
 * 'system'`, `task_id` set): lines for the user only, which neither the model
 * nor the summaries read (conversationView). Arianna learns who is there from
 * a context message of her turn (`participantsNote`), never from her system
 * prompt, so that its cached prefix stays the same (D-075).
 */
export interface Participant {
  agent: string;
  addedBy: 'arianna' | 'user';
  /** ISO time. */
  addedAt: string;
}

/** What the participant bar shows of an agent: where it runs. */
export interface ParticipantView extends Participant {
  /** 'claude' or 'local'; null for an agent no longer active. */
  executor: string | null;
}

/**
 * The label of an agent's name in a line of the chat: an agent of agents/ is
 * in git (L0); one the user wrote is L1 by declaration (D-119), like its
 * description. An agent gone meanwhile counts as the user's.
 */
export function nameLabelOf(agent: LoadedAgent | undefined): Label {
  return agent === undefined || agent.origin === 'user' ? 'L1' : 'L0';
}

/** The name the user reads in the lines: the Coder with its capital, any other agent by its id. */
export function participantName(agent: string): string {
  return agent === 'coder' ? 'Coder' : agent;
}

/** The lines of the chat, in Italian (D-045). */
export function addingLine(agent: string, reason: string | undefined): string {
  return reason === undefined || reason.trim() === '' ? `Arianna aggiunge ${participantName(agent)}` : `Arianna aggiunge ${participantName(agent)}: ${reason.trim()}`;
}

export function addedLine(agent: string): string {
  return `${participantName(agent)} è stato aggiunto`;
}

export function removedLine(agent: string): string {
  return `Hai tolto ${participantName(agent)}`;
}

/**
 * What an agent reads with the first brief in a conversation it just joined
 * (D-125): fixed and ours (L0), in English like the prompts. Its answer opens
 * with the greeting; from the second delegation on it is not there.
 */
export const ENTRY_TEXT = [
  'You are joining a conversation where the user and Arianna are working together: you know them both already, they are your colleagues in the same office.',
  'Open your answer with one line only that greets them, in your own tone (a joke, if your tone is playful); then do the work below.',
].join(' ');

/** The participants active now, in the order they joined. */
export async function activeParticipants(sql: Queryable, conversationId: string): Promise<Participant[]> {
  const rows = await sql<Participant[]>`
    SELECT agent, added_by AS "addedBy", to_char(added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "addedAt"
    FROM conversation_participants
    WHERE conversation_id = ${conversationId} AND removed_at IS NULL
    ORDER BY added_at, id`;
  return [...rows];
}

/**
 * The participants of a conversation when `since` began (a task's start): the
 * list Arianna reads in that task stays the same for all its steps, so that
 * the prefix of its prompt does too.
 */
export async function participantsAt(sql: Queryable, conversationId: string, since: Date | string): Promise<string[]> {
  const at = since instanceof Date ? since.toISOString() : since;
  const rows = await sql<{ agent: string }[]>`
    SELECT agent FROM conversation_participants
    WHERE conversation_id = ${conversationId} AND added_at <= ${at}::timestamptz
      AND (removed_at IS NULL OR removed_at > ${at}::timestamptz)
    ORDER BY added_at, id`;
  return rows.map((row) => row.agent);
}

/** The context message of Arianna's turn: who is in the conversation besides her and the user. */
export function participantsNote(agents: readonly string[]): string | undefined {
  return agents.length === 0 ? undefined : `In this conversation: ${agents.join(', ')}.`;
}

export interface Entry {
  conversationId: string;
  taskId: string;
  delegationId: string;
  agent: string;
  /** Why Arianna brings the agent in, as the gateway let it reach the chat; undefined when it did not. */
  reason: string | undefined;
  /** What the step that wrote the reason had read: the label of the reason's line. */
  reasonLabel: Label;
  /** The label of the agent's name (nameLabelOf). */
  nameLabel: Label;
}

async function systemLine(tx: Queryable, conversationId: string, taskId: string, label: Label, body: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, channel, label, body, task_id)
    VALUES (${conversationId}, 'system', 'web', ${label}::privacy_label, ${body}, ${taskId})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO messages returned no row');
  await appendEvent(tx, { kind: 'message.created', taskId, label: 'L0', payload: { conversationId, messageId: row.id, role: 'system' } });
  return row.id;
}

/**
 * A delegation to an agent not yet in the conversation brings it in: the
 * row, the event `participant.added` (L1, ids only) and the two lines of the
 * chat. Run it in the transaction that writes the delegation. An agent
 * already there (another task brought it in first) adds nothing. True when
 * the agent joined now.
 */
export async function enterOnDelegation(tx: Queryable, entry: Entry): Promise<boolean> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO conversation_participants (conversation_id, agent, added_by, task_id, delegation_id)
    VALUES (${entry.conversationId}, ${entry.agent}, 'arianna', ${entry.taskId}, ${entry.delegationId}::bigint)
    ON CONFLICT (conversation_id, agent) WHERE removed_at IS NULL DO NOTHING
    RETURNING id::text`;
  if (row === undefined) return false;
  await appendEvent(tx, {
    kind: 'participant.added',
    taskId: entry.taskId,
    label: 'L1',
    payload: { conversationId: entry.conversationId, agent: entry.agent, participantId: row.id, delegationId: entry.delegationId },
  });
  // Without the reason the line holds only the name: the name's label.
  const label = entry.reason === undefined ? entry.nameLabel : maxLabel(entry.reasonLabel, entry.nameLabel);
  await systemLine(tx, entry.conversationId, entry.taskId, label, addingLine(entry.agent, entry.reason));
  await systemLine(tx, entry.conversationId, entry.taskId, entry.nameLabel, addedLine(entry.agent));
  return true;
}

/** Whether an agent of the conversation is active now. */
export async function isParticipant(sql: Queryable, conversationId: string, agent: string): Promise<boolean> {
  const [row] = await sql<{ found: boolean }[]>`
    SELECT EXISTS (SELECT FROM conversation_participants WHERE conversation_id = ${conversationId} AND agent = ${agent} AND removed_at IS NULL) AS found`;
  return row?.found === true;
}

/**
 * Whether the run of `delegationId` is the agent's first work since it
 * joined the conversation (it is an active participant, and no other
 * delegation to it there has reached a run since it joined): the run then
 * carries ENTRY_TEXT. A delegation that never ran (a declassification
 * refused, a missing project) leaves the greeting to the next one that does.
 * False after the user took the agent out, until it joins again.
 */
export async function isEntryDelegation(sql: Queryable, delegationId: string): Promise<boolean> {
  const [row] = await sql<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT FROM task_delegations d
      JOIN tasks t ON t.id = d.task_id
      JOIN conversation_participants p ON p.conversation_id = t.conversation_id AND p.agent = d.agent AND p.removed_at IS NULL
      WHERE d.id = ${delegationId}::bigint
        AND d.id >= coalesce(p.delegation_id, 0)
        AND NOT EXISTS (
          SELECT FROM task_delegations o JOIN tasks ot ON ot.id = o.task_id
          WHERE ot.conversation_id = t.conversation_id AND o.agent = d.agent AND o.id <> d.id
            AND o.id >= coalesce(p.delegation_id, 0) AND o.created_at >= p.added_at AND o.run_id IS NOT NULL
        )
    ) AS found`;
  return row?.found === true;
}

/**
 * The goodbyes of an agent that leaves by itself (I-8, D-130): fixed, ours
 * (L0), one at random, no model. Written after its name as a line of the chat.
 */
export const FAREWELLS: readonly string[] = [
  'ragazzi io vado, non servo più',
  'vi lascio lavorare, chiamatemi se serve',
  'io qui ho finito: alla prossima',
  'tolgo il disturbo, buon lavoro',
  'vado a riposare i circuiti, a presto',
  'esco in punta di piedi',
  'mi faccio da parte: se torno utile, Arianna sa dove trovarmi',
  'per oggi basta così, ciao a tutti',
  'non vi servo più: vi saluto',
  'lascio la sedia libera, a presto',
  'io mi ritiro, è stato un piacere',
  'vado, ma resto a un messaggio di distanza',
  'chiudo il mio quaderno e vi saluto',
  'missione compiuta, passo e chiudo',
  'me ne vado prima di diventare un soprammobile',
  'vi lascio in buone mani',
  'esco dalla chat, non dalla squadra',
  'stacco qui: chiamatemi alla prossima',
  'faccio spazio agli altri, ciao',
  'saluto e torno nel mio angolo dell\'ufficio',
];

export function farewellLine(agent: string, random: () => number = Math.random): string {
  const index = Math.min(FAREWELLS.length - 1, Math.max(0, Math.floor(random() * FAREWELLS.length)));
  return `${participantName(agent)}: ${FAREWELLS[index] ?? ''}`;
}

/** When an idle agent leaves (I-8): after this many messages of the user, 0 never; the label of each agent's name. */
export interface LeaveRule {
  after: number;
  nameLabel: (agent: string) => Label;
  random?: () => number;
}

/** The agent that never leaves by itself: it stays until the user takes it out (the user's choice for I-8). */
export const STAYS = 'coder';

/**
 * After a message of the user (I-8, D-130): every agent in the conversation,
 * except the Coder, that has had `after` messages of the user since it came
 * in or since its last delegation here leaves, with a goodbye line on the
 * task of that message and the event `participant.removed` (reason `idle`).
 * Run it in the transaction that writes the message. It comes back at the
 * next delegation, with the lines of D-125. The agents that left.
 */
export async function leaveIdle(tx: Queryable, conversationId: string, taskId: string, rule: LeaveRule): Promise<string[]> {
  if (rule.after <= 0) return [];
  const idle = await tx<{ id: string; agent: string; taskId: string | null }[]>`
    SELECT p.id::text, p.agent, p.task_id::text AS "taskId" FROM conversation_participants p
    WHERE p.conversation_id = ${conversationId} AND p.removed_at IS NULL AND p.agent <> ${STAYS}
      AND (
        SELECT count(*) FROM messages m
        WHERE m.conversation_id = p.conversation_id AND m.role = 'user'
          AND m.ts > greatest(p.added_at, coalesce((
            SELECT max(d.created_at) FROM task_delegations d JOIN tasks t ON t.id = d.task_id
            WHERE t.conversation_id = p.conversation_id AND d.agent = p.agent), p.added_at))
      ) >= ${rule.after}
      -- Never while a delegation of its own is still waiting or at work here: its report would land after its goodbye.
      AND NOT EXISTS (
        SELECT FROM task_delegations d JOIN tasks t ON t.id = d.task_id
        WHERE t.conversation_id = p.conversation_id AND d.agent = p.agent AND d.status IN ('pending', 'running'))
    ORDER BY p.added_at, p.id
    FOR UPDATE OF p`;
  for (const row of idle) {
    await tx`UPDATE conversation_participants SET removed_at = now() WHERE id = ${row.id}`;
    await appendEvent(tx, {
      kind: 'participant.removed',
      taskId,
      label: 'L1',
      payload: { conversationId, agent: row.agent, participantId: row.id, reason: 'idle' },
    });
    await systemLine(tx, conversationId, taskId, rule.nameLabel(row.agent), farewellLine(row.agent, rule.random));
  }
  return idle.map((row) => row.agent);
}

/**
 * The user takes an agent out of the conversation: the row ends, the event
 * `participant.removed` (L1, ids only) and the line "Hai tolto …", with the
 * task that brought the agent in (a line for the user only). Refused for a
 * conversation that does not exist or was deleted, and for an agent not there.
 */
export async function removeParticipant(sql: Sql, conversationId: string, agent: string, nameLabel: Label): Promise<void> {
  if (!isUuid(conversationId)) throw new ChatError('not-found', 'conversation not found');
  await sql.begin(async (tx) => {
    const [conversation] = await tx<{ purged: boolean }[]>`
      SELECT purged_at IS NOT NULL AS purged FROM conversations WHERE id = ${conversationId} FOR UPDATE`;
    if (conversation === undefined || conversation.purged) throw new ChatError('not-found', 'conversation not found');
    const [row] = await tx<{ id: string; taskId: string | null }[]>`
      UPDATE conversation_participants SET removed_at = now()
      WHERE conversation_id = ${conversationId} AND agent = ${agent} AND removed_at IS NULL
      RETURNING id::text, task_id::text AS "taskId"`;
    if (row === undefined) throw new ChatError('not-found', `${agent} is not in this conversation`);
    await appendEvent(tx, {
      kind: 'participant.removed',
      ...(row.taskId === null ? {} : { taskId: row.taskId }),
      label: 'L1',
      payload: { conversationId, agent, participantId: row.id },
    });
    // A participant the user added has no task: no line the model would read as the user's.
    if (row.taskId !== null) await systemLine(tx, conversationId, row.taskId, nameLabel, removedLine(agent));
  });
}
