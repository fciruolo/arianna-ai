// Reading `codex exec --json`: one JSON object per line. Pure: the process is
// driven by run.ts. Shapes taken from real runs of 0.160.0
// (test/fixtures/codex-stream.jsonl). Codex has no init message to check the
// profile against: the alarm is the closed list of items a run may show, so a
// newer binary that gave the model a web search or an MCP tool stops the run
// instead of being ignored.
import type { ClaudeUsage, StreamFailure, StreamResult } from '../claude/stream.ts';

export type CodexUsage = ClaudeUsage;

/** What a file change did to one file. */
export const CODEX_FILE_CHANGE_KINDS = ['add', 'update', 'delete'] as const;
export type CodexFileChangeKind = (typeof CODEX_FILE_CHANGE_KINDS)[number];

/**
 * What a run reports while it works. Commands and their output are left out,
 * the kind of item is enough to follow it; a file change gives the path as
 * the binary wrote it (the caller checks it is in the project) and its kind,
 * never the content.
 */
export type CodexEvent =
  | { type: 'init'; sessionRef: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: 'command' | 'file_change' }
  | { type: 'file'; path: string; kind: CodexFileChangeKind }
  | { type: 'usage'; usage: CodexUsage };

/**
 * The items a confined run may produce. Any other (`mcp_tool_call`,
 * `web_search`, a sub-agent call, a type a newer binary adds) is a profile
 * violation.
 */
const ITEMS = ['agent_message', 'reasoning', 'command_execution', 'file_change', 'todo_list', 'error'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);
/** Strings from the binary go into logs: only short plain codes pass. */
const code = (value: unknown): string | undefined => (typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : undefined);

/**
 * The HTTP status of an API error: the binary wraps the server's JSON in its
 * message. The message itself is never kept, it may quote the request.
 */
function apiStatusOf(message: unknown): number | undefined {
  if (typeof message !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed) && typeof parsed.status === 'number' && Number.isSafeInteger(parsed.status)) return parsed.status;
  } catch {
    // Plain text.
  }
  return undefined;
}

/** A refusal of the subscription: HTTP 429, or the binary's own words for a used-up plan. */
function isQuota(message: unknown, status: number | undefined): boolean {
  return status === 429 || (typeof message === 'string' && /usage limit|rate limit/i.test(message));
}

/**
 * The state of one run, fed line by line. `feed` returns the events to report
 * and stops at the first failure; `result` is set once the turn has completed,
 * or a failure was found.
 */
export class CodexStream {
  sessionRef: string | undefined;
  result: StreamResult | undefined;
  readonly #expected: { sessionRef?: string };
  #text = '';
  #tokensIn = 0;
  #tokensOut = 0;
  #turns = 0;
  #context: number | undefined;
  #apiStatus: number | undefined;
  #quota = false;

  /** `sessionRef`: the session a resume asked for; the binary must continue that one, not start another. */
  constructor(expected: { sessionRef?: string } = {}) {
    this.#expected = expected;
  }

  /** Usage so far; `turns` counts the commands and file changes, the tool round trips of the run. */
  get usage(): CodexUsage {
    return { tokensIn: this.#tokensIn, tokensOut: this.#tokensOut, turns: this.#turns, ...(this.#context === undefined ? {} : { context: this.#context }) };
  }

  feed(line: string): CodexEvent[] {
    if (this.result !== undefined || line.trim() === '') return [];
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.#fail('bad-output');
    }
    if (!isRecord(message) || typeof message.type !== 'string') return this.#fail('bad-output');
    // The thread comes first: nothing before it is trusted.
    if (this.sessionRef === undefined && message.type !== 'thread.started') return this.#fail('bad-output');
    switch (message.type) {
      case 'thread.started':
        return this.#thread(message);
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.#item(message.type, message.item);
      case 'turn.completed':
        return this.#completed(message);
      case 'turn.failed':
        return this.#failed(isRecord(message.error) ? message.error.message : undefined);
      case 'error':
        // Followed by `turn.failed`; noted here because the two may differ in detail.
        this.#note(message.message);
        return [];
      default:
        // Other messages (`turn.started`, types a newer binary adds) carry no tool use: the closed list is the items'.
        return [];
    }
  }

  #fail(failure: StreamFailure, extra: Partial<StreamResult> = {}): CodexEvent[] {
    this.result = { ok: false, failure, ...extra };
    return [];
  }

  #note(message: unknown): void {
    const status = apiStatusOf(message);
    if (status !== undefined) this.#apiStatus = status;
    if (isQuota(message, status)) this.#quota = true;
  }

  #thread(message: Record<string, unknown>): CodexEvent[] {
    if (typeof message.thread_id !== 'string' || message.thread_id === '') return this.#fail('bad-output');
    const session = this.sessionRef ?? this.#expected.sessionRef;
    if (session !== undefined && message.thread_id !== session) return this.#fail('profile', { violations: ['session'] });
    if (this.sessionRef !== undefined) return [];
    this.sessionRef = message.thread_id;
    return [{ type: 'init', sessionRef: this.sessionRef }];
  }

  #item(phase: string, item: unknown): CodexEvent[] {
    if (!isRecord(item) || typeof item.type !== 'string') return this.#fail('bad-output');
    if (!(ITEMS as readonly string[]).includes(item.type)) {
      return this.#fail('profile', { violations: [`item:${code(item.type) ?? 'unknown'}`] });
    }
    switch (item.type) {
      case 'agent_message':
        if (phase !== 'item.completed' || typeof item.text !== 'string') return [];
        // The answer is the last message of the turn; the earlier ones are progress.
        this.#text = item.text;
        return item.text === '' ? [] : [{ type: 'text', text: item.text }];
      case 'command_execution':
        if (phase !== 'item.started') return [];
        this.#turns += 1;
        return [{ type: 'tool', name: 'command' }];
      case 'file_change': {
        if (phase !== 'item.completed') return [];
        this.#turns += 1;
        const events: CodexEvent[] = [{ type: 'tool', name: 'file_change' }];
        for (const change of Array.isArray(item.changes) ? (item.changes as unknown[]) : []) {
          if (!isRecord(change) || typeof change.path !== 'string' || change.path === '') continue;
          const kind = (CODEX_FILE_CHANGE_KINDS as readonly unknown[]).includes(change.kind) ? (change.kind as CodexFileChangeKind) : undefined;
          if (kind !== undefined) events.push({ type: 'file', path: change.path, kind });
        }
        return events;
      }
      default:
        // Reasoning, plans and warnings (`error` items do not end the turn).
        return [];
    }
  }

  #completed(message: Record<string, unknown>): CodexEvent[] {
    const usage = isRecord(message.usage) ? message.usage : {};
    // `input_tokens` already holds the cached ones, `output_tokens` the reasoning.
    const tokensIn = count(usage.input_tokens);
    const tokensOut = count(usage.output_tokens);
    this.#tokensIn += tokensIn;
    this.#tokensOut += tokensOut;
    this.#context = tokensIn + tokensOut;
    this.result = { ok: true, text: this.#text, permissionDenials: 0 };
    return [{ type: 'usage', usage: this.usage }];
  }

  #failed(message: unknown): CodexEvent[] {
    this.#note(message);
    const extra = this.#apiStatus === undefined ? {} : { apiStatus: this.#apiStatus };
    return this.#fail(this.#quota ? 'quota' : 'execution', extra);
  }
}
