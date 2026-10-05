/**
 * Trials of a catalog model with the orchestrator evals (D-081), as the
 * settings page shows them. Pure: the page asks the core and draws.
 */
export type ModelEvalStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';

export interface ModelEvalMeasure {
  name: string;
  total: number;
  passed: number;
  rate: number;
  threshold: number;
}

/** A row of GET /api/model-evals (without the cases). */
export interface ModelEval {
  id: string;
  modelId: string;
  role: string;
  weightsSha256: string | null;
  catalogStatus: string;
  status: ModelEvalStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number | null;
  passed: number | null;
  done: number;
  measures: ModelEvalMeasure[] | null;
  latencyMedianMs: number | null;
  latencyMaxMs: number | null;
  reasons: string[] | null;
  preemptions: number;
  error: string | null;
}

/** The page refreshes every 10 s while one of these is open. */
export function isOpen(trial: Pick<ModelEval, 'status'>): boolean {
  return trial.status === 'queued' || trial.status === 'running';
}

export function anyOpen(trials: readonly Pick<ModelEval, 'status'>[]): boolean {
  return trials.some(isOpen);
}

/** "12/32" once finished, "5/32" of the cases done while running, a dash before. */
export function scoreText(trial: Pick<ModelEval, 'status' | 'total' | 'passed' | 'done'>): string {
  if (trial.total === null) return '—';
  if (trial.status === 'running') return `${String(trial.done)}/${String(trial.total)} casi`;
  if (trial.passed === null) return '—';
  return `${String(trial.passed)}/${String(trial.total)}`;
}

/** "850 ms", "12,3 s", "2 min 5 s". */
export function latencyText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} s`;
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}

/** "05/10/2026 14:03", in the page's time zone. */
export function dateText(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(new Date(iso));
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/**
 * The suggestion under a model of the catalog still `experimental` whose last
 * finished trial passed: the core never writes the catalog (in git), the user
 * promotes it by hand.
 */
export function promotionHint(trials: readonly ModelEval[], modelId: string, catalogStatus: string, timeZone?: string): string | undefined {
  if (catalogStatus !== 'experimental') return undefined;
  const last = trials.filter((trial) => trial.modelId === modelId && trial.finishedAt !== null).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  if (last?.status !== 'passed' || last.finishedAt === null) return undefined;
  const weights = last.weightsSha256 === null ? 'pesi sconosciuti' : `pesi ${last.weightsSha256.slice(0, 8)}`;
  return `Soglie superate il ${dateText(last.finishedAt, timeZone)} (${weights}, secondo il catalogo): la promozione si fa a mano.`;
}

/** Whether a new trial of this model can be asked: files on disk and none open. */
export function canTry(trials: readonly ModelEval[], model: { id: string; present: boolean }): boolean {
  return model.present && !trials.some((trial) => trial.modelId === model.id && isOpen(trial));
}
