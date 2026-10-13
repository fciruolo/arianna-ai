import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { isToolId, type ToolId } from '@arianna/agents';
import type { CatalogEntry, LocalEndpointConfig, ModelCatalog } from '@arianna/config';
import {
  casesFingerprint,
  createOrchestratorGroup,
  loadCases,
  runGroup,
  TRIAL_ALIAS,
  trialEndpoints,
  type CaseResult,
  type EvalCase,
  type GroupReport,
  type OrchestratorActual,
} from '@arianna/evals/library';
import type { LocalModel } from '@arianna/executors';

import type { Queryable, Sql } from './db/client.ts';
import { STEP_QUEUE } from './engine.ts';
import { appendEvent } from './events.ts';
import { completeJob, createJobQueue, enqueueJob, errorCode, failJob, type Job } from './jobs.ts';
import { fileSize, type FileSize } from './voice/trial.ts';

/**
 * Trials of a catalog model with the orchestrator evals, in the background
 * (D-081). The evals run as a library inside the core, on the `model.eval`
 * queue of jobs, one trial at a time, on a model built from the endpoints of
 * arianna.toml with `local-large` pointing at the candidate. A trial gives
 * way to the user: no case starts while a call or a task step is at work, and
 * a case in progress is cancelled and started again when one begins. The row
 * holds case ids, outcomes, times and error codes, never what the model said.
 * Promotion of the catalog entry is only suggested: the core never writes the
 * catalog (it is in git).
 */
export const EVAL_QUEUE = 'model.eval';
export const EVAL_ROLES = ['orchestrator'] as const;
export type EvalRole = (typeof EVAL_ROLES)[number];
export const EVAL_STATUSES = ['queued', 'running', 'passed', 'failed', 'error', 'cancelled'] as const;
export type EvalStatus = (typeof EVAL_STATUSES)[number];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The weights of a catalog entry, as one hash: sha256 of the lines
 * `<path> <sha256>\n` of its files, sorted. "According to the catalog": the
 * files on disk are not hashed again (that is `pnpm arianna:models verify`).
 */
export function weightsDigest(entry: Pick<CatalogEntry, 'files'>): string {
  return sha256(
    entry.files
      .map((file) => `${file.path} ${file.sha256}\n`)
      .sort()
      .join(''),
  );
}

export type CandidateCheck =
  | { ok: true; entry: CatalogEntry }
  | { ok: false; code: 'not-in-catalog' | 'role' | 'files-missing' };

/** A model can be tried for a role when the catalog has it, lists the role and its files are in `modelsDir/<id>` with the right size. */
export function checkCandidate(catalog: ModelCatalog, modelId: string, role: EvalRole, modelsDir: string, size: FileSize = fileSize): CandidateCheck {
  const entry = catalog.models.find((model) => model.id === modelId);
  if (entry === undefined) return { ok: false, code: 'not-in-catalog' };
  if (!entry.roles.includes(role)) return { ok: false, code: 'role' };
  if (!entry.files.every((file) => size(join(modelsDir, entry.id, file.path)) === file.sizeBytes)) return { ok: false, code: 'files-missing' };
  return { ok: true, entry };
}

/** What the model chose in a case, in closed values (D-199): `unreadable` when the answer did not follow the schema. */
export const CASE_ACTIONS = ['call', 'reply', 'plan', 'refuse', 'unreadable'] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];

export interface EvalCaseRow {
  id: string;
  passed: boolean;
  ms: number;
  /** A code, like `last_error` of jobs: never the message. */
  error?: string;
  /** The kind of action chosen (D-199); absent for an error and for the trials before. */
  action?: CaseAction;
  /** The tool of a `call`, only when the registry knows it: never a name the model made up. */
  tool?: ToolId;
  /** ms to the first piece of text, tokens written and ms spent writing them (D-199): only what the server measured. */
  firstMs?: number;
  tokens?: number;
  genMs?: number;
}

export interface EvalMeasure {
  name: string;
  total: number;
  passed: number;
  rate: number;
  threshold: number;
}

export interface EvalOutcome {
  status: 'passed' | 'failed';
  total: number;
  passed: number;
  measures: EvalMeasure[];
  latencyMedianMs: number;
  latencyMaxMs: number;
  reasons: string[];
  cases: EvalCaseRow[];
  /** D-199: null when no case was measured (a server without token counts). */
  tokensPerSecond: number | null;
  firstTokenMs: number | null;
}

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

