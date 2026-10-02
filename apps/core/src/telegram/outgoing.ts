import type { Context, Decision, Label } from '@arianna/policy';

import type { Sql } from '../db/client.ts';
import { passGateway } from '../gateway.ts';

/**
 * A text the gateway allowed towards Telegram (D-044). The Bot API client
 * sends only these: no text reaches Telegram without a row in gateway_log.
 */
export interface ClearedText {
  readonly text: string;
}

const cleared = new WeakSet<ClearedText>();

function clear(text: string): ClearedText {
  const value = Object.freeze({ text });
  cleared.add(value);
  return value;
}

export function isCleared(value: unknown): value is ClearedText {
  return typeof value === 'object' && value !== null && cleared.has(value as ClearedText);
}

export interface Fragment {
  text: string;
  label: Label;
  /** Where it comes from, e.g. `message:42` or `telegram:notice`. */
  source: string;
}

export type Passed = { ok: true; texts: ClearedText[] } | { ok: false; decision: Extract<Decision, { decision: 'block' }> };

/**
 * Asks the gateway whether the fragments may go to Telegram, in `context`
 * (the session that wrote them), and logs the decision. Allowed: one cleared
 * text per fragment, exactly the text checked.
 */
export async function passToTelegram(
  sql: Sql,
  fragments: readonly Fragment[],
  context: Context,
  meta: { taskId?: string; summary?: string } = {},
): Promise<Passed> {
  const decision = await passGateway(
    sql,
    fragments.map((fragment) => ({ value: fragment.text, label: fragment.label, source: fragment.source })),
    context,
    { kind: 'channel', id: 'telegram' },
    meta,
  );
  if (decision.decision === 'block') return { ok: false, decision };
  return { ok: true, texts: decision.texts.map(clear) };
}

/** Telegram takes at most 4096 characters per message, counted in UTF-16 units. */
export const MAX_MESSAGE_UNITS = 4_096;

/**
 * Splits a cleared text into messages Telegram accepts, never inside a
 * surrogate pair, preferring a line break in the second half of a piece.
 * The pieces are parts of the allowed text: they stay cleared.
 */
export function splitCleared(text: ClearedText, max: number = MAX_MESSAGE_UNITS): ClearedText[] {
  if (!isCleared(text)) throw new Error('splitCleared: the text did not pass the gateway');
  const pieces: ClearedText[] = [];
  let rest = text.text;
  while (rest.length > max) {
    let end = max;
    // Do not cut a surrogate pair in two.
    const last = rest.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    const newline = rest.lastIndexOf('\n', end - 1);
    if (newline >= Math.floor(max / 2)) end = newline + 1;
    pieces.push(clear(rest.slice(0, end)));
    rest = rest.slice(end);
  }
  if (rest !== '') pieces.push(clear(rest));
  return pieces;
}
