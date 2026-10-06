// Reading `claude -p --output-format stream-json`: one JSON object per line.
// Pure: the process is driven by run.ts. Shapes taken from real runs of
// 2.1.288 (test/fixtures/claude-stream.jsonl); unknown types are ignored, so a
// newer binary that adds messages does not break a run.
import { profileViolations, type ClaudeTool, type InitReport } from './profile.ts';

export interface ClaudeUsage {
  /** Input tokens, cache reads and writes included. */
  tokensIn: number;
  tokensOut: number;
  /** Model responses in the run (each tool round trip is one). */
  turns: number;
  /**
   * How full the session's context is after the run: input and output of its
   * latest model response (D-111, the context indicator of the direct chat).
   */
  context?: number;
}

/** One replacement of a file edit: `before` is empty when the tool wrote the whole file. */
export interface FileEditPart {
  before: string;
  after: string;
}

/** The tools whose input is a change to a file (D-117, second stage). */
export const FILE_EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write'] as const;
export type FileEditTool = (typeof FILE_EDIT_TOOLS)[number];

/**
 * What a run reports while it works. Tool inputs are left out, names are
 * enough to follow it; the only exception is a change to a file (`edit`, after
 * its `tool`), which the core turns into a live diff for the chat (D-117).
 * `filePath` is as the binary wrote it: the caller checks it is in the project.
 */
export type ClaudeEvent =
  | { type: 'init'; sessionRef: string; model: string; tools: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'edit'; tool: FileEditTool; filePath: string; parts: FileEditPart[] }
  | { type: 'usage'; usage: ClaudeUsage }
  | {
      type: 'rate-limit';
      /** `allowed`, `allowed_warning`, `rejected` (the binary's words); `unknown` for anything not a plain code. */
      status: string;
      /** E.g. `five_hour`, `seven_day`; a plain code or left out. */
      window?: string;
      /** The subscription is drawing on paid extra usage: the run is stopped (`overage`). */
      overage: boolean;
      resetsAt?: Date;
      /** Share of the window used, 0 to 1, when the binary says it. */
      utilization?: number;
    };

export type StreamFailure =
  | 'bad-output' // not JSON, or not the expected shape
  | 'profile' // the init message contradicts the confinement profile
  | 'quota' // the subscription refused: rate limit
  | 'overage' // the subscription went on paid extra usage (D-002: nothing beyond it)
  | 'max-turns'
  | 'execution'; // the binary reported an error

export interface StreamResult {
  ok: boolean;
  /** The final answer; only for a success. */
  text?: string;
  failure?: StreamFailure;
  /** Names of the profile fields that did not hold. */
  violations?: string[];
  /** HTTP status of the API error, when the binary gives it. */
  apiStatus?: number;
  /** Tool uses the permissions refused, on a final message. */
  permissionDenials?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Strings from the binary go into L0 events: only short plain codes pass. */
const code = (value: unknown): string | undefined => (typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);

function tokensIn(usage: Record<string, unknown>): number {
  return count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
}

/**
 * The change a call to Edit, MultiEdit or Write makes, from its input; nothing
 * for another tool or an input of an unexpected shape (a newer binary).
 */
export function fileEditOf(name: string, input: unknown): Extract<ClaudeEvent, { type: 'edit' }> | undefined {
  if (!isRecord(input) || typeof input.file_path !== 'string' || input.file_path === '') return undefined;
  const filePath = input.file_path;
  const part = (value: unknown): FileEditPart | undefined =>
    isRecord(value) && typeof value.old_string === 'string' && typeof value.new_string === 'string' ? { before: value.old_string, after: value.new_string } : undefined;
  switch (name) {
    case 'Edit': {
      const one = part(input);
      return one === undefined ? undefined : { type: 'edit', tool: 'Edit', filePath, parts: [one] };
    }
    case 'MultiEdit': {
      if (!Array.isArray(input.edits) || input.edits.length === 0) return undefined;
      const parts: FileEditPart[] = [];
      for (const item of input.edits as unknown[]) {
        const one = part(item);
        if (one === undefined) return undefined;
        parts.push(one);
      }
      return { type: 'edit', tool: 'MultiEdit', filePath, parts };
    }
    case 'Write':
      return typeof input.content === 'string' ? { type: 'edit', tool: 'Write', filePath, parts: [{ before: '', after: input.content }] } : undefined;
    default:
      return undefined;
  }
}

/** Epoch seconds to a date; undefined for anything else. */
function epoch(value: unknown): Date | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : undefined;
}

/**
 * The state of one run, fed line by line. `feed` returns the events to report
 * and stops at the first failure; `result` is set once the binary has given its
 * final message, or a failure was found.
 */
export class ClaudeStream {
  sessionRef: string | undefined;
  model: string | undefined;
  result: StreamResult | undefined;
  /** When the subscription will take requests again, if a refusal said so. */
  resetsAt: Date | undefined;
  readonly #expected: { cwd: string; tools: readonly ClaudeTool[]; sessionRef?: string };
  /** Usage per model response: a response can come in several messages with the same id. */
  readonly #responses = new Map<string, { in: number; out: number }>();
  #final: ClaudeUsage | undefined;
  #context: number | undefined;
  #rejected = false;

  /** `sessionRef`: the session a resume asked for; the binary must continue that one, not start another. */
  constructor(expected: { cwd: string; tools: readonly ClaudeTool[]; sessionRef?: string }) {
    this.#expected = expected;
  }

