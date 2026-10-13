/**
 * «Confronto dei modelli» (D-199): every trial of a role (D-081), models gone
 * from the catalog or the disk included, as the settings page shows them.
 * Pure: the page asks the core and draws. The verdict is computed here, by
 * code, from numbers only: no model writes it.
 */
import type { ModelEval } from './model-evals.ts';
import { sizeText } from './models-page.ts';

export interface ComparisonModel {
  name: string;
  provider: string | null;
  sizeBytes: number | null;
  quantization: string | null;
  ramMinGib: number | null;
  /** `trial`: copied when the trial was asked; `catalog`: from today's catalog (a trial before D-199); `id`: neither. */
  from: 'trial' | 'catalog' | 'id';
}

/** A row of GET /api/model-comparison. */
export interface ComparisonTrial extends ModelEval {
  casesSha256: string | null;
  tokensPerSecond: number | null;
  firstTokenMs: number | null;
  caseMeanMs: number | null;
  model: ComparisonModel;
  inCatalog: boolean;
  present: boolean;
  inUse: boolean;
  currentQuestions: boolean;
}

export interface Comparison {
  role: string;
  inUse: { modelId: string; name: string; inCatalog: boolean; present: boolean } | null;
  casesSha256: string;
  /** How many fake questions a trial asks today. */
  questions: number;
  trials: ComparisonTrial[];
}

export interface ComparedResult {
  passed: boolean;
  action?: 'call' | 'reply' | 'plan' | 'refuse' | 'unreadable';
  tool?: string;
  error?: string;
}

export interface ComparedCase {
  id: string;
  text: string | null;
  capability: string | null;
  results: (ComparedResult | null)[];
}

/** GET /api/model-comparison/cases. */
export interface CaseComparison {
  ids: string[];
  total: number;
  differing: ComparedCase[];
}

/** The five measures of the orchestrator group, in the order of the table (docs/EVALS.md). */
export const MEASURES = [
  { name: 'schema', label: 'Formato', title: 'Formato delle risposte', hint: 'Risponde nel formato che Arianna sa leggere', long: 'nel formato delle risposte' },
  { name: 'tool', label: 'Strumenti', title: 'Strumenti', hint: 'Sceglie lo strumento giusto', long: 'nella scelta degli strumenti' },
  { name: 'refusal', label: 'Rifiuti', title: 'Rifiuti', hint: 'Rifiuta ciò che non deve fare da solo', long: 'nei rifiuti' },
  { name: 'recovery', label: 'Ripresa', title: 'Ripresa dopo un errore', hint: 'Si riprende quando uno strumento sbaglia', long: 'nella ripresa dopo un errore' },
  { name: 'plan', label: 'Piano', title: 'Piano', hint: 'Divide un lavoro in passi', long: 'nei piani' },
] as const;

export const ROLE_LABEL: Record<string, string> = { orchestrator: 'Orchestratore' };

/** The capability of a fake question, as the column «Capacità» says it. */
export function capabilityText(capability: string | null): string {
  return MEASURES.find((measure) => measure.name === capability)?.label ?? '—';
}

/** A finished trial with an outcome: the only ones compared. */
export function comparable(trial: Pick<ModelEval, 'status' | 'total'>): boolean {
  return (trial.status === 'passed' || trial.status === 'failed') && (trial.total ?? 0) > 0;
}

export interface CompareFilter {
  /** Show the models whose files are no longer on the Mac. */
  showGone: boolean;
  /** Only the trials on the questions of today. */
  onlyCurrent: boolean;
}

export const DEFAULT_FILTER: CompareFilter = { showGone: true, onlyCurrent: false };

/** A model gone from the catalog or from the disk. */
export function gone(trial: Pick<ComparisonTrial, 'inCatalog' | 'present'>): boolean {
  return !trial.inCatalog || !trial.present;
}

