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
  await systemLine(tx, entry.conversationId, entry.taskId, maxLabel(entry.reasonLabel, entry.nameLabel), addingLine(entry.agent, entry.reason));
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
 * Whether `delegationId` brought its agent into the conversation and the
 * agent is still there: its run then carries ENTRY_TEXT. False from the
 * second delegation on, and after the user took the agent out.
 */
export async function isEntryDelegation(sql: Queryable, delegationId: string): Promise<boolean> {
  const [row] = await sql<{ found: boolean }[]>`
    SELECT EXISTS (SELECT FROM conversation_participants WHERE delegation_id = ${delegationId}::bigint AND removed_at IS NULL) AS found`;
  return row?.found === true;
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
