/**
 * The switch «Personaggio» of a conversation (D-225, tappa A): on (the
 * default) the agents speak with the person of the series they wear and its
 * lines, in every chat, work too; off, without them in this conversation
 * only. Name and look stay. Pure: the chat shows it, the core saves it.
 */
import type { CharacterChoice, Conversation } from './types.ts';

/** The pack of the people of the series (SERIES_PACK_ID of @arianna/agents). */
export const SERIES_PACK = 'serie';

export interface CharacterSwitch {
  /** Shown only where a character could speak: an agent wears a person of the series, and Arianna or an agent answers. */
  shown: boolean;
  on: boolean;
  text: string;
  title: string;
}

export const CHARACTER_ON_TITLE = 'Gli agenti parlano col loro personaggio e le sue battute, anche mentre lavorano. Clic per spegnerlo in questa conversazione.';
export const CHARACTER_OFF_TITLE = 'Gli agenti rispondono senza personaggio né battute in questa conversazione; nome e aspetto restano. Clic per riaccenderlo.';

/**
 * What the chat shows of the switch of `conversation`. A core without the
 * field says nothing: on. Not in the trial of a model (D-142) nor in the
 * plain chat with Claude or ChatGPT (D-111, tappa B; D-212), where no agent
 * of Arianna answers.
 */
export function characterSwitch(conversation: Pick<Conversation, 'character' | 'trialModel' | 'agent' | 'workspace'>, characters: Readonly<Record<string, CharacterChoice>> | undefined): CharacterSwitch {
  const on = conversation.character !== false;
  const plain = (conversation.agent === 'claude' || conversation.agent === 'codex') && conversation.workspace === null;
  const trial = conversation.trialModel !== undefined && conversation.trialModel !== null;
  // Any agent, not only the one that answers here: the switch covers the agents this chat delegates to as well.
  const worn = Object.values(characters ?? {}).some((choice) => choice.pack === SERIES_PACK);
  return {
    shown: worn && !plain && !trial,
    on,
    text: on ? 'Personaggio acceso' : 'Personaggio spento',
    title: on ? CHARACTER_ON_TITLE : CHARACTER_OFF_TITLE,
  };
}
