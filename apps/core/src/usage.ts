import type { Queryable } from './db/client.ts';
import { ADVICE_EVENT } from './orchestrator/advisor.ts';

/**
 * «Consumi» (D-093, idea 10 of OpenWork): how much Arianna worked in a period,
 * per model and per kind of task, read only from metadata already in the
 * database. Every value here is L0: counts, durations, sizes, executor and
 * model names, agent ids, closed codes. Never a title, a brief, a message or
 * an answer: no query reads those columns. Read only.
 */
export const USAGE_PERIODS = ['today', '7d', '30d'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const DEFAULT_PERIOD: UsagePeriod = '7d';

/** The period an address asks for; nothing gives the default, anything unknown is undefined (a 400). */
export function parsePeriod(raw: string | null): UsagePeriod | undefined {
  if (raw === null || raw === '') return DEFAULT_PERIOD;
  return (USAGE_PERIODS as readonly string[]).includes(raw) ? (raw as UsagePeriod) : undefined;
}

/** Where a period starts: local midnight for «oggi», as the advisor's daily cap (D-207); N days back otherwise. */
export function periodStart(period: UsagePeriod, now: Date): Date {
  if (period === 'today') {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight;
  }
  const days = period === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** The runs of a group: how many, how they ended, how long and how many steps. */
export interface RunCounts {
  runs: number;
  steps: number;
  ok: number;
  failed: number;
  /** Cancelled, over a limit or interrupted. */
  stopped: number;
  running: number;
  /** Seconds of work, up to the end or the last heartbeat. */
  seconds: number;
  /** Null when no run of the group reported tokens. */
  tokensIn: number | null;
  tokensOut: number | null;
}

/** The executor of delegations the router has not routed yet (pending, or refused before routing). */
export const UNASSIGNED = 'unassigned';

export interface ModelUsage extends RunCounts {
  executor: string;
  /** Null when the run recorded none. */
  model: string | null;
  /** Null only for UNASSIGNED delegations: they ran nowhere. */
  locality: 'local' | 'cloud' | null;
  /** Delegations of the orchestrator routed to this executor and model. */
  delegations: number;
  delegationsFailed: number;
}

export interface AgentUsage extends RunCounts {
  agent: string;
}

/** What a task is, from its columns: never from its title. */
export const TASK_KINDS = ['conversation', 'finance', 'subtask', 'card'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface KindUsage extends RunCounts {
  kind: TaskKind;
}

/** The router's decisions per difficulty (docs/ROUTER-SPEC.md). */
export interface DifficultyUsage {
  difficulty: string;
  decisions: number;
  local: number;
  cloud: number;
  /** The router waited: quota, retry later, or the user. */
  waits: number;
}

/** What the gateway decided per destination. */
export interface ExitUsage {
  targetKind: string;
  target: string;
  locality: 'local' | 'cloud';
  allowed: number;
  blocked: number;
  /** Bytes of the allowed payloads. */
  bytes: number;
}

export interface FailureUsage {
  origin: string;
  code: string;
  count: number;
}

export interface UsageTotals {
  runs: number;
  steps: number;
  seconds: number;
  delegations: number;
  /** Allowed exits towards the cloud. */
  cloudExits: number;
  /** Exits the gateway refused, local or cloud. */
  blocked: number;
  /** Errors recorded in task_errors (a task retried can have more than one). */
  failures: number;
  /** Opinions of Claude on the difficulty (D-207). */
  advice: number;
}

export interface UsageReport {
  period: UsagePeriod;
  since: string;
  totals: UsageTotals;
  models: ModelUsage[];
  agents: AgentUsage[];
  kinds: KindUsage[];
  difficulties: DifficultyUsage[];
  exits: ExitUsage[];
  failures: FailureUsage[];
}

/** The aggregate columns of runs, the same for every grouping. */
const RUN_COLUMNS = `
  count(*)::int AS runs,
  coalesce(sum(r.steps_used), 0)::float8 AS steps,
  (count(*) FILTER (WHERE r.status = 'ok'))::int AS ok,
  (count(*) FILTER (WHERE r.status = 'failed'))::int AS failed,
  (count(*) FILTER (WHERE r.status IN ('cancelled', 'limit', 'interrupted')))::int AS stopped,
  (count(*) FILTER (WHERE r.status = 'running'))::int AS running,
  coalesce(sum(greatest(extract(epoch FROM (coalesce(r.ended_at, r.last_seen_at) - r.started_at)), 0)), 0)::float8 AS seconds,
  sum(r.tokens_in)::float8 AS "tokensIn",
  sum(r.tokens_out)::float8 AS "tokensOut"`;

/** A task's kind, in SQL: finance first (its runs stay local), then where it lives. */
const KIND_SQL = `CASE WHEN t.finance THEN 'finance'
  WHEN t.conversation_id IS NOT NULL THEN 'conversation'
  WHEN t.parent_id IS NOT NULL THEN 'subtask'
  ELSE 'card' END`;

interface DelegationRow {
  executor: string | null;
  model: string | null;
  delegations: number;
  failed: number;
}

type ModelRow = Omit<ModelUsage, 'delegations' | 'delegationsFailed'>;

/**
 * The runs per executor and model, with the delegations routed to the same
 * pair; a delegation whose pair ran nothing in the period still gets its row
 * (refused or still pending, for instance). Most used first.
 */
export function mergeDelegations(runs: readonly ModelRow[], delegations: readonly DelegationRow[]): ModelUsage[] {
  const key = (executor: string | null, model: string | null) => JSON.stringify([executor, model]);
  const rows = new Map<string, ModelUsage>();
  for (const row of runs) rows.set(key(row.executor, row.model), { ...row, delegations: 0, delegationsFailed: 0 });
  for (const row of delegations) {
    const found = rows.get(key(row.executor, row.model));
    if (found !== undefined) {
      found.delegations += row.delegations;
      found.delegationsFailed += row.failed;
      continue;
    }
    // A delegation names a cloud executor, or the local one (D-140): the locality follows the executor.
    // Without one it was never routed: no locality, never counted as cloud.
    const executor = row.executor ?? UNASSIGNED;
    rows.set(key(row.executor, row.model), {
      executor,
      model: row.model,
      locality: row.executor === null ? null : executor === 'local' ? 'local' : 'cloud',
      ...emptyCounts(),
      delegations: row.delegations,
      delegationsFailed: row.failed,
    });
  }
  return [...rows.values()].sort((a, b) => b.runs - a.runs || b.delegations - a.delegations || a.executor.localeCompare(b.executor) || (a.model ?? '').localeCompare(b.model ?? ''));
}

export function emptyCounts(): RunCounts {
  return { runs: 0, steps: 0, ok: 0, failed: 0, stopped: 0, running: 0, seconds: 0, tokensIn: null, tokensOut: null };
}

/** The totals of the page, from the rows it shows. */
export function totalsOf(report: Omit<UsageReport, 'totals' | 'period' | 'since'>, advice: number): UsageTotals {
  const sum = <T>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
  return {
    runs: sum(report.models, (row) => row.runs),
    steps: sum(report.models, (row) => row.steps),
    seconds: sum(report.models, (row) => row.seconds),
    delegations: sum(report.models, (row) => row.delegations),
    cloudExits: sum(report.exits, (row) => (row.locality === 'cloud' ? row.allowed : 0)),
    blocked: sum(report.exits, (row) => row.blocked),
    failures: sum(report.failures, (row) => row.count),
    advice,
  };
}

/** Everything the page shows for a period. Read only; L0 by construction. */
export async function loadUsage(sql: Queryable, period: UsagePeriod, now: Date = new Date()): Promise<UsageReport> {
  const since = periodStart(period, now);
  const [runs, delegations, agents, kinds, difficulties, exits, failures, advice] = await Promise.all([
    sql.unsafe<ModelRow[]>(
      `SELECT r.executor, r.model, r.locality, ${RUN_COLUMNS}
       FROM runs r WHERE r.started_at >= $1::timestamptz
       GROUP BY r.executor, r.model, r.locality`,
      [since.toISOString()],
    ),
    sql<DelegationRow[]>`
      SELECT executor, model, count(*)::int AS delegations, (count(*) FILTER (WHERE status = 'failed'))::int AS failed
      FROM task_delegations WHERE created_at >= ${since}
      GROUP BY executor, model`,
    sql.unsafe<AgentUsage[]>(
      `SELECT r.agent, ${RUN_COLUMNS}
       FROM runs r WHERE r.started_at >= $1::timestamptz
       GROUP BY r.agent ORDER BY runs DESC, r.agent`,
      [since.toISOString()],
    ),
    sql.unsafe<KindUsage[]>(
      `SELECT ${KIND_SQL} AS kind, ${RUN_COLUMNS}
       FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.started_at >= $1::timestamptz
       GROUP BY 1 ORDER BY runs DESC, 1`,
      [since.toISOString()],
    ),
    sql<DifficultyUsage[]>`
      SELECT difficulty, count(*)::int AS decisions,
        (count(*) FILTER (WHERE decision = 'route' AND locality = 'local'))::int AS local,
        (count(*) FILTER (WHERE decision = 'route' AND locality = 'cloud'))::int AS cloud,
        (count(*) FILTER (WHERE decision = 'wait'))::int AS waits
      FROM router_decisions WHERE ts >= ${since}
      GROUP BY difficulty`,
    sql<ExitUsage[]>`
      SELECT target_kind AS "targetKind", target, locality,
        (count(*) FILTER (WHERE decision = 'allow'))::int AS allowed,
        (count(*) FILTER (WHERE decision = 'block'))::int AS blocked,
        coalesce(sum(bytes_out) FILTER (WHERE decision = 'allow'), 0)::float8 AS bytes
      FROM gateway_log WHERE ts >= ${since}
      GROUP BY target_kind, target, locality
      ORDER BY count(*) DESC, target_kind, target`,
    sql<FailureUsage[]>`
      SELECT origin, code, count(*)::int AS count
      FROM task_errors WHERE ts >= ${since}
      GROUP BY origin, code ORDER BY count DESC, code`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM events WHERE kind = ${ADVICE_EVENT} AND ts >= ${since}`,
  ]);
  const order = ['trivial', 'normal', 'hard', 'critical'];
  const report = {
    models: mergeDelegations([...runs], [...delegations]),
    agents: [...agents],
    kinds: [...kinds],
    difficulties: [...difficulties].sort((a, b) => order.indexOf(a.difficulty) - order.indexOf(b.difficulty)),
    exits: [...exits],
    failures: [...failures],
  };
  return { period, since: since.toISOString(), totals: totalsOf(report, advice[0]?.count ?? 0), ...report };
}