/** One row per model: its newest finished trial (else its newest), the others under it. */
export interface ModelRow {
  modelId: string;
  main: ComparisonTrial;
  history: ComparisonTrial[];
}

export function modelRows(comparison: Comparison | null, filter: CompareFilter): ModelRow[] {
  if (comparison === null) return [];
  const groups = new Map<string, ComparisonTrial[]>();
  for (const trial of comparison.trials) {
    if (filter.onlyCurrent && !trial.currentQuestions) continue;
    if (!filter.showGone && gone(trial)) continue;
    const list = groups.get(trial.modelId) ?? [];
    list.push(trial);
    groups.set(trial.modelId, list);
  }
  const rows: ModelRow[] = [];
  for (const [modelId, trials] of groups) {
    const sorted = [...trials].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || Number(b.id) - Number(a.id));
    const main = sorted.find(comparable) ?? sorted[0];
    if (main === undefined) continue;
    rows.push({ modelId, main, history: sorted.filter((trial) => trial !== main) });
  }
  // The reference first, then the newest.
  return rows.sort((a, b) => Number(b.main.inUse) - Number(a.main.inUse) || b.main.requestedAt.localeCompare(a.main.requestedAt));
}

/** The rate of a measure of a trial; null without cases. */
export function measureOf(trial: Pick<ModelEval, 'measures'>, name: string): { passed: number; total: number; rate: number; threshold: number } | null {
  const found = trial.measures?.find((measure) => measure.name === name);
  return found === undefined || found.total === 0 ? null : found;
}

export type Column = 'score' | 'tps' | 'first' | 'perCase' | (typeof MEASURES)[number]['name'];

/** The best value of each column among the finished rows, when at least two have one: it goes in bold. */
export function bestValues(rows: readonly ModelRow[]): Partial<Record<Column, number>> {
  const finished = rows.map((row) => row.main).filter(comparable);
  const best: Partial<Record<Column, number>> = {};
  const pick = (column: Column, values: (number | null)[], higher: boolean): void => {
    const known = values.filter((value): value is number => value !== null);
    if (known.length < 2) return;
    best[column] = higher ? Math.max(...known) : Math.min(...known);
  };
  pick('score', finished.map((trial) => (trial.total === null || trial.passed === null || trial.total === 0 ? null : trial.passed / trial.total)), true);
  for (const measure of MEASURES) pick(measure.name, finished.map((trial) => measureOf(trial, measure.name)?.rate ?? null), true);
  pick('tps', finished.map((trial) => trial.tokensPerSecond), true);
  pick('first', finished.map((trial) => trial.firstTokenMs), false);
  pick('perCase', finished.map((trial) => trial.caseMeanMs), false);
  return best;
}

const it = (value: number, digits: number): string => value.toLocaleString('it-IT', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** "92%". */
export function percentText(rate: number): string {
  return `${String(Math.round(rate * 100))}%`;
}

/** "18", "7,5"; a dash when not measured. */
export function tpsText(value: number | null): string {
  if (value === null) return '—';
  return value < 10 ? it(Math.round(value * 10) / 10, 1) : String(Math.round(value));
}

/** "1,1 s", "0,5 s", "12 s"; a dash when not measured. */
export function secondsText(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = ms / 1000;
  return `${it(seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds), 1)} s`;
}

/** "18 GiB"; a dash when unknown. */
export function memoryText(gib: number | null): string {
  return gib === null ? '—' : `${String(gib)} GiB`;
}

/** "13 ott", or "13 ott 2025" in another year. */
export function shortDate(iso: string, now = new Date(), timeZone?: string): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(timeZone === undefined ? {} : { timeZone }) };
  const year = (value: Date): string => new Intl.DateTimeFormat('it-IT', { year: 'numeric', ...(timeZone === undefined ? {} : { timeZone }) }).format(value);
  if (year(date) !== year(now)) options.year = 'numeric';
  return new Intl.DateTimeFormat('it-IT', options).format(date);
}