/** A case as the row keeps it: id, outcome, time, error code, and the closed values of the answer (D-199). */
export function caseRow(result: Pick<CaseResult, 'id' | 'passed' | 'durationMs' | 'errorCode' | 'actual' | 'error'>): EvalCaseRow {
  const row: EvalCaseRow = { id: result.id, passed: result.passed, ms: Math.round(result.durationMs) };
  if (result.errorCode !== undefined) row.error = result.errorCode;
  const actual = result.actual as Partial<OrchestratorActual> | undefined;
  if (result.error !== undefined || typeof actual !== 'object') return row;
  // Only the closed values of the answer: the arguments and any text stay out.
  const action: CaseAction = actual.schemaOk !== true || actual.action === undefined || actual.action === 'invalid' ? 'unreadable' : actual.action;
  row.action = action;
  if (action === 'call' && isToolId(actual.tool)) row.tool = actual.tool;
  const firstMs = count(actual.speed?.firstTextMs);
  const tokens = count(actual.speed?.tokens);
  const genMs = count(actual.speed?.generationMs);
  if (firstMs !== undefined) row.firstMs = firstMs;
  if (tokens !== undefined) row.tokens = tokens;
  if (genMs !== undefined) row.genMs = genMs;
  return row;
}

/**
 * The speed of a trial from its cases (D-199): tokens per second while
 * writing (all the tokens over all the writing time of the cases that have
 * both), and the mean wait for the first piece of text. Null when nothing was
 * measured: an old trial, or a server without token counts.
 */
export function speedSummary(cases: readonly EvalCaseRow[]): { tokensPerSecond: number | null; firstTokenMs: number | null } {
  const timed = cases.filter((item) => item.error === undefined);
  const firsts = timed.flatMap((item) => (item.firstMs === undefined ? [] : [item.firstMs]));
  let tokens = 0;
  let ms = 0;
  for (const item of timed) {
    if (item.tokens === undefined || item.genMs === undefined || item.tokens === 0 || item.genMs === 0) continue;
    tokens += item.tokens;
    ms += item.genMs;
  }
  const rate = ms === 0 ? null : Math.round((tokens / (ms / 1000)) * 100) / 100;
  return {
    tokensPerSecond: rate !== null && rate > 0 && rate < 100_000 ? rate : null,
    firstTokenMs: firsts.length === 0 ? null : Math.round(firsts.reduce((sum, value) => sum + value, 0) / firsts.length),
  };
}

/** What a report leaves in the database: never `actual` nor an error message, which may quote the model. */
export function rowFromReport(report: GroupReport): EvalOutcome {
  if (report.status === 'pending') throw new Error('a pending group has no outcome');
  const cases = report.results.map(caseRow);
  return {
    status: report.status,
    total: report.total,
    passed: report.passed,
    measures: report.measures.map(({ name, total, passed, rate, threshold }) => ({ name, total, passed, rate, threshold })),
    latencyMedianMs: Math.round(report.latency.medianMs),
    latencyMaxMs: Math.round(report.latency.maxMs),
    reasons: [...report.reasons],
    cases,
    ...speedSummary(cases),
  };
}

/** What a row keeps of the catalog entry when the trial is asked (D-199): readable after the model is gone. */
export interface CatalogCopy {
  name: string;
  provider: string | null;
  sizeBytes: number;
  quantization: string | null;
  ramMinGib: number;
}

/** Words of a model name that say how it is stored, not what it is. */
const STORAGE_WORD = /^(\d+-?bits?|mlx|gguf|q\d(_[a-z0-9]+)*|b?f16|fp16|fp8|int[48]|awq|gptq)$/i;

/**
 * A readable name: the last part of the page of the model when there is one
 * (Qwen3.8-27B-Uncensored-MLX), else the id; without the storage words, with
 * the sizes in capitals and spaces between the words: "Qwen3.8 27B Uncensored".
 */
export function readableName(entry: Pick<CatalogEntry, 'id' | 'source'>): string {
  let base = entry.id;
  if (entry.source !== undefined) {
    try {
      const last = new URL(entry.source).pathname.split('/').filter((part) => part !== '').at(-1);
      if (last !== undefined && /^[\w.-]{2,120}$/.test(last)) base = last;
    } catch {
      // Not a URL: the id.
    }
  }
  const words = base.split(/[-_ ]+/).filter((word) => word !== '' && !STORAGE_WORD.test(word));
  const parts: string[] = [];
  for (const [index, word] of words.entries()) {
    const shown = /^a?\d+(\.\d+)?[bm]$/i.test(word) ? word.toUpperCase() : index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    // 35B-A3B: the active parameters stay with the total.
    const previous = parts.at(-1);
    if (/^A\d+(\.\d+)?B$/.test(shown) && previous !== undefined) parts[parts.length - 1] = `${previous}-${shown}`;
    else parts.push(shown);
  }
  const name = parts.join(' ').slice(0, 200);
  return name === '' ? entry.id : name;
}

