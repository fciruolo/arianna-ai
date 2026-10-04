import { ClaudeError, LocalModelError, WorkspaceError } from '@arianna/executors';
import type { Label } from '@arianna/policy';

import type { Queryable } from './db/client.ts';
import { appendEvent } from './events.ts';
import { KbError } from './orchestrator/kb.ts';

/**
 * Why a task failed, as the user can read it (D-064): an origin, a stable
 * code and technical details that are scalar values from a closed list per
 * code. Never a message or an output: those could quote the task. The page
 * explains each code from its own catalog (apps/hud/src/lib/failures.ts).
 */
export const FAILURE_ORIGINS = ['local-model', 'claude', 'tool', 'engine'] as const;
export type FailureOrigin = (typeof FAILURE_ORIGINS)[number];

export type FailureDetails = Record<string, string | number>;

export interface Failure {
  origin: FailureOrigin;
  code: string;
  details: FailureDetails;
}

/** What each detail may hold. */
const DETAIL_KINDS = {
  /** An endpoint id from arianna.toml. */
  endpoint: 'name',
  /** How many endpoints of the fallback chain were tried. */
  endpoints: 'count',
  /** The port of the endpoint, from arianna.toml. */
  port: 'port',
  /** HTTP status of the local server. */
  status: 'http',
  /** Attempts of the step job before the task failed. */
  attempts: 'count',
  exitCode: 'count',
  /** HTTP status of the API error claude reported. */
  apiStatus: 'http',
  sqlstate: 'sqlstate',
  /** An executor name. */
  executor: 'name',
  /** An error class, and a system code without digits (ECONNRESET): nothing that could be a data token. */
  error: 'code',
} as const;
type DetailKey = keyof typeof DETAIL_KINDS;

const LOCAL_KEYS: DetailKey[] = ['endpoint', 'endpoints', 'port', 'attempts'];

/** The details each code may carry; anything else is dropped. */
const CODES: Record<string, readonly DetailKey[]> = {
  'local-model.unavailable': LOCAL_KEYS,
  'local-model.timeout': LOCAL_KEYS,
  'local-model.http': [...LOCAL_KEYS, 'status'],
  'local-model.bad-response': LOCAL_KEYS,
  'local-model.no-endpoint': ['attempts'],
  'local-model.cancelled': ['attempts'],
  'tool.workspace': ['attempts'],
  'tool.kb': ['attempts'],
  'engine.lock-expired': [],
  'engine.step-failed': ['executor'],
  'engine.database': ['sqlstate', 'attempts'],
  'engine.unknown': ['error', 'attempts'],
};
/** Every claude.<kind> code carries these. */
const CLAUDE_KEYS: readonly DetailKey[] = ['exitCode', 'apiStatus', 'attempts'];

const CLAUDE_KIND = /^[a-z][a-z-]{0,40}$/;

function allowedKeys(code: string): readonly DetailKey[] | undefined {
  if (code.startsWith('claude.')) return CLAUDE_KIND.test(code.slice('claude.'.length)) ? CLAUDE_KEYS : undefined;
  return CODES[code];
}

function validDetail(key: DetailKey, value: unknown): boolean {
  switch (DETAIL_KINDS[key]) {
    case 'name':
      return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
    case 'code':
      return typeof value === 'string' && /^[A-Za-z]{1,40}(:[A-Z][A-Z_]{1,40})?$/.test(value);
    case 'sqlstate':
      return typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value);
    case 'count':
      return Number.isSafeInteger(value) && (value as number) >= 0;
    case 'port':
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
    case 'http':
      return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
  }
}

/**
 * The failure as it may be stored: a known code (an unknown one becomes
 * `engine.unknown`) and only the details of its list, each checked.
 */
export function cleanFailure(origin: string, code: string, details: Record<string, unknown>): Failure {
  const keys = allowedKeys(code);
  const known = FAILURE_ORIGINS.find((item) => item === origin);
  if (keys === undefined || known === undefined || code.split('.', 1)[0] !== known) {
    return { origin: 'engine', code: 'engine.unknown', details: {} };
  }
  const clean: FailureDetails = {};
  for (const key of keys) {
    const value = details[key];
    if (value !== undefined && validDetail(key, value)) clean[key] = value as string | number;
  }
  return { origin: known, code, details: clean };
}

export interface DescribeOptions {
  /** Attempts of the step job when the task failed. */
  attempts?: number;
  /** The port of an endpoint id, from the configuration. */
  endpointPort?: (endpoint: string) => number | undefined;
}

/** The failure an error describes. Reads kinds, codes and numbers, never `message`. */
export function describeFailure(error: unknown, options: DescribeOptions = {}): Failure {
  const attempts = options.attempts;
  if (error instanceof LocalModelError) {
    // From the fallback chain: the last endpoint tried says where it stopped.
    const last = error.attempts.at(-1) ?? error;
    const endpoint = last.endpoint ?? error.endpoint;
    const port = endpoint === undefined ? undefined : options.endpointPort?.(endpoint);
    return cleanFailure('local-model', `local-model.${error.kind}`, {
      endpoint,
      endpoints: error.attempts.length > 0 ? error.attempts.length : undefined,
      port,
      status: last.status ?? error.status,
      attempts,
    });
  }
  if (error instanceof ClaudeError) {
    return cleanFailure('claude', `claude.${error.kind}`, { exitCode: error.exitCode, apiStatus: error.apiStatus, attempts });
  }
  if (error instanceof WorkspaceError) return cleanFailure('tool', 'tool.workspace', { attempts });
  if (error instanceof KbError) return cleanFailure('tool', 'tool.kb', { attempts });
  if (error instanceof Error && error.name === 'PostgresError') {
    return cleanFailure('engine', 'engine.database', { sqlstate: (error as { code?: unknown }).code, attempts });
  }
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return cleanFailure('engine', 'engine.unknown', { error: typeof code === 'string' ? `${name}:${code}` : name, attempts });
}

export interface StoredFailure extends Failure {
  /** bigint, kept as a string. */
  id: string;
  taskId: string;
  ts: Date;
  label: Label;
}

/**
 * Stores why the task failed, with the label of what it had read, and
 * writes `task.failed` (L0: origin and code only). Run it in the
 * transaction that moves the task to `failed`.
 */
export async function recordFailure(sql: Queryable, taskId: string, failure: Failure): Promise<void> {
  const clean = cleanFailure(failure.origin, failure.code, failure.details);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO task_errors (task_id, origin, code, details, label)
    SELECT id, ${clean.origin}, ${clean.code}, ${sql.json(clean.details)}, effective_label FROM tasks WHERE id = ${taskId}
    RETURNING id::text`;
  if (row === undefined) throw new Error(`task ${taskId} does not exist`);
  await appendEvent(sql, { kind: 'task.failed', taskId, label: 'L0', payload: { origin: clean.origin, code: clean.code } });
}

/** The latest failure of a task, or undefined if it never failed with a recorded error. */
export async function loadFailure(sql: Queryable, taskId: string): Promise<StoredFailure | undefined> {
  const [row] = await sql<StoredFailure[]>`
    SELECT id::text, task_id::text AS "taskId", ts, origin, code, details, label
    FROM task_errors WHERE task_id = ${taskId}
    ORDER BY task_errors.id DESC LIMIT 1`;
  return row;
}
