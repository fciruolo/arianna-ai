import { SERIES_PACK_ID, SERIES_PERSONAS, seriesShowNames } from '@arianna/agents';

/**
 * The chat with a person of the series on Claude (D-225, tappa B): the user
 * chooses a character in «Nuova conversazione», as an agent, and Claude
 * (Sonnet unless the user chooses Opus) plays it. It is the plain chat with
 * Claude (D-111, tappa B: a work conversation, L1, without a project, no tool,
 * the session resumed) with `conversations.series_character` set. A private
 * conversation never has it: the chats with the agents in costume there stay
 * on the local model. Every message passes the gateway: a personal datum stops
 * it there, as in any plain chat.
 *
 * What Claude reads: CHARACTER_CHAT_PROMPT (ours, L0), the block of the
 * character as prompt-tail builds it (`chatCharacterPart`: the repository's
 * text L0, or the user's rewrite L1 with source `#own`), the exchanges, and
 * after each message of the user the real lines drawn by the core
 * (`chatLinesPart`, `#lines`, L1), also when the session is resumed.
 */

/** What Claude reads first in a chat with a person of the series: ours, L0, without the name of any character. */
export const CHARACTER_CHAT_PROMPT = [
  "You play a character of a TV series in a role-play chat with the user, inside Arianna, a personal assistant that runs on the user's own computer. The user chose to chat with the character: the block below says who you are.",
  '- Stay in character from the first word to the last; never step out of it to speak as an AI or as Claude, unless the user asks you to stop the game.',
  '- Answer in Italian, in chat style: short, lively turns in the voice of the character, gestures and scene in square brackets. Now and then another person of the same series may step in with one line, as in the series.',
  '- You have no tools, no files and no internet: never offer to run, read or look up anything.',
  '- This chat goes to the cloud: never ask for personal data, passwords or other credentials. If the user brings up something private, suggest, in character, a private conversation with the local model.',
].join('\n');

/** The source of the prompt in gateway_log. */
export const CHARACTER_CHAT_PROMPT_SOURCE = 'prompt:character-chat';

/** A person of the series the user may chat with, as «Nuova conversazione» shows it: names of ours (L0). */
export interface ChatCharacter {
  id: string;
  name: string;
  show: string;
  /** The rows of its sheet, for the avatar. */
  rows: 3 | 4;
}

/**
 * The people of the series the user may chat with now: every one of
 * SERIES_PERSONAS that the pack `serie` serves (`rowsOf`, the rows of its sheet or undefined, read at each call,
 * as the chat reads the packs), in the order of the personas, so the people of
 * one series stay together.
 */
export function chatCharacters(rowsOf: (pack: string, character: string) => 3 | 4 | undefined): ChatCharacter[] {
  return Object.entries(SERIES_PERSONAS).flatMap(([id, person]) => {
    const rows = rowsOf(SERIES_PACK_ID, id);
    return rows === undefined ? [] : [{ id, name: person.name, show: person.show, rows }];
  });
}

/**
 * The names that are no person in a brief of the chat with `character`
 * (D-225, tappa B): every name of its series, with its forms, whole only, in
 * that brief only (the gateway's `names`); never the names of another series.
 */
export function characterChatNames(character: string): string[] {
  return seriesShowNames(character);
}