/** "4 bit · 15,2 GB · Qwen, conversione mlx-community". */
export function modelLine(model: ComparisonModel): string {
  const bits = model.quantization === null ? null : /^\d+bit$/.test(model.quantization) ? model.quantization.replace('bit', ' bit') : model.quantization;
  return [bits, model.sizeBytes === null ? null : sizeText(model.sizeBytes), model.provider].filter((part): part is string => part !== null).join(' · ');
}

export interface Pill {
  text: string;
  kind: 'use' | 'gone' | 'warn' | 'plain';
}

/** The pills next to the name of a model. */
export function pillsOf(trial: ComparisonTrial): Pill[] {
  const pills: Pill[] = [];
  if (trial.inUse) pills.push({ text: 'In uso · riferimento', kind: 'use' });
  if (!trial.inCatalog) pills.push({ text: 'Tolto dal catalogo', kind: 'gone' });
  else if (!trial.present) pills.push({ text: 'Cancellato dal disco', kind: 'gone' });
  else if (!trial.inUse && trial.catalogStatus === 'experimental') pills.push({ text: 'Da provare', kind: 'plain' });
  if (trial.casesSha256 !== null && !trial.currentQuestions) pills.push({ text: 'Domande di allora', kind: 'warn' });
  return pills;
}

/** Why a row is not compared: a trial still open, or ended without an outcome. */
export function trialNote(trial: ComparisonTrial, now = new Date(), timeZone?: string): string | null {
  if (comparable(trial)) return null;
  if (trial.status === 'queued') return 'In coda: parte appena la macchina è libera.';
  const of = trial.total === null ? '' : ` su ${String(trial.total)}`;
  const done = `${String(trial.done)} ${trial.done === 1 ? 'domanda' : 'domande'}${of}`;
  if (trial.status === 'running') return `In corso: ${done}.`;
  const how = trial.status === 'cancelled' ? 'Annullata' : 'Interrotta';
  return `${how} dopo ${done}, il ${shortDate(trial.requestedAt, now, timeZone)}: non si confronta.`;
}

/** "13 ott 2026 · 47/51 · 18 tok/s · domande di allora": a previous trial of the model. */
export function historyLine(trial: ComparisonTrial, timeZone?: string): string {
  const date = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', ...(timeZone === undefined ? {} : { timeZone }) }).format(new Date(trial.requestedAt));
  const parts = [date];
  if (comparable(trial)) parts.push(`${String(trial.passed)}/${String(trial.total)}`);
  else parts.push(trial.status === 'cancelled' ? 'annullata' : trial.status === 'error' ? 'interrotta' : trial.status === 'running' ? 'in corso' : 'in coda');
  if (trial.tokensPerSecond !== null) parts.push(`${tpsText(trial.tokensPerSecond)} tok/s`);
  if (trial.casesSha256 !== null && !trial.currentQuestions) parts.push('domande di allora');
  return parts.join(' · ');
}

/** The selection of rows to compare: two or three, never more. */
export const MAX_SELECTED = 3;

export function toggleSelected(selected: readonly string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  if (selected.length >= MAX_SELECTED) return [...selected];
  return [...selected, id];
}

/** The selected trials in the order of the rows, the reference first. */
export function selectedTrials(rows: readonly ModelRow[], selected: readonly string[]): ComparisonTrial[] {
  return rows.map((row) => row.main).filter((trial) => selected.includes(trial.id) && comparable(trial));
}

/** Question by question only among trials on the same questions. */
export function sameQuestions(trials: readonly Pick<ComparisonTrial, 'casesSha256'>[]): boolean {
  const first = trials[0]?.casesSha256;
  return trials.length >= 2 && first !== undefined && first !== null && trials.every((trial) => trial.casesSha256 === first);
}

/** A bar of a measure: the share right, below the threshold or not. */
export interface Bar {
  trialId: string;
  passed: number;
  total: number;
  rate: number;
  below: boolean;
}

