import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import { CardError } from './cardwall.ts';
import { dayText, parseDay } from './commitment-dates.ts';
import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { cardsChanged, insertMilestone, MAX_MILESTONE_TITLE, MAX_OPEN_MILESTONES } from './milestones.ts';

/**
 * «/progetta la milestone Accessi che deve fare login, registrazione e
 * recupero password» (D-313, seguito 3, richiesta dell'utente del
 * 2026-10-24): the plan of «/progetta» (D-235) goes in a milestone. The code
 * reads the milestone's name, and the due day after «entro», from the user's
 * words when the card «Piano» writes its plan, never from the planner's
 * answer; the plan's approval holds them, so the chat shows the milestone
 * before the decision. With the approval the milestone is written (Privato,
 * as every milestone) and the plan's cards go in it; an open milestone of the
 * project with the same name (any case) gets them instead of a second one.
 * «Non ora» creates nothing. Only in a work conversation with a project: a
 * plan elsewhere names no milestone. A project already full of open
 * milestones keeps the cards out of any, and the answer says so. A due day
 * past by the decision stays as the user said it: the wall shows it late.
 */

export interface PlanMilestone {
  title: string;
  /** YYYY-MM-DD, computed by the code from the user's words. */
  due: string | null;
}

/** «la milestone Accessi che…», «una milestone «Area clienti»: …», «milestone chiamata Accessi, …». */
const NAMED =
  /^\s*(?:(?:la|una)\s+)?(?:nuova\s+)?milestone\s+(?:(?:chiamata|di nome|dal nome)\s+)?(?:«([^»\n]+)»|"([^"\n]+)"|([^«"\s][^\n]*?)(?=\s*[:,;\n]|\.(?:\s|$)|\s+(?:che|con|per|dove|in cui|entro|da finire|scade|scadenza|su|sul|sulla|nel|nella)\b|\s*$))/i;
/** A name without quotes is a few words, never a sentence («la milestone attuale è troppo grande»). */
const NAME_WORDS = 4;
const NOT_A_NAME = /(?:^|\s)(?:è|e'|sono|va|vanno|deve|devono|non|ha|hanno|era|fa|fanno|serve|servono|di|del|della|dei|delle)(?=\s|$)/i;
/** The words after «entro», «scadenza», «scade», «per il» up to a stop: the due day is the longest start of them the code reads. */
const DUE = /\b(?:entro|scadenza|scade il|scade|per il)\s+([^,.;:\n]+)/gi;
const DUE_WORDS = 4;

/** The milestone a «/progetta» names in its first words, or undefined when it names none. */
export function milestoneOfBrief(brief: string, today: string): PlanMilestone | undefined {
  const named = NAMED.exec(brief);
  if (named === null) return undefined;
  const title = (named[1] ?? named[2] ?? named[3] ?? '').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (title === '' || Array.from(title).length > MAX_MILESTONE_TITLE || /[\u0000-\u001f\u007f]/.test(title)) return undefined;
  if (named[3] !== undefined && (title.split(' ').length > NAME_WORDS || NOT_A_NAME.test(title))) return undefined;
  return { title, due: dueOfBrief(brief.slice(named.index + named[0].length), today) };
}

function dueOfBrief(text: string, today: string): string | null {
  // Each «entro …», «per il …» in turn: «per il cliente Rossi, entro fine novembre» has its day in the second.
  for (const found of text.matchAll(DUE)) {
    // «entro venerdì e deve fare…»: the day ends where another clause begins.
    const words = (found[1] ?? '').split(/\s+(?:che|con|e|dove|in cui)\s+/i)[0]?.trim().split(/\s+/) ?? [];
    for (let count = Math.min(words.length, DUE_WORDS); count > 0; count -= 1) {
      const parsed = parseDay(words.slice(0, count).join(' '), today);
      if (parsed !== undefined) return parsed.day;
    }
  }
  return null;
}

/** A milestone is at most Privato and stored Privato (D-313), as in milestone-proposals.ts. */
const MILESTONE_LABEL: Label = 'L2';

/** Why an approved plan's cards are in no milestone: none of these when they are. */
export type PlanMilestoneMiss = 'no-project' | 'secret' | 'full';

/**
 * The approved plan's cards in its milestone, in the transaction of the
 * decision: the open one of the project with the same name (kept open while
 * the cards go in), or a new one. Nothing without a project or cards, above
 * Privato, or in a full project: the reason is returned.
 */
export async function attachPlanMilestone(
  tx: Queryable,
  input: { approvalId: string; label: Label; project: string | undefined; milestone: PlanMilestone; cards: readonly string[] },
): Promise<PlanMilestoneMiss | undefined> {
  const { project, milestone } = input;
  if (project === undefined || input.cards.length === 0) return 'no-project';
  const label = maxLabel(MILESTONE_LABEL, input.label);
  if (!isAtMost(label, MILESTONE_LABEL)) return 'secret';
  // The lock of insertMilestone, taken first: the check below and the insert see the same milestones.
  await tx`SELECT pg_advisory_xact_lock(hashtext('milestones:' || ${project}))`;
  // FOR SHARE: a «Chiudi» confirmed meanwhile (FOR UPDATE) waits, so the cards never go in a closed milestone.
  const [same] = await tx<{ id: string }[]>`
    SELECT id::text FROM milestones WHERE project = ${project} AND status = 'open' AND lower(title) = lower(${milestone.title}) ORDER BY position LIMIT 1 FOR SHARE`;
  let id = same?.id;
  if (id === undefined) {
    try {
      id = (await insertMilestone(tx, { project, title: milestone.title, description: null, due: milestone.due, label, approvalId: input.approvalId })).id;
    } catch (error) {
      if (error instanceof CardError && error.code === 'conflict') return 'full';
      throw error;
    }
  }
  await tx`UPDATE tasks SET milestone_id = ${id}::uuid WHERE id = ANY(${[...input.cards]}::uuid[])`;
  // Cards more, as on the wall: a «No» to its closing no longer holds.
  await cardsChanged(tx, [id]);
  await appendEvent(tx, { kind: 'card.changed', label: 'L0', payload: { milestoneId: id, plan: input.approvalId } });
  return undefined;
}

/** What Arianna's answer to an approved plan adds about its milestone, written by the code. */
export function planMilestoneText(named: PlanMilestone, found: { title: string; project: string; due: string | null } | undefined, miss: PlanMilestoneMiss = 'full'): string {
  if (found === undefined) {
    const why =
      miss === 'no-project'
        ? 'questa conversazione non ha un progetto'
        : miss === 'secret'
          ? 'il piano è Segreto, e una milestone è al più Privata'
          : `il progetto ha già ${String(MAX_OPEN_MILESTONES)} milestone aperte`;
    return `Non le ho messe nella milestone «${named.title}»: ${why}. Puoi spostarle dal «Cardwall».`;
  }
  const due = found.due === null ? '' : `, che scade ${dayText(found.due)}`;
  return `Sono nella milestone «${found.title}» di ${found.project}${due}.`;
}

/** The milestone an approved plan's cards went in, or undefined. */
export async function planMilestoneOf(sql: Queryable, approvalId: string): Promise<{ title: string; project: string; due: string | null } | undefined> {
  const [row] = await sql<{ title: string; project: string; due: string | null }[]>`
    SELECT m.title, m.project, to_char(m.due_on, 'YYYY-MM-DD') AS due FROM tasks t JOIN milestones m ON m.id = t.milestone_id
    WHERE t.plan_approval_id = ${approvalId}::uuid LIMIT 1`;
  return row;
}
