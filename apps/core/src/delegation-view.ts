import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Project } from '@arianna/config';
import type { FileChange } from '@arianna/executors';
import { isAtMost, isLabel } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import type { Queryable } from './db/client.ts';

/**
 * "Who did what" and "Files changed" under the answers written in the cloud
 * (D-082). Metadata only: executor, alias and the model that actually ran
 * (event `executor.model`), time, cost, the files of the run. Never the text
 * of a brief or a report. A file is shown by reading the approved project
 * folder again, in read only, as it is now.
 */

/** Under one assistant message: who wrote it, on what, in how long. */
export interface MessageCredit {
  messageId: string;
  /** The delegation whose report this is; null for Claude answering directly (D-064). */
  delegationId: string | null;
  /** `coder` for a report; null when the message is Arianna's task answered by Claude. */
  agent: string | null;
  executor: string | null;
  /** The router alias (`sonnet`, `opus`, `fable`). */
  alias: string | null;
  /** The model the binary reported at start (`claude-sonnet-…`), when it did. */
  model: string | null;
  /** From start to end of the run; null while it runs. */
  durationMs: number | null;
  /** Euro beyond the subscription; null when zero. */
  cost: number | null;
  /** The project of the delegation. */
  repo: string | null;
  /** Null when not recorded. */
  files: FileChange[] | null;
}

interface CreditRow extends Omit<MessageCredit, 'durationMs' | 'cost'> {
  durationMs: string | number | null;
  cost: string | number | null;
}

const toNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));
const toCost = (value: string | number | null): number | null => {
  const cost = toNumber(value);
  return cost === null || !Number.isFinite(cost) || cost <= 0 ? null : cost;
};

// The run of a message: the delegation's, or the run in the message.created event (Claude direct).
const RUN_FIELDS = `
  r.executor AS "runExecutor",
  (SELECT e.payload ->> 'model' FROM events e
    WHERE e.task_id = r.task_id AND e.run_id = r.id AND e.kind = 'executor.model'
    ORDER BY e.id DESC LIMIT 1) AS model,
  CASE WHEN r.ended_at IS NULL THEN NULL ELSE round(extract(epoch FROM r.ended_at - r.started_at) * 1000) END AS "durationMs",
  r.cost_estimate AS cost`;

const MAX_CREDITS = 500;
/** A delegation whose brief and result are at L1 or below: the only ones whose project and files are shown. */
const AT_MOST_L1 = `(d.label <= 'L1' AND (d.result_label IS NULL OR d.result_label <= 'L1'))`;

/** The credits of the latest assistant messages of a conversation written in the cloud. */
export async function listCredits(sql: Queryable, conversationId: string): Promise<MessageCredit[]> {
  const rows = await sql.unsafe<(CreditRow & { runExecutor: string | null })[]>(
    `WITH written AS (
       SELECT m.id, m.task_id, m.agent, m.model FROM messages m
       WHERE m.conversation_id = $1 AND m.role = 'assistant' AND (m.agent IS NOT NULL OR m.model IS NOT NULL)
       ORDER BY m.id DESC LIMIT $2
     )
     SELECT w.id::text AS "messageId", d.id::text AS "delegationId", w.agent,
       coalesce(d.executor, CASE WHEN w.model IS NOT NULL THEN 'claude' END) AS executor,
       coalesce(d.model, r.model, w.model) AS alias,
       ${RUN_FIELDS},
       CASE WHEN ${AT_MOST_L1} THEN d.repo END AS repo,
       CASE WHEN ${AT_MOST_L1} THEN d.files END AS files
     FROM written w
     LEFT JOIN task_delegations d ON d.message_id = w.id
     LEFT JOIN LATERAL (
       SELECT ev.run_id FROM events ev
       WHERE ev.task_id = w.task_id AND ev.kind = 'message.created' AND ev.payload ->> 'messageId' = w.id::text
       ORDER BY ev.id LIMIT 1
     ) created ON true
     LEFT JOIN runs r ON r.id = coalesce(d.run_id, created.run_id)
     ORDER BY w.id`,
    [conversationId, MAX_CREDITS],
  );
  return rows.map(({ runExecutor, durationMs, cost, executor, ...row }) => ({
    ...row,
    executor: executor ?? runExecutor,
    durationMs: toNumber(durationMs),
    cost: toCost(cost),
  }));
}

