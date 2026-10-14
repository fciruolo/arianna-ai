// The terminal of a run (D-095, tappa 1): the commands the Coder runs with
// Bash and what they print, taken from the events `claude -p` already sends,
// for the chat to show live, read only. Pure: the caller passes the secrets
// the vault has revealed, as the gateway does (docs/PRIVACY-POLICY-SPEC.md,
// rule 6). Nothing here is stored.
import type { KnownSecrets } from '@arianna/policy';

/** Most lines of one command or of its output shown in the chat. */
export const MAX_TERMINAL_LINES = 200;
/** Most bytes (UTF-8) of one command or of its output shown in the chat. */
export const MAX_TERMINAL_BYTES = 16 * 1024;

/**
 * Most bytes of one command or output the stream passes on, before the vault
 * filter: a longer one is passed empty and marked cut, never cut in the
 * middle, where a value of the vault could lose the end that makes it known.
 */
export const MAX_RAW_TERMINAL_BYTES = 1024 * 1024;

/** What the chat shows in place of a line holding a value of the vault. */
export const HIDDEN_LINE = '[riga nascosta: conteneva un valore del vault]';

export interface ClippedText {
  text: string;
  /** Lines or bytes were left out. */
  truncated: boolean;
}

/**
 * The beginning of a text, at most MAX_TERMINAL_LINES lines and
 * MAX_TERMINAL_BYTES bytes, never inside a character. Line endings are made
 * `\n`; the text is otherwise as the run printed it.
 */
export function clipTerminal(text: string): ClippedText {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let truncated = false;
  let kept = lines;
  if (kept.length > MAX_TERMINAL_LINES) {
    kept = kept.slice(0, MAX_TERMINAL_LINES);
    truncated = true;
  }
  let joined = kept.join('\n');
  if (Buffer.byteLength(joined) > MAX_TERMINAL_BYTES) {
    let bytes = 0;
    let end = 0;
    for (const point of joined) {
      const size = Buffer.byteLength(point);
      if (bytes + size > MAX_TERMINAL_BYTES) break;
      bytes += size;
      end += point.length;
    }
    joined = joined.slice(0, end);
    truncated = true;
  }
  return { text: joined, truncated };
}

/** A text as the chat may show it: lines holding a value of the vault replaced, or nothing at all. */
export interface ShownText {
  text: string;
  /** Lines replaced by HIDDEN_LINE. */
  hidden: number;
}

/**
 * The text with every line that holds a value revealed by the vault replaced
 * by HIDDEN_LINE; undefined when a value is still found in what is left (a
 * value split over two lines): then nothing of it is shown. The values of a
 * project's own `.env` are not known to the vault and pass (D-095, privacy
 * risks of tappa 1).
 */
export function terminalShown(text: string, secrets: KnownSecrets): ShownText | undefined {
  if (secrets.find(text).length === 0) return { text, hidden: 0 };
  let hidden = 0;
  const lines = text.split('\n').map((line) => {
    if (secrets.find(line).length === 0) return line;
    hidden += 1;
    return HIDDEN_LINE;
  });
  const shown = lines.join('\n');
  return secrets.find(shown).length === 0 ? { text: shown, hidden } : undefined;
}

/** The text as the stream passes it on: whole, or empty and marked cut past MAX_RAW_TERMINAL_BYTES. */
export function rawTerminal(text: string): ClippedText {
  return Buffer.byteLength(text) > MAX_RAW_TERMINAL_BYTES ? { text: '', truncated: true } : { text, truncated: false };
}

/**
 * The text as the chat shows it: first the lines holding a value of the vault
 * replaced (on the whole text, so that a cut never leaves half a value that
 * the vault would not know), then cut with clipTerminal. Undefined when
 * nothing may be shown (terminalShown).
 */
export function terminalText(raw: string, secrets: KnownSecrets): (ClippedText & { hidden: number }) | undefined {
  const shown = terminalShown(raw.replace(/\r\n?/g, '\n'), secrets);
  if (shown === undefined) return undefined;
  const clipped = clipTerminal(shown.text);
  return { ...clipped, hidden: shown.hidden };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The command of a call to Bash, from its input; nothing for another tool or an input of an unexpected shape. */
export function bashCommandOf(name: string, input: unknown): string | undefined {
  if (name !== 'Bash' || !isRecord(input) || typeof input.command !== 'string' || input.command === '') return undefined;
  return input.command;
}

/**
 * The text of a tool result as the binary sends it in a `user` message: a
 * string, or a list of blocks whose text ones are joined. Images and other
 * blocks are left out.
 */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content as unknown[]) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n');
}