/** "4bit", "Q4_K_M", "bf16" from the id or the page of the model; null when neither says it. */
export function quantizationOf(entry: Pick<CatalogEntry, 'id' | 'source'>): string | null {
  for (const text of [entry.id, entry.source ?? '']) {
    const bits = /(?:^|[-_/])(\d{1,2})-?bits?(?:$|[-_/])/i.exec(text);
    if (bits?.[1] !== undefined) return `${bits[1]}bit`;
    const gguf = /(?:^|[-_/.])(q\d(?:_[a-z0-9]+)*)(?:$|[-_/.])/i.exec(text);
    if (gguf?.[1] !== undefined) return gguf[1].toUpperCase().slice(0, 24);
    const float = /(?:^|[-_/])(bf16|fp16|fp8|int4|int8)(?:$|[-_/])/i.exec(text);
    if (float?.[1] !== undefined) return float[1].toLowerCase();
  }
  return null;
}

/** No control characters in a text the database keeps (the CHECK of 0060 refuses them). */
const plain = (text: string): string => text.replace(/\p{Cc}/gu, ' ').trim().slice(0, 200);

export function catalogCopy(entry: CatalogEntry): CatalogCopy {
  const provider = entry.provider === undefined ? '' : plain(entry.provider);
  const name = plain(readableName(entry));
  return {
    name: name === '' ? entry.id : name,
    provider: provider === '' ? null : provider,
    sizeBytes: entry.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    quantization: quantizationOf(entry),
    ramMinGib: entry.ramMinGib,
  };
}

/** A call in progress or a task step at work or ready: the machine belongs to the user. */
export async function machineBusy(sql: Queryable): Promise<boolean> {
  const [row] = await sql<{ busy: boolean }[]>`
    SELECT EXISTS (SELECT FROM calls WHERE status IN ('ringing', 'connecting', 'active'))
        OR EXISTS (SELECT FROM jobs WHERE queue = ${STEP_QUEUE}
                   AND (status = 'running' OR (status = 'queued' AND run_at <= now()))) AS busy`;
  return row?.busy === true;
}

export interface ModelEvalRow {
  id: string;
  modelId: string;
  role: EvalRole;
  weightsSha256: string | null;
  catalogStatus: string;
  casesSha256: string | null;
  promptSha256: string | null;
  status: EvalStatus;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  total: number | null;
  passed: number | null;
  /** Cases finished so far (all of them once the trial is over). */
  done: number;
  measures: EvalMeasure[] | null;
  latencyMedianMs: number | null;
  latencyMaxMs: number | null;
  reasons: string[] | null;
  preemptions: number;
  error: string | null;
  /** D-199: null for the trials before, and when nothing was measured. */
  tokensPerSecond: number | null;
  firstTokenMs: number | null;
  /** D-199: the catalog entry when the trial was asked; null for the trials before. */
  modelName: string | null;
  modelProvider: string | null;
  modelSizeBytes: number | null;
  modelQuantization: string | null;
  modelRamMinGib: number | null;
  cases?: EvalCaseRow[] | null;
}

const COLUMNS = `id::text, model_id AS "modelId", role, weights_sha256 AS "weightsSha256", catalog_status AS "catalogStatus",
  cases_sha256 AS "casesSha256", prompt_sha256 AS "promptSha256", status, requested_at AS "requestedAt",
  started_at AS "startedAt", finished_at AS "finishedAt", total, passed, coalesce(jsonb_array_length(cases), 0) AS done,
  measures, latency_median_ms AS "latencyMedianMs", latency_max_ms AS "latencyMaxMs", reasons, preemptions, error,
  tokens_per_second AS "tokensPerSecond", first_token_ms AS "firstTokenMs", model_name AS "modelName",
  model_provider AS "modelProvider", model_size_bytes::float8 AS "modelSizeBytes", model_quantization AS "modelQuantization",
  model_ram_min_gib AS "modelRamMinGib"`;

export class ModelEvalError extends Error {
  override name = 'ModelEvalError';
  readonly code: 'not-found' | 'invalid' | 'conflict';

