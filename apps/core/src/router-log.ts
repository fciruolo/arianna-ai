import type { RouteDecision } from '@arianna/router';

import type { Queryable } from './db/client.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface RouteMeta {
  taskId?: string;
  runId?: string;
  step?: number;
}

/**
 * Writes a router decision to router_decisions, so that it can be explained in
 * the HUD and the rules corrected with data. Call it before acting on the
 * decision, in the same transaction when there is one.
 */
export async function recordRouteDecision(sql: Queryable, decision: RouteDecision, meta: RouteMeta = {}): Promise<void> {
  const route = decision.decision === 'route' ? decision : undefined;
  const wait = decision.decision === 'wait' ? decision : undefined;
  const candidates: Json[] = decision.candidates.map(({ executor, model, outcome }) => ({ executor, model, outcome }));
  await sql`
    INSERT INTO router_decisions (
      task_id, run_id, step, label, difficulty, decision, executor, model, locality,
      next, retry_at, approval, candidates, reason, escalated_from
    ) VALUES (
      ${meta.taskId ?? null}, ${meta.runId ?? null}, ${meta.step ?? null}, ${decision.label}::privacy_label,
      ${decision.difficulty}, ${decision.decision}, ${route?.executor ?? null}, ${route?.model ?? null},
      ${route?.locality ?? null}, ${wait?.next ?? null}, ${wait?.retryAt ?? null}::timestamptz,${route?.approval ?? null},
      ${sql.json(candidates)}, ${decision.reason}, ${decision.escalatedFrom ?? null}
    )`;
}
