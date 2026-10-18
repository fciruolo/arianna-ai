import { answerText, REPLY_TEXT_MAX_LENGTH } from '@arianna/agents';
import { LocalModelError, ThinkSplitter, type ChatMessage, type LocalModel } from '@arianna/executors';

/**
 * The reply of the local orchestrator written as free text (D-251). Under
 * the response schema the model never breaks a line inside the JSON string
 * of a `reply`: a Markdown table came as one line of pipes. The JSON still
 * decides what to do; when it is a reply, one more call without a schema
 * writes the text the user reads, in Markdown, from that draft.
 *
 * The request is the one of the step, byte for byte (the prefix stays in the
 * cache of oMLX, D-075), followed by the draft as the model's own answer and
 * one instruction. Anything that goes wrong gives back the draft: a failure
 * of the local model, an empty text, an answer cut by its token limit or
 * longer than MAX_REPLY_CHARS, a JSON again. Only a stopped step throws: the
 * engine decides.
 */

/** Room for the reply: a table or a list takes more than the 2000 characters of the schema's `text`. */
export const REPLY_MAX_TOKENS = 3_072;
/** Per endpoint attempt: the prompt is in the cache, only the writing takes time. */
export const REPLY_TIMEOUT_MS = 180_000;
/** Longest reply kept; past it the draft is stored instead. */
export const MAX_REPLY_CHARS = 12_000;

/** What the model reads after its draft. English, as the rest of the prompt; the reply is in the user's language. */
export const REPLY_INSTRUCTION = `[System message, not from the user] Your JSON answer above is the draft of your reply. Now write that reply for the user as plain text in Markdown, not JSON.
- Use only the facts of the draft and of the conversation above: add nothing that is not there, and keep what the user needs, sources included.
- Write in the user's language, with the voice of your instructions.
- Data with columns (amounts, dates, comparisons): a Markdown table, the header row first, one row per line.
- A list: one item per line, each starting with "- " or "1. "; at most about 12 items, the most useful ones, unless the user asked for all of them.
- Commands and code: a fenced code block with its language.
- Bold sparingly, only for what matters most.
- A short answer is one sentence or one paragraph: no headings.
- Start with the answer itself: the first words are the fact, the first row of the table or the first item. Never open with a line that only announces what follows, even when the draft does; leave that line out.
- No JSON, no word about this message. Write only the reply.`;

/**
 * Added to the instruction when the draft filled the schema's `text`: the grammar cut it, often mid-item.
 * Counted in code points, as the schema. A draft that ends by itself at exactly the limit gets it too: rare, and it costs a last sentence at most.
 */
export const CUT_DRAFT_NOTE = '- The draft was cut at its length limit: leave out its unfinished last item or sentence.';

/** Why the draft was kept instead of the free text. */
export type DraftReason = 'failed' | 'empty' | 'truncated' | 'too-long' | 'json';

export interface FreeReply {
  /** The text to store: the free one, or the draft. */
  text: string;
  /** Undefined when the free text was kept. */
  draftKept?: DraftReason;
  tokensIn: number;
  tokensOut: number;
}

export interface FreeReplyRequest {
  /** The model alias of the step. */
  model: string;
  /** The messages of the step's call, system prompt first. */
  messages: readonly ChatMessage[];
  /** The `text` of the step's `reply`. */
  draft: string;
  temperature: number;
  signal: AbortSignal;
  /** Each piece of the reply as it is written, without a `<think>` block; the caller decides whether it goes live. */
  onText?: (piece: string) => void;
}

/** The messages of the second call: the step's, then the draft as the model's answer, then the instruction. */
export function freeReplyMessages(messages: readonly ChatMessage[], draft: string): ChatMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: answerText({ action: 'reply', text: draft }),
    },
    { role: 'user', content: Array.from(draft).length >= REPLY_TEXT_MAX_LENGTH ? `${REPLY_INSTRUCTION}\n${CUT_DRAFT_NOTE}` : REPLY_INSTRUCTION },
  ];
}

// The empty opening of a reply (D-253): «Ecco la tabella delle spese:» on a
// line of its own, a bare «Ecco» or «Certo!», seen live despite the
// instruction. Only whole announcing lines (or a bare «Ecco:» before the
// text) go; a sentence that says something stays: «Ecco perché la polizza
// scade il 3 marzo», «Ecco come fare:», «Ecco le spese: 87 euro».
const INTERJECTION = String.raw`(?:(?:certo|certamente|sì|ok|okay|perfetto|bene)[ \t]*[!,.]?[ \t]*)?`;
const QUESTION_WORD = String.raw`(?:perch[ée]|come|cosa|dove|quando|quant[oaie]|chi|qual[ei]?)(?!\p{L})`;
const HERE = String.raw`ecco(?:[ \t]+(?:qui|qua|a[ \t]+te|a[ \t]+voi))?`;
const PREAMBLES: readonly RegExp[] = [
  // «Ecco», «Ecco:», «Certo! Ecco qui.» alone on the first line.
  new RegExp(String.raw`^${INTERJECTION}${HERE}[ \t]*[:!.,]?[ \t]*\n`, 'iu'),
  // «Ecco la tabella delle spese:» alone on the first line; not «Ecco perché:», nor a line with a figure
  // («Ecco le 3 fatture scadute entro il 5 marzo, per 870 euro:» says something).
  new RegExp(String.raw`^${INTERJECTION}ecco[ \t]+(?!${QUESTION_WORD})[^\n.!?:\d]{1,80}:[ \t]*\n`, 'iu'),
  // «Certo!» alone on the first line.
  new RegExp(String.raw`^(?:certo|certamente)[ \t]*[!.,]?[ \t]*\n`, 'iu'),
];
/** «Ecco: paghi 87 euro»: the bare word and its colon before the text on the same line. */
const INLINE_PREAMBLE = new RegExp(String.raw`^${INTERJECTION}${HERE}[ \t]*:[ \t]+(?=\S)`, 'iu');
/** First words a preamble can start with: any other start is never one, and streams at once. */
const STARTERS = ['certo', 'certamente', 'sì', 'ok', 'okay', 'perfetto', 'bene', 'ecco'];
/** Past this many characters on the first line, no preamble can match. */
const PREAMBLE_WINDOW = 160;

