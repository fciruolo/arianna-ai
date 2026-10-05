import type { Queryable } from './db/client.ts';

/**
 * What the status panel of the web chat shows (D-060, P1): what each agent is
 * doing, the last router decision and what passed the gateway today. Read
 * only, and only labels, names and counts: never a message, a brief or a
 * payload, so the panel holds nothing above what the event log already says.
 */
export type AgentState = 'idle' | 'thinking' | 'working' | 'waiting';

export interface AgentStatus {
  id: string;
  state: AgentState;
  /**
   * The run in progress, when there is one. `repo` is the repository of its
   * delegation or, without one, the workspace of its work conversation (D-124);
   * `mode` the kind of its conversation, null for a task outside any.
   */
  run: { executor: string; model: string | null; startedAt: string; repo: string | null; mode: 'work' | 'private' | null } | null;
}

export interface RouterStatus {
  ts: string;
  label: string;
  difficulty: string;
  decision: 'route' | 'wait';
  executor: string | null;
  model: string | null;
  locality: string | null;
  /** Labels, rules and candidate names only (router_decisions.reason). */
  reason: string;
}

export interface GatewayStatus {
  /** Start of the day the counts refer to. */
  since: string;
  /** Payloads that left for a cloud executor or an external channel today. */
  allowedOut: number;
  blocked: number;
  /** Allowed outside with L2 or L3: the database refuses them, so always 0. */
  privateOut: number;
  /** Decisions per hour, the last 12 hours, oldest first. */
  hours: number[];
}

export interface StatusSnapshot {
  agents: AgentStatus[];
  router: RouterStatus | null;
  gateway: GatewayStatus;
  /** Tasks waiting for the user. */
  waiting: number;
}

interface RunRow {
  agent: string;
  executor: string;
  model: string | null;
  locality: string;
  started_at: Date;
  repo: string | null;
  mode: 'work' | 'private' | null;
}

export async function loadStatus(sql: Queryable, agents: readonly string[]): Promise<StatusSnapshot> {
  const runs = await sql<RunRow[]>`
    SELECT * FROM (
      -- A run without a delegation (Arianna in a work conversation) is at the
      -- workspace of its conversation; a private conversation has none (D-124).
      SELECT DISTINCT ON (r.id) r.agent, r.executor, r.model, r.locality, r.started_at,
        COALESCE(d.repo, CASE WHEN c.mode = 'work' THEN c.workspace END) AS repo, c.mode
      FROM runs r
      LEFT JOIN task_delegations d ON d.run_id = r.id
      LEFT JOIN tasks t ON t.id = r.task_id
      LEFT JOIN conversations c ON c.id = t.conversation_id
      WHERE r.status = 'running'
      ORDER BY r.id, d.id DESC
    ) AS running
    ORDER BY started_at DESC`;
  const [waitingRow] = await sql<{ count: string }[]>`SELECT count(*) FROM tasks WHERE status = 'waiting_user'`;
  const waiting = Number(waitingRow?.count ?? 0);

  const states: AgentStatus[] = agents.map((id) => {
    const run = runs.find((row) => row.agent === id);
    if (run !== undefined) {
      return {
        id,
        // The orchestrator on the local model thinks; an agent running an executor works.
        state: run.locality === 'local' ? 'thinking' : 'working',
        run: { executor: run.executor, model: run.model, startedAt: run.started_at.toISOString(), repo: run.repo, mode: run.mode === 'work' || run.mode === 'private' ? run.mode : null },
      };
    }
    // Arianna is the one the user answers to: a task waiting for the user waits on her.
    return { id, state: id === 'arianna' && waiting > 0 ? 'waiting' : 'idle', run: null };
  });

  const [last] = await sql<
    { ts: Date; label: string; difficulty: string; decision: 'route' | 'wait'; executor: string | null; model: string | null; locality: string | null; reason: string }[]
  >`
    SELECT ts, label::text AS label, difficulty, decision, executor, model, locality, reason
    FROM router_decisions ORDER BY id DESC LIMIT 1`;

  const [today] = await sql<{ since: Date; allowed_out: string; blocked: string; private_out: string }[]>`
    SELECT date_trunc('day', now()) AS since,
      count(*) FILTER (WHERE decision = 'allow' AND locality = 'cloud') AS allowed_out,
      count(*) FILTER (WHERE decision = 'block') AS blocked,
      count(*) FILTER (WHERE decision = 'allow' AND locality = 'cloud' AND label >= 'L2') AS private_out
    FROM gateway_log WHERE ts >= date_trunc('day', now())`;
  const hours = await sql<{ count: string }[]>`
    SELECT count(g.id) AS count
    FROM generate_series(date_trunc('hour', now()) - interval '11 hours', date_trunc('hour', now()), interval '1 hour') AS h(start)
    LEFT JOIN gateway_log g ON g.ts >= h.start AND g.ts < h.start + interval '1 hour'
    GROUP BY h.start ORDER BY h.start`;

  return {
    agents: states,
    router:
      last === undefined
        ? null
        : {
            ts: last.ts.toISOString(),
            label: last.label,
            difficulty: last.difficulty,
            decision: last.decision,
            executor: last.executor,
            model: last.model,
            locality: last.locality,
            reason: last.reason,
          },
    gateway: {
      since: (today?.since ?? new Date()).toISOString(),
      allowedOut: Number(today?.allowed_out ?? 0),
      blocked: Number(today?.blocked ?? 0),
      privateOut: Number(today?.private_out ?? 0),
      hours: hours.map((row) => Number(row.count)),
    },
    waiting,
  };
}
