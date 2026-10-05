/**
 * The "/" commands of the chat (D-090), as in Claude Code: typing "/" in the
 * composer opens a menu of these, filtered while typing. The only list of
 * commands: to add one, add an entry here and, when its action is new, handle
 * it in ChatView. Pure data, no Vue.
 */
export type CommandAction =
  /** Saves the text after the name as a thought (D-080): handled by the store. */
  | { kind: 'note' }
  | { kind: 'open'; page: 'thoughts' | 'knowledge' | 'settings' }
  | { kind: 'new-conversation' }
  | { kind: 'search' }
  | { kind: 'help' };

export interface ChatCommand {
  /** Without the slash, lowercase, letters only. */
  name: string;
  /** A shorter name that works the same, shown as the shortcut. */
  alias?: string;
  description: string;
  /** True when the command takes a text after its name. */
  takesArgument: boolean;
  /** What the argument is, shown in the menu (`/nota <testo>`). */
  argumentHint?: string;
  action: CommandAction;
}

export const COMMANDS: readonly ChatCommand[] = [
  { name: 'nota', alias: 'n', description: 'Salva il testo come pensiero in kb/inbox, senza Arianna', takesArgument: true, argumentHint: 'testo', action: { kind: 'note' } },
  { name: 'pensieri', alias: 'p', description: 'Apre la pagina dei pensieri', takesArgument: false, action: { kind: 'open', page: 'thoughts' } },
  { name: 'conoscenza', alias: 'g', description: 'Apre il grafo della conoscenza', takesArgument: false, action: { kind: 'open', page: 'knowledge' } },
  { name: 'nuova', description: 'Apre una nuova conversazione dello stesso tipo', takesArgument: false, action: { kind: 'new-conversation' } },
  { name: 'impostazioni', alias: 'i', description: 'Apre le impostazioni', takesArgument: false, action: { kind: 'open', page: 'settings' } },
  { name: 'cerca', description: 'Cerca in tutto il sistema (arriva con la barra nuova)', takesArgument: false, action: { kind: 'search' } },
  { name: 'aiuto', alias: 'a', description: 'Mostra l’elenco dei comandi', takesArgument: false, action: { kind: 'help' } },
];

/** Spaces, tabs, NBSP and invisible characters (ZWSP, ZWJ, word joiner, BOM) before a draft. */
const LEADING = /^[\s\u200B-\u200D\u2060\uFEFF]+/u;

/** The draft without what goes before the first visible character. */
export function stripLeading(draft: string): string {
  return draft.replace(LEADING, '');
}

/**
 * The rule (D-090): after the leading spaces and invisible characters, "/"
 * then letters is always a command. The only exception is a path, where the
 * letters are followed by another "/" ("/etc/hosts"). "/" followed by
 * anything but a letter ("/ 2 fa 3", "/123") is an ordinary message.
 */
const SLASH_WORD = /^\/(\p{L}+)(.?)/su;

/** The command with this name or alias, any case; undefined for none. */
export function findCommand(name: string, commands: readonly ChatCommand[] = COMMANDS): ChatCommand | undefined {
  const key = name.toLowerCase();
  return commands.find((command) => command.name === key || command.alias === key);
}

/**
 * What the menu filters by: the draft after the slash while it is a slash and
 * one word with no space yet; undefined when the menu has nothing to do.
 */
export function menuQuery(draft: string): string | undefined {
  const match = /^\/(\S*)$/u.exec(draft);
  return match === null ? undefined : (match[1] ?? '');
}

/**
 * The commands for a query, in this order: name or alias equal, name starting
 * with it, name containing it, description containing it (from three
 * letters). Empty query: all of them.
 */
export function filterCommands(query: string, commands: readonly ChatCommand[] = COMMANDS): ChatCommand[] {
  const key = query.toLowerCase();
  if (key === '') return [...commands];
  const rank = (command: ChatCommand): number => {
    if (command.name === key || command.alias === key) return 0;
    if (command.name.startsWith(key)) return 1;
    if (command.name.includes(key)) return 2;
    // From three letters: one or two would match half the descriptions.
    if (key.length >= 3 && command.description.toLowerCase().includes(key)) return 3;
    return -1;
  };
  return commands
    .map((command, index) => ({ command, index, rank: rank(command) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}

/** The highlighted row after an arrow key: wraps around; -1 when the list is empty. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0 || index >= length) return delta < 0 ? length - 1 : 0;
  return (((index + delta) % length) + length) % length;
}

/** What the composer holds once a command is chosen with Tab, or with Invio when it takes a text. */
export function completion(command: ChatCommand): string {
  return command.takesArgument ? `/${command.name} ` : `/${command.name}`;
}

/** How the menu shows a command: `/nota <testo>`. */
export function usage(command: ChatCommand): string {
  return command.argumentHint === undefined ? `/${command.name}` : `/${command.name} <${command.argumentHint}>`;
}

export type DraftMeaning =
  | { kind: 'message' }
  | { kind: 'command'; command: ChatCommand; argument: string }
  | { kind: 'error'; text: string };

/**
 * What a draft sent from the composer means: an ordinary message for Arianna,
 * a known command with its argument, or a refusal in Italian (an unknown
 * command, or a text after a command that takes none) that never reaches
 * Arianna.
 */
export function resolveDraft(draft: string, commands: readonly ChatCommand[] = COMMANDS): DraftMeaning {
  const start = stripLeading(draft);
  const match = SLASH_WORD.exec(start);
  const name = match?.[1];
  const next = match?.[2] ?? '';
  if (name === undefined || next === '/') return { kind: 'message' };
  const command = findCommand(name, commands);
  // "/pensieri." or "/nota:testo": not the exact name, refused like an unknown one.
  const exact = next === '' || /\s/u.test(next);
  if (command === undefined || !exact) {
    return { kind: 'error', text: `Comando sconosciuto: /${name}${exact ? '' : next}. Per salvare una nota scrivi /nota seguito dal testo; scrivi / per vedere i comandi.` };
  }
  const argument = start.slice(1 + name.length).trim();
  if (!command.takesArgument && argument !== '') return { kind: 'error', text: `/${command.name} non vuole testo dopo il nome.` };
  return { kind: 'command', command, argument };
}

/**
 * True when the draft is a message for Arianna; false for any command
 * (`/nota` goes to the capture, the others are carried out by the page) and
 * for a refused one.
 */
export function goesToArianna(draft: string): boolean {
  return resolveDraft(draft).kind === 'message';
}