/**
 * The reply without an empty opening (D-253). A preamble with nothing after it is left alone: then it is the
 * whole reply. Without a preamble the text comes back unchanged, leading spaces included.
 */
export function stripPreamble(text: string): string {
  // «Certo!» on one line, «Ecco la tabella:» on the next: a few rounds at most.
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    const next = stripOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function stripOnce(text: string): string {
  const body = text.trimStart();
  for (const pattern of PREAMBLES) {
    const match = pattern.exec(body);
    if (match === null) continue;
    const rest = body.slice(match[0].length).trimStart();
    return rest === '' ? text : rest;
  }
  const inline = INLINE_PREAMBLE.exec(body);
  if (inline === null) return text;
  const rest = body.slice(inline[0].length);
  return /^\p{Ll}/u.test(rest) ? `${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : rest;
}

/**
 * `stripPreamble` on a stream: the start is held only while it could still be a preamble (the first line and the
 * first text after it), then everything passes as it comes. What is shown is what is stored.
 */
export class PreambleFilter {
  private held = '';
  private decided = false;

  feed(piece: string): string {
    if (this.decided) return piece;
    this.held += piece;
    // Looked at past the preambles already whole: «Certo!» on its line can be followed by «Ecco la tabella:».
    const body = stripPreamble(this.held).trimStart();
    if (body === '') return '';
    const start = body.slice(0, 11).toLowerCase();
    const could = STARTERS.some((word) => word.startsWith(start) || start.startsWith(word));
    const lineDone = /\n[\s]*\S/.test(body);
    if (could && !lineDone && body.length < PREAMBLE_WINDOW) return '';
    return this.flush();
  }

  end(): string {
    return this.decided ? '' : this.flush();
  }

  private flush(): string {
    this.decided = true;
    const out = stripPreamble(this.held);
    this.held = '';
    return out;
  }
}

/** True for a text that is a JSON object: the model answered with the schema again. */
function isJsonObject(text: string): boolean {
  if (!text.startsWith('{')) return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * A server or template that refuses `chat_template_kwargs`: asked once more without it. Any 400 or 422 counts (a
 * context too long too): one call more before the draft is kept, harmless.
 */
function refusedOption(error: unknown): boolean {
  return error instanceof LocalModelError && error.kind === 'http' && (error.status === 400 || error.status === 422);
}

export async function writeFreeReply(model: LocalModel, request: FreeReplyRequest): Promise<FreeReply> {
  const draft = (reason: DraftReason, tokensIn = 0, tokensOut = 0): FreeReply => ({
    text: request.draft,
    draftKept: reason,
    tokensIn,
    tokensOut,
  });
  const live = new ThinkSplitter();
  const opening = new PreambleFilter();
  const show = (text: string): void => {
    const shown = opening.feed(text);
    if (shown !== '') request.onText?.(shown);
  };
  const send = (piece: string): void => {
    for (const part of live.feed(piece)) if (part.part === 'text') show(part.text);
  };
  const call = (thinking: boolean) =>
    model.chat({
      model: request.model,
      messages: freeReplyMessages(request.messages, request.draft),
      temperature: request.temperature,
      maxTokens: REPLY_MAX_TOKENS,
      timeoutMs: REPLY_TIMEOUT_MS,
      signal: request.signal,
      ...(thinking ? {} : { thinking: false as const }),
      // Streamed, the token counts come only when asked for (D-199).
      ...(request.onText === undefined ? {} : { onText: send, streamUsage: true }),
    });
  let result;
  try {
    try {
      result = await call(false);
    } catch (error) {
      if (!refusedOption(error)) throw error;
      result = await call(true);
    }
    for (const part of live.end()) if (part.part === 'text') show(part.text);
    const rest = opening.end();
    if (rest !== '') request.onText?.(rest);
  } catch (error) {
    // Stopped: the engine decides. Any other failure of the local model keeps the draft; the tokens of a stream cut
    // half way are not known (no usage came), and are not counted.
    if (request.signal.aborted || !(error instanceof LocalModelError)) throw error;
    return draft('failed');
  }
  const tokensIn = result.usage?.promptTokens ?? 0;
  const tokensOut = result.usage?.completionTokens ?? 0;
  // Read again from the whole answer, without its `<think>` blocks: what came in pieces is only what was shown.
  const whole = new ThinkSplitter();
  whole.feed(result.text);
  whole.end();
  const text = stripPreamble(whole.text.trim());
  if (result.finishReason === 'length') return draft('truncated', tokensIn, tokensOut);
  if (text === '') return draft('empty', tokensIn, tokensOut);
  if (text.length > MAX_REPLY_CHARS) return draft('too-long', tokensIn, tokensOut);
  if (isJsonObject(text)) return draft('json', tokensIn, tokensOut);
  return { text, tokensIn, tokensOut };
}
