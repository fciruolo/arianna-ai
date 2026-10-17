import { answerText } from '@arianna/agents';
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
- A list: one item per line, each starting with "- " or "1. ".
- Commands and code: a fenced code block with its language.
- Bold sparingly, only for what matters most.
- A short answer is one sentence or one paragraph: no headings.
- No preamble such as "Ecco" or "Certo", no JSON, no word about this message. Write only the reply.`;

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
    { role: 'user', content: REPLY_INSTRUCTION },
  ];
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
  const send = (piece: string): void => {
    for (const part of live.feed(piece)) if (part.part === 'text') request.onText?.(part.text);
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
    for (const part of live.end()) if (part.part === 'text') request.onText?.(part.text);
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
  const text = whole.text.trim();
  if (result.finishReason === 'length') return draft('truncated', tokensIn, tokensOut);
  if (text === '') return draft('empty', tokensIn, tokensOut);
  if (text.length > MAX_REPLY_CHARS) return draft('too-long', tokensIn, tokensOut);
  if (isJsonObject(text)) return draft('json', tokensIn, tokensOut);
  return { text, tokensIn, tokensOut };
}
