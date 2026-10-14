/**
 * «Consumi» (D-093, idea 10): how much Arianna worked in a period, per model
 * and per kind of task, from the core's GET /api/usage. Only counts, times,
 * sizes and names (L0): no title, no text. Pure: the page shows what this
 * decides.
 */
import { EXECUTOR_TEXT, MODEL_TEXT } from './labels.ts';

export type UsagePeriod = 'today' | '7d' | '30d';

export const PERIODS: readonly { value: UsagePeriod; text: string }[] = [
  { value: 'today', text: 'Oggi' },
  { value: '7d', text: '7 giorni' },
  { value: '30d', text: '30 giorni' },
];

export interface RunCounts {
  runs: number;
  steps: number;
  ok: number;
  failed: number;
  stopped: number;
  running: number;
  seconds: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface ModelUsage extends RunCounts {
  executor: string;
  model: string | null;
  locality: 'local' | 'cloud' | null;
  delegations: number;
  delegationsFailed: number;
}

export interface AgentUsage extends RunCounts {
  agent: string;
}

export interface KindUsage extends RunCounts {
  kind: string;
}

export interface DifficultyUsage {
  difficulty: string;
  decisions: number;
  local: number;
  cloud: number;
  waits: number;
}

export interface ExitUsage {
  targetKind: string;
  target: string;
  locality: 'local' | 'cloud';
  allowed: number;
  blocked: number;
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
  cloudExits: number;
  blocked: number;
  failures: number;
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

/** «Claude Code · Claude Sonnet», «modello locale · qwen3.8-27b-4bit»: executor, then the model when there is one. */
export function modelTitle(row: Pick<ModelUsage, 'executor' | 'model'>): string {
  // Delegations the router has not routed yet (the core's UNASSIGNED).
  if (row.executor === 'unassigned') return 'Deleghe non ancora assegnate';
  const executor = EXECUTOR_TEXT[row.executor] ?? row.executor;
  if (row.model === null || row.model === '') return executor;
  return `${executor} · ${MODEL_TEXT[row.model] ?? row.model}`;
}

const KIND_TEXT: Record<string, string> = {
  conversation: 'Conversazioni',
  card: 'Schede',
  subtask: 'Sotto-lavori',
  finance: 'Finanze',
};

export function kindText(kind: string): string {
  return KIND_TEXT[kind] ?? kind;
}

const DIFFICULTY_TEXT: Record<string, string> = {
  trivial: 'Banale',
  normal: 'Normale',
  hard: 'Difficile',
  critical: 'Critica',
};

export function difficultyText(difficulty: string): string {
  return DIFFICULTY_TEXT[difficulty] ?? difficulty;
}

/** Where an exit went: an executor by its name, a link or the web by what it is. */
export function exitText(row: Pick<ExitUsage, 'targetKind' | 'target'>): string {
  if (row.targetKind === 'executor') return EXECUTOR_TEXT[row.target] ?? row.target;
  if (row.targetKind === 'web') return 'Ricerca sul web';
  if (row.targetKind === 'link') return row.target === 'link-click' ? 'Link scaricati da te' : 'Link dei siti approvati';
  if (row.targetKind === 'channel') return `Canale ${row.target}`;
  return row.target;
}

/** Where a row ran: «cloud», «sul Mac», or nothing for what ran nowhere. */
export function localityText(locality: 'local' | 'cloud' | null): string {
  if (locality === null) return '';
  return locality === 'cloud' ? 'cloud' : 'sul Mac';
}

/** A whole number, Italian style: «12.345». */
export function countText(value: number): string {
  return Math.round(value).toLocaleString('it-IT');
}

/** «1,2 kB», «3,4 MB». */
export function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1000) return `${String(Math.round(bytes))} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toLocaleString('it-IT', { maximumFractionDigits: 1 })} ${units[unit] ?? 'GB'}`;
}

/** «12 s», «3 min», «1 h 20 min»: the time of work, from seconds. */
export function secondsText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${String(total)} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(total % 60)} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
}

/** The mean time of a run, or a dash when nothing ran. */
export function averageText(row: Pick<RunCounts, 'runs' | 'seconds'>): string {
  return row.runs === 0 ? '—' : secondsText(row.seconds / row.runs);
}

/** «15.000 → 300» tokens in and out, or a dash when the executor said nothing. */
export function tokensText(row: Pick<RunCounts, 'tokensIn' | 'tokensOut'>): string {
  if (row.tokensIn === null && row.tokensOut === null) return '—';
  return `${countText(row.tokensIn ?? 0)} → ${countText(row.tokensOut ?? 0)}`;
}

/** How the runs ended, for the cell of the table: «9 ok · 1 fallito · 2 fermati». */
export function outcomeText(row: Pick<RunCounts, 'ok' | 'failed' | 'stopped' | 'running'>): string {
  const parts = [`${countText(row.ok)} ok`];
  if (row.failed > 0) parts.push(`${countText(row.failed)} ${row.failed === 1 ? 'fallito' : 'falliti'}`);
  if (row.stopped > 0) parts.push(`${countText(row.stopped)} ${row.stopped === 1 ? 'fermato' : 'fermati'}`);
  if (row.running > 0) parts.push(`${countText(row.running)} in corso`);
  return parts.join(' · ');
}

/** The report says nothing happened in the period. */
export function isEmpty(report: UsageReport): boolean {
  const totals = report.totals;
  return totals.runs === 0 && totals.delegations === 0 && report.exits.length === 0 && report.difficulties.length === 0 && totals.failures === 0 && totals.advice === 0;
}

/** «da mezzanotte», «dal 7 ottobre»: where the period starts, in words. */
export function sinceText(report: Pick<UsageReport, 'period' | 'since'>): string {
  if (report.period === 'today') return 'da mezzanotte';
  const date = new Date(report.since);
  if (Number.isNaN(date.getTime())) return '';
  return `dal ${date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}`;
}