  /** Usage so far: the final count when the binary gave one, else the sum of the responses seen. */
  get usage(): ClaudeUsage {
    if (this.#final !== undefined) return this.#context === undefined ? this.#final : { ...this.#final, context: this.#context };
    let tokensIn = 0;
    let tokensOut = 0;
    for (const response of this.#responses.values()) {
      tokensIn += response.in;
      tokensOut += response.out;
    }
    return { tokensIn, tokensOut, turns: this.#responses.size, ...(this.#context === undefined ? {} : { context: this.#context }) };
  }

  feed(line: string): ClaudeEvent[] {
    if (this.result !== undefined || line.trim() === '') return [];
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.#fail('bad-output');
    }
    if (!isRecord(message) || typeof message.type !== 'string') return this.#fail('bad-output');
    if (this.sessionRef === undefined && !(message.type === 'system' && message.subtype === 'init')) {
      // Nothing is trusted before the profile has been checked.
      return message.type === 'system' ? [] : this.#fail('bad-output');
    }
    switch (message.type) {
      case 'system':
        return message.subtype === 'init' ? this.#init(message) : [];
      case 'assistant':
        return this.#assistant(message);
      case 'rate_limit_event':
        return this.#rateLimit(message);
      case 'result':
        return this.#result(message);
      default:
        return [];
    }
  }

  #fail(failure: StreamFailure, extra: Partial<StreamResult> = {}): ClaudeEvent[] {
    this.result = { ok: false, failure, ...extra };
    return [];
  }

  #init(message: Record<string, unknown>): ClaudeEvent[] {
    if (typeof message.session_id !== 'string' || message.session_id === '') return this.#fail('bad-output');
    // Every init is checked, a later one too; a resume must continue the session asked for.
    const violations = profileViolations(message as unknown as InitReport, this.#expected);
    const session = this.sessionRef ?? this.#expected.sessionRef;
    if (session !== undefined && message.session_id !== session) violations.push('session');
    if (violations.length > 0) return this.#fail('profile', { violations });
    if (this.sessionRef !== undefined) return [];
    this.sessionRef = message.session_id;
    this.model = typeof message.model === 'string' ? message.model : undefined;
    const tools = Array.isArray(message.tools) ? message.tools.map(String) : [];
    return [{ type: 'init', sessionRef: this.sessionRef, model: this.model ?? '', tools }];
  }

  #assistant(message: Record<string, unknown>): ClaudeEvent[] {
    const body = message.message;
    if (!isRecord(body)) return this.#fail('bad-output');
    // Text and tool calls of subagents are not the run's answer.
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return [];
    const events: ClaudeEvent[] = [];
    for (const block of Array.isArray(body.content) ? body.content : []) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') events.push({ type: 'text', text: block.text });
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        events.push({ type: 'tool', name: block.name });
        const edit = fileEditOf(block.name, block.input);
        if (edit !== undefined) events.push(edit);
      }
    }
    if (isRecord(body.usage)) {
      const id = typeof body.id === 'string' ? body.id : `response-${String(this.#responses.size)}`;
      const response = { in: tokensIn(body.usage), out: count(body.usage.output_tokens) };
      this.#responses.set(id, response);
      this.#context = response.in + response.out;
      events.push({ type: 'usage', usage: this.usage });
    }
    return events;
  }

  #rateLimit(message: Record<string, unknown>): ClaudeEvent[] {
    const info = message.rate_limit_info;
    if (!isRecord(info) || typeof info.status !== 'string') return [];
    const resetsAt = epoch(info.resetsAt);
    const window = code(info.rateLimitType);
    const overage = info.isUsingOverage === true;
    let utilization: number | undefined;
    const windows = info.unifiedWindows;
    if (window !== undefined && isRecord(windows) && isRecord(windows[window])) {
      const value = windows[window].utilization;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) utilization = value;
    }
    if (info.status === 'rejected') {
      this.#rejected = true;
      if (resetsAt !== undefined) this.resetsAt = resetsAt;
    }
    const event: ClaudeEvent = { type: 'rate-limit', status: code(info.status) ?? 'unknown', overage };
    if (window !== undefined) event.window = window;
    if (resetsAt !== undefined) event.resetsAt = resetsAt;
    if (utilization !== undefined) event.utilization = utilization;
    // Reported first, so that the caller records it, then the run stops.
    if (overage && this.result === undefined) this.result = { ok: false, failure: 'overage' };
    return [event];
  }

  #result(message: Record<string, unknown>): ClaudeEvent[] {
    const usage = isRecord(message.usage) ? message.usage : undefined;
    if (usage !== undefined) {
      this.#final = { tokensIn: tokensIn(usage), tokensOut: count(usage.output_tokens), turns: Math.max(count(message.num_turns), this.#responses.size) };
    }
    const apiStatus = typeof message.api_error_status === 'number' ? message.api_error_status : undefined;
    if (message.subtype === 'success' && message.is_error === false && typeof message.result === 'string') {
      this.result = { ok: true, text: message.result, permissionDenials: Array.isArray(message.permission_denials) ? message.permission_denials.length : 0 };
      return [];
    }
    const extra = apiStatus === undefined ? {} : { apiStatus };
    // A refusal of the subscription comes as a rejected rate limit, an HTTP 429, or both.
    if (this.#rejected || apiStatus === 429) return this.#fail('quota', extra);
    if (message.subtype === 'error_max_turns') return this.#fail('max-turns', extra);
    return this.#fail('execution', extra);
  }
}