export interface MeasureBars {
  name: string;
  label: string;
  long: string;
  threshold: number;
  bars: (Bar | null)[];
}

export function measureBars(trials: readonly ComparisonTrial[]): MeasureBars[] {
  return MEASURES.map((measure) => {
    const bars = trials.map((trial) => {
      const found = measureOf(trial, measure.name);
      return found === null ? null : { trialId: trial.id, passed: found.passed, total: found.total, rate: found.rate, below: found.rate < found.threshold };
    });
    const threshold = trials.map((trial) => measureOf(trial, measure.name)?.threshold).find((value) => value !== undefined) ?? 0;
    return { name: measure.name, label: measure.title, long: measure.long, threshold, bars };
  });
}

/** A bar for a number where more (speed) or less (time) is better: widths relative to the largest. */
export function relativeWidths(values: readonly (number | null)[]): (number | null)[] {
  const largest = Math.max(0, ...values.filter((value): value is number => value !== null));
  return values.map((value) => (value === null || largest === 0 ? null : Math.max(2, Math.round((value / largest) * 100))));
}

/** The answer of a model to a fake question, in closed words: never what it wrote. */
export function answerText(result: ComparedResult | null): { outcome: string; detail: string | null; ok: boolean | null } {
  if (result === null) return { outcome: 'non provata', detail: null, ok: null };
  if (result.error !== undefined) {
    if (result.error.endsWith(':bad-response')) return { outcome: 'formato illeggibile', detail: null, ok: false };
    if (result.error.startsWith('LocalModelError')) return { outcome: 'sbagliata', detail: 'il modello non ha risposto', ok: false };
    return { outcome: 'sbagliata', detail: 'errore di Arianna', ok: false };
  }
  if (result.action === 'unreadable') return { outcome: 'formato illeggibile', detail: null, ok: false };
  const detail =
    result.action === 'call'
      ? result.tool === undefined
        ? 'usa uno strumento che non esiste'
        : (TOOL_WORDS[result.tool] ?? `usa ${result.tool}`)
      : result.action === 'reply'
        ? 'risponde senza strumenti'
        : result.action === 'plan'
          ? 'fa un piano'
          : result.action === 'refuse'
            ? 'rifiuta'
            : null;
  return { outcome: result.passed ? 'giusta' : 'sbagliata', detail: result.passed ? null : detail, ok: result.passed };
}

/** What a call of a tool of the registry does, in a few fixed words; another id is shown as it is. */
const TOOL_WORDS: Record<string, string> = {
  'kb.search': 'cerca nei documenti',
  'kb.read': 'apre una pagina',
  'kb.write': 'scrive una nota',
  'task.create': 'crea una card',
  'task.plan': 'propone un piano',
  'task.update': 'aggiorna una card',
  'task.delegate': 'delega a un agente',
  'user.ask': 'chiede all’utente',
  'web.search': 'cerca sul web',
  'web.fetch': 'apre una pagina web',
  'channel.send': 'manda un messaggio fuori',
};

const NUMBER_WORDS = ['nessuna', 'una', 'due', 'tre', 'quattro', 'cinque'];

function questions(count: number): string {
  return count === 1 ? '1 domanda' : `${String(count)} domande`;
}

/** A line of the verdict: the name in bold, then the sentence. */
export interface VerdictLine {
  name: string;
  text: string;
}

/**
 * The verdict on 2-3 selected trials, by code: for each one against the
 * reference (the model in use when selected, else the first), the ratio of
 * the speeds, the questions wrong more or less and in which capabilities, and
 * the capabilities below the threshold.
 */