  constructor(code: ModelEvalError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export async function listModelEvals(sql: Queryable, options: { modelId?: string; limit: number }): Promise<ModelEvalRow[]> {
  const rows = await sql.unsafe<ModelEvalRow[]>(
    `SELECT ${COLUMNS} FROM model_evals WHERE ($1::text IS NULL OR model_id = $1) ORDER BY requested_at DESC, id DESC LIMIT $2`,
    [options.modelId ?? null, options.limit],
  );
  return [...rows];
}

/** A trial in the comparison of a role (D-199): the row, how the model is named now, and where it is. */
export interface ComparisonTrial extends Omit<ModelEvalRow, 'cases'> {
  /** Mean time of a case that did not end in an error; null before any. */
  caseMeanMs: number | null;
  /**
   * The model as the trial copied it from the catalog (`trial`); for a trial
   * before D-199, from the catalog of today when it is still there
   * (`catalog`), else only its id (`id`).
   */
  model: { name: string; provider: string | null; sizeBytes: number | null; quantization: string | null; ramMinGib: number | null; from: 'trial' | 'catalog' | 'id' };
  inCatalog: boolean;
  /** Its files are in data/models with the size of the catalog. */
  present: boolean;
  /** The model the role uses now: the reference. */
  inUse: boolean;
  /** Measured on the questions of today (`cases_sha256` of evals/orchestrator now). */
  currentQuestions: boolean;
}

export interface Comparison {
  role: EvalRole;
  /** The model of the role now, for «Prova di riferimento»; null when the role has none. */
  inUse: { modelId: string; name: string; inCatalog: boolean; present: boolean } | null;
  /** The fingerprint of the questions of today, and how many they are. */
  casesSha256: string;
  questions: number;
  /** Every trial of the role, newest first, of models in the catalog or not (never deleted, D-046). */
  trials: ComparisonTrial[];
}

export interface ComparisonContext {
  role: EvalRole;
  catalog: ModelCatalog;
  inUse: string | undefined;
  present: (entry: CatalogEntry) => boolean;
  casesSha256: string;
  questions: number;
}

/** The comparison of a role from its rows (pure: the database and the disk are read by the caller). */
export function comparisonOf(rows: readonly (Omit<ModelEvalRow, 'cases'> & { caseMeanMs: number | null })[], context: ComparisonContext): Comparison {
  const entries = new Map(context.catalog.models.map((entry) => [entry.id, entry]));
  const presence = new Map<string, boolean>();
  const isPresent = (entry: CatalogEntry | undefined): boolean => {
    if (entry === undefined) return false;
    let known = presence.get(entry.id);
    if (known === undefined) {
      known = context.present(entry);
      presence.set(entry.id, known);
    }
    return known;
  };
  const trials = rows.map((row): ComparisonTrial => {
    const entry = entries.get(row.modelId);
    const now = entry === undefined ? undefined : catalogCopy(entry);
    const model: ComparisonTrial['model'] =
      row.modelName !== null
        ? { name: row.modelName, provider: row.modelProvider, sizeBytes: row.modelSizeBytes, quantization: row.modelQuantization, ramMinGib: row.modelRamMinGib, from: 'trial' }
        : now !== undefined
          ? { ...now, from: 'catalog' }
          : { name: row.modelId, provider: null, sizeBytes: null, quantization: null, ramMinGib: null, from: 'id' };
    return {
      ...row,
      model,
      inCatalog: entry !== undefined,
      present: isPresent(entry),
      inUse: context.inUse === row.modelId,
      currentQuestions: row.casesSha256 === context.casesSha256,
    };
  });
  const used = context.inUse === undefined ? undefined : entries.get(context.inUse);
  return {
    role: context.role,
    inUse:
      context.inUse === undefined
        ? null
        : { modelId: context.inUse, name: used === undefined ? context.inUse : readableName(used), inCatalog: used !== undefined, present: isPresent(used) },
    casesSha256: context.casesSha256,
    questions: context.questions,
    trials,
  };
}

/** A fake question of evals/orchestrator by its id: its first request of the user and its capability (D-199). */
export interface CaseQuestion {
  text: string | null;
  capability: string | null;
}

const CAPABILITIES = ['tool', 'refusal', 'recovery', 'plan'] as const;

/** The questions of a group folder by id: the first message of the user (invented, L0), cut at 300 characters. */
export function questionsOf(cases: readonly EvalCase[]): Map<string, CaseQuestion> {
  const questions = new Map<string, CaseQuestion>();
  for (const item of cases) {
    const messages = (item.input as { messages?: unknown } | null)?.messages;
    const first = Array.isArray(messages) ? (messages as { role?: unknown; content?: unknown }[]).find((message) => message.role === 'user') : undefined;
    const text = typeof first?.content === 'string' ? first.content.slice(0, 300) : null;
    questions.set(item.id, { text, capability: CAPABILITIES.find((tag) => item.tags.includes(tag)) ?? null });
  }
  return questions;
}

/** Trials compared question by question only when they ran on the same questions. */
export function sameQuestions(rows: readonly Pick<ModelEvalRow, 'casesSha256'>[]): boolean {
  const first = rows[0]?.casesSha256;
  return first !== undefined && first !== null && rows.every((row) => row.casesSha256 === first);
}

export interface ComparedCase {
  id: string;
  text: string | null;
  capability: string | null;
  /** One per trial, in the order asked; null when that trial has no such case. */
  results: (Pick<EvalCaseRow, 'passed' | 'action' | 'tool' | 'error'> | null)[];
}

export interface CaseComparison {
  ids: string[];
  /** The questions of the trials. */
  total: number;
  /** The questions where the trials did not all get the same outcome. */
  differing: ComparedCase[];
}

/** The questions with different outcomes among 2-3 trials on the same questions (pure). */
export function caseComparison(rows: readonly { id: string; cases: readonly EvalCaseRow[] }[], questions: ReadonlyMap<string, CaseQuestion>): CaseComparison {
  const order: string[] = [];
  for (const row of rows) for (const item of row.cases) if (!order.includes(item.id)) order.push(item.id);
  const byTrial = rows.map((row) => new Map(row.cases.map((item) => [item.id, item])));
  const differing: ComparedCase[] = [];
  for (const id of order) {
    const results = byTrial.map((cases) => {
      const found = cases.get(id);
      if (found === undefined) return null;
      const { passed, action, tool, error } = found;
      return { passed, ...(action === undefined ? {} : { action }), ...(tool === undefined ? {} : { tool }), ...(error === undefined ? {} : { error }) };
    });
    const outcomes = new Set(results.map((result) => (result === null ? 'none' : String(result.passed))));
    if (outcomes.size < 2) continue;
    const question = questions.get(id);
    differing.push({ id, text: question?.text ?? null, capability: question?.capability ?? null, results });
  }
  return { ids: rows.map((row) => row.id), total: order.length, differing };
}

export async function loadModelEval(sql: Queryable, id: string): Promise<ModelEvalRow | undefined> {
  const [row] = await sql.unsafe<ModelEvalRow[]>(`SELECT ${COLUMNS}, cases FROM model_evals WHERE id = $1::bigint`, [id]);
  return row;
}

/** A trial of the model queued or running: its files must stay where they are (I-3, M4). */
export async function trialOpen(sql: Queryable, modelId: string): Promise<boolean> {
  const [row] = await sql<{ open: boolean }[]>`
    SELECT EXISTS (SELECT FROM model_evals WHERE model_id = ${modelId} AND status IN ('queued', 'running')) AS open`;
  return row?.open === true;
}

/** Closes a trial with its status and code; false when it was already closed. */
async function closeTrial(tx: Queryable, id: string, modelId: string, status: 'error' | 'cancelled', code: string): Promise<boolean> {
  const rows = await tx`
    UPDATE model_evals SET status = ${status}, error = ${code}, finished_at = now()
    WHERE id = ${id}::bigint AND status IN ('queued', 'running') RETURNING id`;
  if (rows.length === 0) return false;
  await appendEvent(tx, { kind: 'model_eval.finished', label: 'L0', payload: { evalId: id, modelId, status, error: code } });
  return true;
}

export interface ModelEvalsOptions {
  sql: Sql;
  /** Read at each request and each trial: a new entry needs no restart. */
  catalog: () => ModelCatalog;
  /** data/models. */
  modelsDir: string;
  /** The endpoints of the current arianna.toml. */
  endpoints: () => readonly LocalEndpointConfig[];
  /**
   * The models assigned to a role now (orchestrator, extractor, voice, stt,
   * tts...): a candidate among them is never unloaded, someone uses it.
   */
  assignedModels: () => readonly string[];
  /** The model `[roles]` gives a role now: the reference of the comparison (D-199). */
  roleModel?: (role: EvalRole) => string | undefined;
  /** The orchestrator's prompt (agents/arianna.md). */
  prompt: () => string;
  /** evals/orchestrator. */
  casesDir: string;
  /** The local model over the trial endpoints, with the health of the watchdogs like the normal one. */
  createModel: (endpoints: LocalEndpointConfig[]) => LocalModel;
  /** Default: a call in progress or a task step at work or ready. */
  busy?: () => Promise<boolean>;
  size?: FileSize;
  workerId?: string;
  /** A job not refreshed for this long belongs to a dead worker. Default 60 s, like the task worker. */
  lockTimeoutMs?: number;
  /** Pause when the queue is empty. Default 2 s. */
  pollMs?: number;
  /** While the machine is busy, how often to look again before a case. Default 5 s. */
  freeCheckMs?: number;
  /** During a case, how often to look whether the machine is wanted. Default 2 s. */
  watchMs?: number;
  /** A case cancelled more than this many times ends the trial as cancelled. Default 3. */
  maxPreemptions?: number;
  /** How long `stop()` waits for the trial to close. Default 10 s. */
  stopGraceMs?: number;
  onError?: (error: unknown) => void;
}

export interface ModelEvals {
  /** Queues a trial; the id of the row. */
  request(modelId: string, role: string): Promise<string>;
  list(options: { modelId?: string; limit: number }): Promise<ModelEvalRow[]>;
  get(id: string): Promise<ModelEvalRow | undefined>;
  cancel(id: string): Promise<ModelEvalRow>;
  /** Every trial of a role with the model in use as reference (D-199). */
  compare(role: string): Promise<Comparison>;
  /** The questions with different outcomes among 2-3 finished trials on the same questions (D-199). */
  compareCases(ids: readonly string[]): Promise<CaseComparison>;
  /** Closes the trials a previous run left running, then consumes the queue. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

type StopReason = 'user' | 'preempted' | 'interrupted' | 'lock-lost';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

function isRole(value: unknown): value is EvalRole {
  return EVAL_ROLES.some((role) => role === value);
}

/** The questions of the folder today; none when it cannot be read (the comparison still shows, without texts). */
function readCases(dir: string): EvalCase[] {
  try {
    return loadCases(dir);
  } catch {
    return [];
  }
}

function countCases(dir: string): number {
  return readCases(dir).length;
}

export function createModelEvals(options: ModelEvalsOptions): ModelEvals {
  const { sql } = options;
  const queue = createJobQueue(sql);
  const worker = options.workerId ?? `model-evals-${randomUUID()}`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const busy = options.busy ?? (() => machineBusy(sql));
  const size = options.size ?? fileSize;
  const maxPreemptions = options.maxPreemptions ?? 3;
  const onError = options.onError ?? (() => undefined);
  const controller = new AbortController();
  /** The trial in progress, to cancel it. */
  let current: { id: string; stop: (reason: StopReason) => void } | undefined;
  let loop: Promise<void> | undefined;

  /** Waits for a free machine; `onBusy` once, as soon as it is found busy (the candidate leaves the memory). */
  async function waitFree(signal: AbortSignal, onBusy: () => Promise<void>): Promise<void> {
    let told = false;
    while (!signal.aborted && (await busy())) {
      if (!told) {
        told = true;
        await onBusy();
      }
      await sleep(options.freeCheckMs ?? 5_000, signal);
    }
  }

  async function handle(job: Job): Promise<void> {
    const evalId = typeof job.payload.evalId === 'string' ? job.payload.evalId : undefined;
    const row = evalId === undefined ? undefined : await loadModelEval(sql, evalId);
    if (row === undefined || row.status !== 'queued') {
      // Cancelled while queued, or a malformed job: nothing to do.
      await queue.complete(job.id, worker);
      return;
    }
    const id = row.id;
    const check = isRole(row.role) ? checkCandidate(options.catalog(), row.modelId, row.role, options.modelsDir, size) : ({ ok: false, code: 'role' } as const);
    const endpoints = trialEndpoints(options.endpoints(), row.modelId);
    const refusal = !check.ok ? check.code : endpoints.length === 0 ? 'no-endpoint' : undefined;
    if (refusal !== undefined) {
      await sql.begin(async (tx) => {
        await closeTrial(tx, id, row.modelId, 'error', refusal);
        await completeJob(tx, job.id, worker);
      });
      return;
    }

    // Heartbeat at a third of the timeout, like the task worker: a trial lasts as long as its cases.
    const stopper = new AbortController();
    let reason: StopReason | undefined;
    const stop = (why: StopReason): void => {
      reason ??= why;
      stopper.abort(new Error(`trial stopped: ${why}`));
    };
    current = { id, stop };
    let lastBeat = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - lastBeat > lockTimeoutMs) stop('lock-lost');
      queue
        .heartbeat(job.id, worker)
        .then((held) => {
          if (held) lastBeat = Date.now();
          else stop('lock-lost');
        })
        .catch(onError);
    }, Math.max(10, Math.floor(lockTimeoutMs / 3)));
    const onStopping = (): void => {
      stop('interrupted');
    };
    controller.signal.addEventListener('abort', onStopping, { once: true });
    if (controller.signal.aborted) stop('interrupted');

    let model: LocalModel | undefined;
    // The candidate may be in the memory of the server since a case started.
    let loaded = false;
    const release = async (): Promise<void> => {
      if (!loaded || model?.unload === undefined || options.assignedModels().includes(row.modelId)) return;
      loaded = false;
      await model.unload(TRIAL_ALIAS).catch(onError);
    };
    let progress: Promise<unknown> = Promise.resolve();
    try {
      const prompt = options.prompt();
      const cases = loadCases(options.casesDir);
      const started = await sql`
        UPDATE model_evals SET status = 'running', started_at = now(), total = ${cases.length}, passed = 0, cases = '[]'::jsonb,
          cases_sha256 = ${casesFingerprint(options.casesDir)}, prompt_sha256 = ${sha256(prompt)}
        WHERE id = ${id}::bigint AND status = 'queued' RETURNING id`;
      if (started.length === 0) {
        await queue.complete(job.id, worker);
        return;
      }
      model = options.createModel(endpoints);
      // Timed (D-199): each answer is streamed, for the first word and the tokens per second.
      const group = createOrchestratorGroup({ model, prompt, timed: true });
      const kept: EvalCaseRow[] = [];
      let preemptions = 0;
      let casePreemptions = 0;
      const report = await runGroup(group, cases, {
        signal: stopper.signal,
        // The machine goes back to the user with the memory too: the candidate is unloaded before giving way.
        beforeCase: () => waitFree(stopper.signal, release),
        watchCase: () => {
          const attempt = new AbortController();
          loaded = true;
          // Set when the attempt is over: a late answer of `busy` does not count a preemption.
          let finished = false;
          const timer = setInterval(() => {
            busy()
              .then((taken) => {
                if (!taken || finished || attempt.signal.aborted) return;
                attempt.abort(new Error('the machine is wanted'));
                progress = progress.then(release);
                preemptions += 1;
                casePreemptions += 1;
                const count = preemptions;
                progress = progress.then(() => sql`UPDATE model_evals SET preemptions = ${count} WHERE id = ${id}::bigint AND status = 'running'`).catch(onError);
                if (casePreemptions > maxPreemptions) stop('preempted');
              })
              .catch(onError);
          }, options.watchMs ?? 2_000);
          return {
            signal: attempt.signal,
            stop: () => {
              finished = true;
              clearInterval(timer);
            },
          };
        },
        onResult: (result) => {
          casePreemptions = 0;
          kept.push(caseRow(result));
          const snapshot = sql.json(kept.map((item) => ({ ...item })));
          const passed = kept.filter((item) => item.passed).length;
          progress = progress
            .then(() => sql`UPDATE model_evals SET cases = ${snapshot}, passed = ${passed} WHERE id = ${id}::bigint AND status = 'running'`)
            .catch(onError);
        },
      });
      await progress;
      const outcome = rowFromReport(report);
      await sql.begin(async (tx) => {
        const rows = await tx`
          UPDATE model_evals SET status = ${outcome.status}, finished_at = now(), total = ${outcome.total}, passed = ${outcome.passed},
            measures = ${tx.json(outcome.measures.map((measure) => ({ ...measure })))}, latency_median_ms = ${outcome.latencyMedianMs},
            latency_max_ms = ${outcome.latencyMaxMs}, reasons = ${tx.json(outcome.reasons)},
            cases = ${tx.json(outcome.cases.map((item) => ({ ...item })))}, preemptions = ${preemptions},
            tokens_per_second = ${outcome.tokensPerSecond}, first_token_ms = ${outcome.firstTokenMs}
          WHERE id = ${id}::bigint AND status = 'running' RETURNING id`;
        if (rows.length === 1) {
          await appendEvent(tx, {
            kind: 'model_eval.finished',
            label: 'L0',
            payload: { evalId: id, modelId: row.modelId, status: outcome.status, passed: outcome.passed, total: outcome.total },
          });
        }
        await completeJob(tx, job.id, worker);
      });
    } catch (error) {
      await progress;
      const why = reason;
      if (why === undefined) onError(error);
      const code = why ?? errorCode(error);
      // Cancelled by the user or by too many preemptions; any other end is an error.
      const status = why === 'user' || why === 'preempted' ? 'cancelled' : 'error';
      await sql.begin(async (tx) => {
        await closeTrial(tx, id, row.modelId, status, code);
        if (status === 'cancelled') await completeJob(tx, job.id, worker);
        else await failJob(tx, job.id, worker, code, 0);
      });
    } finally {
      clearInterval(beat);
      controller.signal.removeEventListener('abort', onStopping);
      current = undefined;
      // The candidate leaves the memory, unless a role uses it.
      await release();
    }
  }

