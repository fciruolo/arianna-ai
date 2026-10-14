import { agentTitle } from './italian.ts';

// The cards of «Su di te» in the chat (D-114, tappe C e D; D-213).
//
// profile.share: an agent asks one fact; the card shows who, why (in the
// words of who asked) and the exact text that leaves. "Dagli solo questo"
// lets that text out once, to that agent; the fact stays as it is in Settings.
//
// profile.propose: Arianna would remember a fact; the card shows topic and
// text, saved "Solo in casa" only on "Sì, ricorda".

export interface FactShare {
  /** "Il Coder chiede: città". */
  title: string;
  reason: string;
  /** The exact text that leaves. */
  text: string;
  /** What happens with "Dagli solo questo". */
  note: string;
}

export const SHARE_YES = 'Dagli solo questo';
export const SHARE_NO = 'No';

/** The card of a `profile.share` approval, or undefined when it is not a whole one. */
export function factShare(approval: { kind: string; action: string; detail: Record<string, unknown> }): FactShare | undefined {
  if (approval.kind !== 'declassify' || approval.action !== 'share_fact') return undefined;
  const { agent, topic, reason, text } = approval.detail;
  if (typeof agent !== 'string' || typeof topic !== 'string' || typeof reason !== 'string' || typeof text !== 'string') return undefined;
  const who = agentTitle(agent);
  return {
    title: `${who} chiede: ${topic}`,
    reason,
    text,
    note: `Esce solo questo testo, una volta, con il prossimo lavoro di ${who}. In «Su di te» il dato resta com’è.`,
  };
}

export interface FactProposalCard {
  topic: string;
  text: string;
  note: string;
}

export const PROPOSE_YES = 'Sì, ricorda';
export const PROPOSE_NO = 'No';

/** The card of a `profile.propose` approval (kind `fact`), or undefined when it is not a whole one. */
export function factProposal(approval: { kind: string; detail: Record<string, unknown> }): FactProposalCard | undefined {
  if (approval.kind !== 'fact') return undefined;
  const { topic, text, replaces } = approval.detail;
  if (typeof topic !== 'string' || typeof text !== 'string') return undefined;
  return {
    topic,
    text,
    note:
      replaces === true
        ? 'Sostituisce il testo che c’è ora per questo argomento, e torna «Solo in casa». Lo cambi quando vuoi in Impostazioni → Su di te.'
        : 'Lo salvo «Solo in casa»: lo leggono solo i modelli su questa macchina. Lo cambi quando vuoi in Impostazioni → Su di te.',
  };
}