export function verdict(trials: readonly ComparisonTrial[]): VerdictLine[] {
  const reference = trials.find((trial) => trial.inUse) ?? trials[0];
  if (reference === undefined || trials.length < 2) return [];
  const lines: VerdictLine[] = [];
  const refName = reference.model.name;
  const belowOf = (trial: ComparisonTrial) =>
    MEASURES.flatMap((measure) => {
      const found = measureOf(trial, measure.name);
      return found !== null && found.rate < found.threshold ? [{ measure, found }] : [];
    });
  const counted = MEASURES.filter((measure) => measure.name !== 'schema');

  const refBelow = belowOf(reference);
  if (refBelow.length > 0) {
    lines.push({
      name: refName,
      text: `${reference.inUse ? '(riferimento) ' : ''}sta sotto la soglia ${refBelow.map(({ measure }) => measure.long).join(', ')}.`,
    });
  }
  for (const trial of trials) {
    if (trial === reference) continue;
    const parts: string[] = [];
    // Speed.
    const mine = trial.tokensPerSecond;
    const theirs = reference.tokensPerSecond;
    if (mine !== null && theirs !== null && theirs > 0) {
      const ratio = mine / theirs;
      const counts = `(${tpsText(mine)} contro ${tpsText(theirs)} token al secondo)`;
      if (ratio >= 1.15) parts.push(`scrive ${it(Math.round(ratio * 10) / 10, 1)} volte più veloce di ${refName} ${counts}`);
      else if (ratio <= 1 / 1.15) parts.push(`scrive ${it(Math.round((1 / ratio) * 10) / 10, 1)} volte più lento di ${refName} ${counts}`);
      else parts.push(`scrive veloce come ${refName} ${counts}`);
    } else {
      parts.push(`non ha una velocità da confrontare con ${refName} (${mine === null ? 'questa prova' : 'la prova di riferimento'} non l’ha misurata)`);
    }
    // Questions wrong.
    const wrong = (item: ComparisonTrial): number => (item.total ?? 0) - (item.passed ?? 0);
    const same = trial.casesSha256 !== null && trial.casesSha256 === reference.casesSha256;
    const diff = wrong(trial) - wrong(reference);
    const where = counted.flatMap((measure) => {
      const a = measureOf(trial, measure.name);
      const b = measureOf(reference, measure.name);
      if (a === null || b === null || a.total !== b.total) return [];
      const extra = b.passed - a.passed;
      return extra === 0 ? [] : [{ measure, extra }];
    });
    const sameSign = where.filter(({ extra }) => Math.sign(extra) === Math.sign(diff));
    let wrongText: string;
    if (diff === 0) wrongText = `sbaglia tante domande quante ${refName}`;
    else {
      wrongText = `sbaglia ${questions(Math.abs(diff))} in ${diff > 0 ? 'più' : 'meno'}`;
      const only = sameSign.length === 1 ? sameSign[0] : undefined;
      if (only !== undefined && Math.abs(only.extra) === Math.abs(diff)) wrongText += Math.abs(diff) === 1 ? `, ${only.measure.long}` : `, tutte ${only.measure.long}`;
      else if (sameSign.length > 0) wrongText += ` (${sameSign.map(({ measure, extra }) => `${String(Math.abs(extra))} ${measure.long}`).join(', ')})`;
    }
    if (!same) wrongText += ' (su domande diverse: confronto indicativo)';
    parts.push(wrongText);
    // Thresholds.
    const below = belowOf(trial);
    const total = MEASURES.filter((measure) => measureOf(trial, measure.name) !== null).length;
    let end: string;
    if (below.length >= 3) end = `: sta sotto la soglia in ${NUMBER_WORDS[below.length] ?? String(below.length)} capacità su ${NUMBER_WORDS[total] ?? String(total)}, come orchestratore non va.`;
    else if (below.length > 0) end = `, sotto la soglia ${below.map(({ measure, found }) => `${measure.long} (${percentText(found.rate)} contro ${percentText(found.threshold)})`).join(' e ')}.`;
    else end = ', sopra la soglia in tutte le capacità.';
    lines.push({ name: trial.model.name, text: `${parts.join(' e ')}${end}` });
  }
  return lines;
}