  async function run(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const job = await queue.claim(EVAL_QUEUE, worker);
        if (job === undefined) {
          await sleep(options.pollMs ?? 2_000, controller.signal);
          continue;
        }
        await handle(job);
      } catch (error) {
        onError(error);
        await sleep(options.pollMs ?? 2_000, controller.signal);
      }
    }
  }

  return {
    async request(modelId, role) {
      if (typeof modelId !== 'string' || modelId === '') throw new ModelEvalError('invalid', 'modelId is required');
      if (!isRole(role)) throw new ModelEvalError('invalid', `role must be one of ${EVAL_ROLES.join(', ')}`);
      const check = checkCandidate(options.catalog(), modelId, role, options.modelsDir, size);
      if (!check.ok) {
        if (check.code === 'not-in-catalog') throw new ModelEvalError('not-found', 'the model is not in the catalog');
        throw new ModelEvalError('conflict', check.code === 'role' ? 'the catalog does not list this role for the model' : 'the files of the model are not in data/models');
      }
      if (trialEndpoints(options.endpoints(), modelId).length === 0) throw new ModelEvalError('conflict', 'no local endpoint in arianna.toml');
      try {
        return await sql.begin(async (tx) => {
          // The catalog entry as it is now (D-199): the row stays readable once the model is gone.
          const copy = catalogCopy(check.entry);
          const [created] = await tx<{ id: string }[]>`
            INSERT INTO model_evals (model_id, role, weights_sha256, catalog_status,
              model_name, model_provider, model_size_bytes, model_quantization, model_ram_min_gib)
            VALUES (${modelId}, ${role}, ${weightsDigest(check.entry)}, ${check.entry.status},
              ${copy.name}, ${copy.provider}, ${copy.sizeBytes}, ${copy.quantization}, ${copy.ramMinGib})
            RETURNING id::text`;
          if (created === undefined) throw new Error('INSERT INTO model_evals returned no row');
          const jobId = await enqueueJob(tx, EVAL_QUEUE, { evalId: created.id }, { key: `model-eval:${modelId}`, maxAttempts: 1 });
          if (jobId === undefined) throw new ModelEvalError('conflict', 'a trial of this model is already queued or running');
          await tx`UPDATE model_evals SET job_id = ${jobId}::bigint WHERE id = ${created.id}::bigint`;
          await appendEvent(tx, { kind: 'model_eval.queued', label: 'L0', payload: { evalId: created.id, modelId, role } });
          return created.id;
        });
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === '23505') throw new ModelEvalError('conflict', 'a trial of this model is already queued or running');
        throw error;
      }
    },

    list: (query) => listModelEvals(sql, query),

    get: (id) => loadModelEval(sql, id),

    async compare(role) {
      if (!isRole(role)) throw new ModelEvalError('invalid', `role must be one of ${EVAL_ROLES.join(', ')}`);
      const rows = await sql.unsafe<(Omit<ModelEvalRow, 'cases'> & { caseMeanMs: number | null })[]>(
        `SELECT ${COLUMNS},
           (SELECT round(avg((c ->> 'ms')::numeric)) FROM jsonb_array_elements(coalesce(cases, '[]'::jsonb)) c
            WHERE c ->> 'error' IS NULL)::int AS "caseMeanMs"
         FROM model_evals WHERE role = $1 ORDER BY requested_at DESC, id DESC LIMIT 1000`,
        [role],
      );
      return comparisonOf(rows, {
        role,
        catalog: options.catalog(),
        inUse: options.roleModel?.(role),
        present: (entry) => entry.files.every((file) => size(join(options.modelsDir, entry.id, file.path)) === file.sizeBytes),
        casesSha256: casesFingerprint(options.casesDir),
        questions: countCases(options.casesDir),
      });
    },

    async compareCases(ids) {
      if (ids.length < 2 || ids.length > 3 || new Set(ids).size !== ids.length || !ids.every((id) => /^[1-9]\d{0,17}$/.test(id))) {
        throw new ModelEvalError('invalid', 'ids must be 2 or 3 different trials');
      }
      const rows: ModelEvalRow[] = [];
      for (const id of ids) {
        const row = await loadModelEval(sql, id);
        if (row === undefined) throw new ModelEvalError('not-found', 'no such trial');
        rows.push(row);
      }
      if (!rows.every((row) => row.status === 'passed' || row.status === 'failed')) throw new ModelEvalError('conflict', 'only finished trials are compared question by question');
      if (!sameQuestions(rows)) throw new ModelEvalError('conflict', 'the trials were not run on the same questions');
      // The questions are read by id from the folder of today: a question gone since has no text.
      return caseComparison(
        rows.map((row) => ({ id: row.id, cases: row.cases ?? [] })),
        questionsOf(readCases(options.casesDir)),
      );
    },

    async cancel(id) {
      const row = await loadModelEval(sql, id);
      if (row === undefined) throw new ModelEvalError('not-found', 'no such trial');
      if (row.status !== 'queued' && row.status !== 'running') throw new ModelEvalError('conflict', `the trial is already ${row.status}`);
      const closed = await sql.begin(async (tx) => {
        if (!(await closeTrial(tx, id, row.modelId, 'cancelled', 'user'))) return false;
        // Its job leaves the queue too: the key frees for a new request.
        await tx`UPDATE jobs SET status = 'done' WHERE queue = ${EVAL_QUEUE} AND payload ->> 'evalId' = ${id} AND status = 'queued'`;
        return true;
      });
      // Running here: the case in progress stops, the worker finds the row closed and only ends its job.
      if (closed && current?.id === id) current.stop('user');
      return (await loadModelEval(sql, id)) ?? row;
    },

    async start() {
      // A trial the previous run left running is not resumed: it is closed, with its job.
      const left = await sql<{ id: string; modelId: string }[]>`
        SELECT id::text, model_id AS "modelId" FROM model_evals WHERE status = 'running' ORDER BY id`;
      for (const { id, modelId } of left) {
        await sql.begin(async (tx) => {
          if (await closeTrial(tx, id, modelId, 'error', 'interrupted')) {
            await tx`UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = 'interrupted'
                     WHERE queue = ${EVAL_QUEUE} AND payload ->> 'evalId' = ${id} AND status = 'running'`;
          }
        });
      }
      loop = run();
    },

    async stop() {
      controller.abort();
      const grace = new Promise<void>((resolve) => setTimeout(resolve, options.stopGraceMs ?? 10_000).unref());
      await Promise.race([loop, grace]);
    },
  };
}