/** A row of "Deleghe recenti": metadata of the delegation, never the brief or the report. */
export interface RecentDelegation {
  id: string;
  conversationId: string | null;
  /** Only for a conversation at L1 or below (a work one). */
  conversationTitle: string | null;
  agent: string;
  repo: string | null;
  status: string;
  executor: string | null;
  alias: string | null;
  model: string | null;
  createdAt: Date;
  durationMs: number | null;
  cost: number | null;
  /** How many files the run changed; null when not recorded. */
  files: number | null;
}

/**
 * The latest delegations at L1 or below (a brief above it waits for a
 * declassification and is not listed until lowered; a private conversation
 * has no cloud delegation anyway).
 */
export async function listRecentDelegations(sql: Queryable, limit: number): Promise<RecentDelegation[]> {
  const rows = await sql.unsafe<(Omit<RecentDelegation, 'durationMs' | 'cost'> & { durationMs: string | number | null; cost: string | number | null; runExecutor: string | null })[]>(
    `SELECT d.id::text, t.conversation_id::text AS "conversationId",
       CASE WHEN c.clearance <= 'L1' THEN c.title END AS "conversationTitle",
       d.agent, d.repo, d.status, d.executor, d.model AS alias,
       ${RUN_FIELDS},
       d.created_at AS "createdAt",
       CASE WHEN d.files IS NULL THEN NULL ELSE jsonb_array_length(d.files) END AS files
     FROM task_delegations d
     JOIN tasks t ON t.id = d.task_id
     LEFT JOIN conversations c ON c.id = t.conversation_id
     LEFT JOIN runs r ON r.id = d.run_id
     WHERE ${AT_MOST_L1}
     ORDER BY d.id DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(({ runExecutor, durationMs, cost, executor, ...row }) => ({
    ...row,
    executor: executor ?? runExecutor,
    durationMs: toNumber(durationMs),
    cost: toCost(cost),
  }));
}

/** Largest file shown in the chat. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

export type DelegationFileErrorCode = 'not-found' | 'deleted' | 'not-approved' | 'refused' | 'too-large' | 'binary' | 'archived';

export class DelegationFileError extends Error {
  override name = 'DelegationFileError';
  readonly code: DelegationFileErrorCode;

  constructor(code: DelegationFileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the chat shows of a changed file: its current version, read only. */
export interface FilePreview {
  path: string;
  change: FileChange['change'];
  repo: string;
  size: number;
  /** The file as it is now: it may have changed after the run. */
  text: string;
}

const isGitName = (part: string): boolean => part.toLowerCase() === '.git';

function inside(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

/**
 * Reads the file `index` of a delegation from its project folder (D-082): the
 * project must still be approved (D-058) at L1 or below, its folder exactly
 * the approved path (no link on the way); the file inside it after resolving
 * links, not under `.git`, a regular file of at most MAX_PREVIEW_BYTES, UTF-8
 * text without NUL, and without a value of the vault.
 */
export async function readDelegationFile(sql: Queryable, projects: readonly Project[], id: string, index: number): Promise<FilePreview> {
  const [row] = await sql.unsafe<{ repo: string | null; files: FileChange[] | null; label: string; resultLabel: string | null; archived: boolean }[]>(
    `SELECT d.repo, d.files, d.label, d.result_label AS "resultLabel", coalesce(c.archived_at IS NOT NULL, false) AS archived
     FROM task_delegations d JOIN tasks t ON t.id = d.task_id LEFT JOIN conversations c ON c.id = t.conversation_id
     WHERE d.id = $1::bigint`,
    [id],
  );
  if (row === undefined || row.files === null || row.repo === null) throw new DelegationFileError('not-found', 'no such file');
  // Like a retry (D-064): an archived conversation is history, restored before anything is done from it.
  if (row.archived) throw new DelegationFileError('archived', 'the conversation is archived: restore it to see the files');
  if (!isLabel(row.label) || !isAtMost(row.label, 'L1') || (row.resultLabel !== null && (!isLabel(row.resultLabel) || !isAtMost(row.resultLabel, 'L1')))) {
    throw new DelegationFileError('not-found', 'no such file');
  }
  const entry = row.files[index];
  if (entry === undefined) throw new DelegationFileError('not-found', 'no such file');
  if (entry.change === 'deleted') throw new DelegationFileError('deleted', 'the run deleted this file');
  const project = projects.find((candidate) => candidate.name === row.repo);
  if (project === undefined) throw new DelegationFileError('not-approved', `the project ${row.repo} is no longer among the approved projects`);
  if (!isAtMost(project.label, 'L1')) throw new DelegationFileError('not-approved', `the project ${row.repo} is above L1`);

  const { absolute } = project;
  let root: string;
  try {
    root = await realpath(absolute);
  } catch {
    throw new DelegationFileError('not-approved', `the folder of ${row.repo} does not exist`);
  }
  if (!isAbsolute(absolute) || resolve(absolute) !== absolute || root !== absolute || !(await lstat(root)).isDirectory()) {
    throw new DelegationFileError('not-approved', `the folder of ${row.repo} is not the approved path`);
  }
  const path = entry.path;
  if (path === '' || isAbsolute(path) || path.includes('\0') || path.split('/').some((part) => part === '..' || isGitName(part))) {
    throw new DelegationFileError('refused', 'the path is not a file of the project');
  }
  const candidate = join(root, path);
  if (!inside(candidate, root)) throw new DelegationFileError('refused', 'the path is not a file of the project');
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new DelegationFileError('deleted', 'the file is no longer there');
  }
  // A link may point anywhere: only what stays inside the project, and never into .git.
  // `.git` in any case: on a case-insensitive disk `.GIT/config` is the git configuration.
  if (!inside(real, root) || relative(root, real).split(sep).some(isGitName)) {
    throw new DelegationFileError('refused', 'the file leads out of the project');
  }
  // A fifo or a device would block the read or never end: only a regular file is opened, without waiting.
  const before = await lstat(real).catch(() => undefined);
  if (before === undefined) throw new DelegationFileError('deleted', 'the file is no longer there');
  if (!before.isFile()) throw new DelegationFileError('refused', 'not a regular file');
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (handle === undefined) throw new DelegationFileError('refused', 'the file cannot be opened');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new DelegationFileError('refused', 'not a regular file');
    // Swapped between the checks and the open (a link, another file): refused.
    const now = await lstat(real).catch(() => undefined);
    const again = await realpath(real).catch(() => undefined);
    if (now === undefined || again !== real || now.dev !== stats.dev || now.ino !== stats.ino || before.dev !== stats.dev || before.ino !== stats.ino) {
      throw new DelegationFileError('refused', 'the file changed while it was opened');
    }
    if (stats.size > MAX_PREVIEW_BYTES) throw new DelegationFileError('too-large', `the file is larger than ${String(MAX_PREVIEW_BYTES / 1024)} KiB`);
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PREVIEW_BYTES) throw new DelegationFileError('too-large', `the file is larger than ${String(MAX_PREVIEW_BYTES / 1024)} KiB`);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new DelegationFileError('binary', 'not a text file');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new DelegationFileError('binary', 'not a UTF-8 text file');
    }
    if (knownSecrets.find(text).length > 0) throw new DelegationFileError('refused', 'the file holds a value of the vault');
    return { path, change: entry.change, repo: row.repo, size: bytesRead, text };
  } finally {
    await handle.close();
  }
}
