import type { Queryable } from '../db/client.ts';

/**
 * How many subtasks of GOD work at once (D-127, G2), from the quota of the
 * subscription, as the rule of CLAUDE.md: the share of each window used so
 * far, projected linearly to its reset (used × length ÷ time elapsed), the
 * fullest window counting. Below 50% up to 4 at once, from 50 to 100% up to
 * 2, above it one. Unknown (no reading yet): 2. The readings are the
 * `executor.rate_limit` events the adapter of Claude records (L0: numbers
 * and times only); Codex gives none.
 */
export const WINDOW_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * 60 * 60_000,
  seven_day: 7 * 24 * 60 * 60_000,
  seven_day_opus: 7 * 24 * 60 * 60_000,
  seven_day_sonnet: 7 * 24 * 60 * 60_000,
};

export interface QuotaReading {
  window: string;
  /** Share used, 0 to 1. */
  utilization: number;
  resetsAt: Date;
}

/** The projected share of one reading at `now`, or undefined when it cannot be projected (unknown window, reset past, too early). */
export function projectReading(reading: QuotaReading, now: Date): number | undefined {
  const length = WINDOW_MS[reading.window];
  if (length === undefined) return undefined;
  const left = reading.resetsAt.getTime() - now.getTime();
  if (left <= 0 || left > length) return undefined;
  const elapsed = length - left;
  // The first minutes of a window say nothing: a few requests would project far above 100%.
  if (elapsed < 10 * 60_000) return reading.utilization;
  return (reading.utilization * length) / elapsed;
}

/** The fullest projection among the readings, or undefined when none counts. */
export function projection(readings: readonly QuotaReading[], now: Date): number | undefined {
  let top: number | undefined;
  for (const reading of readings) {
    const value = projectReading(reading, now);
    if (value !== undefined && (top === undefined || value > top)) top = value;
  }
  return top;
}

/** How many subtasks at once for a projection. */
export function concurrencyFor(projected: number | undefined): number {
  if (projected === undefined) return 2;
  if (projected < 0.5) return 4;
  if (projected <= 1) return 2;
  return 1;
}

/**
 * The share used, 0 to 1. The adapter of Claude records `utilization` as the
 * binary gives it in `rate_limit_info.unifiedWindows` (packages/executors,
 * claude/stream.ts), documented there as 0 to 1; a value above 1 is read as
 * a percentage, in case the binary gives one.
 */
export function shareOf(utilization: number): number {
  if (!Number.isFinite(utilization) || utilization < 0) return 0;
  return utilization > 1 ? utilization / 100 : utilization;
}

/** The latest reading of each window of Claude, from the events of the last week. */
export async function quotaReadings(sql: Queryable, now: Date = new Date()): Promise<QuotaReading[]> {
  const rows = await sql<{ payload: { window?: unknown; utilization?: unknown; resetsAt?: unknown } }[]>`
    SELECT DISTINCT ON (payload ->> 'window') payload FROM events
    WHERE kind = 'executor.rate_limit' AND ts > ${new Date(now.getTime() - 7 * 24 * 60 * 60_000)}
      AND payload ->> 'executor' = 'claude' AND payload ->> 'window' IS NOT NULL
    ORDER BY payload ->> 'window', id DESC`;
  const readings: QuotaReading[] = [];
  for (const { payload } of rows) {
    const resetsAt = typeof payload.resetsAt === 'string' ? new Date(payload.resetsAt) : undefined;
    if (typeof payload.window !== 'string' || typeof payload.utilization !== 'number' || resetsAt === undefined || Number.isNaN(resetsAt.getTime())) continue;
    readings.push({ window: payload.window, utilization: shareOf(payload.utilization), resetsAt });
  }
  return readings;
}
