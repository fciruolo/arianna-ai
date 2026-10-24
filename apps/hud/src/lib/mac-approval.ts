// The card of a folder of the Mac (D-314, I-22, tappa M1): Arianna would read
// a folder the user has not allowed yet. The sentence and the equivalent
// command are written by the core from the arguments, never by the model;
// the command is shown in small, only to read (it is not what runs). Three
// choices with their duration, or «No».

import type { MacChoice } from './types.ts';

/** The three choices, first the narrowest: the order of the buttons. */
export const MAC_CHOICES: readonly MacChoice[] = ['once', 'conversation', 'always'];

export const MAC_CHOICE_TEXT: Record<MacChoice, string> = {
  once: 'Solo questa volta',
  conversation: 'Per tutta questa conversazione',
  always: 'Sempre',
};

export const MAC_NO = 'No';

export const MAC_NOTE =
  'Arianna legge soltanto: non cambia, non sposta e non cancella nulla. Quello che legge resta su questo Mac e lo vede solo il modello locale. «Sempre» aggiunge la cartella in Impostazioni → Cartelle del Mac, dove puoi toglierla quando vuoi.';

export interface MacReadCard {
  /** «Arianna vuole vedere i file della cartella Scrivania.» */
  sentence: string;
  /** `ls ~/Desktop`, shown in small. */
  command: string;
  /** How the permission names the folder: «Scrivania», «Fatture» in Documenti. */
  place: string;
  /** What the step had read before asking that is not the user's (pages, files): empty when nothing. */
  after: string[];
}

/** The card of a `mac.read` approval (kind `mac`), or undefined when it is not a whole one (a purged one, a core without it). */
export function macRead(approval: { kind: string; action: string; detail: Record<string, unknown> }): MacReadCard | undefined {
  if (approval.kind !== 'mac' || approval.action !== 'mac.read') return undefined;
  const { sentence, command, place, after } = approval.detail;
  if (typeof sentence !== 'string' || typeof command !== 'string' || typeof place !== 'string' || sentence.trim() === '') return undefined;
  const read = Array.isArray(after) ? after.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  return { sentence: sentence.trim(), command: command.trim(), place: place.trim(), after: read };
}

/** The line under the sentence when the step read something not of the user before asking (D-314, point 3). */
export function afterText(after: readonly string[]): string | undefined {
  if (after.length === 0) return undefined;
  return `Richiesta dopo aver letto: ${after.join(', ')}. Controlla che sia davvero quello che vuoi.`;
}
