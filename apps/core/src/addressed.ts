/**
 * A message the user addresses to the agents instead of Arianna (D-107, tappa
 * B2, D-219): «@designer …» goes to that agent, «/giro …» to every agent in
 * the conversation, one after the other. The parsing is pure; the core checks the names
 * (writeUserMessage) and the orchestrator writes each delegation with every
 * rule of a delegation of Arianna's.
 */
import type { Queryable } from './db/client.ts';

export type Addressed = { kind: 'mention'; agent: string; brief: string } | { kind: 'round'; brief: string };

/** The round of «/giro» and the agents of one message (D-107: at most 6 interventions, 2 of the same agent). */
export const MAX_INTERVENTIONS = 6;
export const MAX_PER_AGENT = 2;

const MENTION = /^@([a-z][a-z0-9-]{0,40})[,:]?(?:\s+([\s\S]*))?$/;
const ROUND = /^\/giro(?:\s+([\s\S]*))?$/;

/**
 * What the message asks: a mention, a round, or nothing (a message for
 * Arianna). Only at the start of the message; the brief is the rest, trimmed,
 * and may be empty (the caller refuses it).
 */
export function parseAddressed(body: string): Addressed | undefined {
  const text = body.trim();
  const mention = MENTION.exec(text);
  if (mention?.[1] !== undefined) return { kind: 'mention', agent: mention[1], brief: (mention[2] ?? '').trim() };
  const round = ROUND.exec(text);
  if (round !== null) return { kind: 'round', brief: (round[1] ?? '').trim() };
  return undefined;
}

/** The brief of an addressed message, as the agents read it: the text without «@name» or «/giro». */
export function addressedBrief(body: string): string | undefined {
  return parseAddressed(body)?.brief;
}

/** The fixed reason of the line that brings an agent in (D-125): the user called it, not Arianna. */
export const ADDRESSED_REASON = { mention: 'lo chiedi tu', round: 'giro della conversazione' } as const;

/** A task the user addressed to the agents: how, and who answers in order. */
export interface AddressedTask {
  kind: Addressed['kind'];
  agents: string[];
}

/** The addressed task of `taskId` (migration 0067), or undefined for a task of Arianna's. */
export async function addressedTask(sql: Queryable, taskId: string): Promise<AddressedTask | undefined> {
  const [row] = await sql<{ kind: Addressed['kind'] | null; agents: string[] | null }[]>`
    SELECT addressed AS kind, addressed_agents AS agents FROM tasks WHERE id = ${taskId}`;
  return row?.kind == null || row.agents === null ? undefined : { kind: row.kind, agents: [...row.agents] };
}
