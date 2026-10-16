import { shallowRef } from 'vue';

import type { CharacterChoice, ChatCharacter, Conversation } from './types.ts';

/**
 * The chat with a person of the series on Claude (D-225, tappa B): chosen in
 * «Nuova conversazione» as an agent, it is the plain chat with Claude played
 * by that character. Pure helpers and the list the core serves; the names
 * come from the core, nothing of the series is written here.
 */

/** The pack of the people of the series (SERIES_PACK_ID of @arianna/agents). */
const SERIES_PACK = 'serie';
/** The agent of the plain chat with Claude: the conversation of a character is one. */
export const CHARACTER_CHAT_AGENT = 'claude';

/** The people of the series the core lists now, set by the store at each read of /api/direct-agents. */
export const chatCast = shallowRef<ChatCharacter[]>([]);

export function rememberChatCast(list: readonly ChatCharacter[]): void {
  chatCast.value = [...list];
}

/** The people of the series grouped by series, in the order the core gives them. */
export function castByShow(list: readonly ChatCharacter[]): { show: string; characters: ChatCharacter[] }[] {
  const groups: { show: string; characters: ChatCharacter[] }[] = [];
  for (const character of list) {
    const group = groups.find((entry) => entry.show === character.show);
    if (group === undefined) groups.push({ show: character.show, characters: [character] });
    else group.characters.push(character);
  }
  return groups;
}

/** What the chat shows of a character: its name and its avatar; the id alone when the core no longer lists it. */
export interface CastLook {
  name: string;
  show: string;
  choice: CharacterChoice;
}

export function castLook(id: string, list: readonly ChatCharacter[] = chatCast.value): CastLook {
  const found = list.find((entry) => entry.id === id);
  // A sheet of the series has four rows (D-211); the core says it when it lists the character.
  return { name: found?.name ?? id, show: found?.show ?? '', choice: { pack: SERIES_PACK, character: id, rows: found?.rows ?? 4 } };
}

/** The character of a conversation, or null: only in the plain chat with Claude (the core refuses it elsewhere). */
export function conversationCharacter(conversation: Pick<Conversation, 'seriesCharacter' | 'agent' | 'workspace'>): string | null {
  const id = conversation.seriesCharacter ?? null;
  return id !== null && conversation.agent === CHARACTER_CHAT_AGENT && conversation.workspace === null ? id : null;
}

/** The notice before the first message: where the messages go, and what stops them. */
export function characterNotice(name: string): string {
  return `Ogni messaggio va a Claude (Anthropic), che gioca ${name}: una conversazione di lavoro, senza dati personali. Se ne scrivi uno il gateway la ferma; le chiacchierate private restano sul Mac.`;
}

/** Why the characters are off: the plain chat with Claude is (Claude off in Impostazioni, or it does not run here). */
export const CHARACTERS_OFF = 'Claude è spento in Impostazioni oppure non gira su questo Mac: li gioca Claude.';
