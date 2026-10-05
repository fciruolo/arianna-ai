/**
 * "Sviluppo di Arianna" (D-102): what the page does with the progress the
 * core reads from the documents. Pure: the page fetches, this decides.
 */
export type ItemState = 'done' | 'doing' | 'todo';
export type ItemKind = 'decision' | 'task' | 'epic' | 'idea' | 'request';
export type QuestionKind = 'proposal' | 'confirm' | 'open' | 'waiting';

export interface ProgressItem {
  id: string;
  kind: ItemKind;
  title: string;
  state: ItemState;
  status: string;
  phase: string | null;
  source: string;
}

export interface OpenQuestion {
  key: string;
  kind: QuestionKind;
  ref: string;
  topic: string;
  text: string;
  detail: string | null;
  source: string;
  answer: { state: 'new' | 'done'; at: string } | null;
}

export interface Progress {
  items: ProgressItem[];
  questions: OpenQuestion[];
  counts: Record<ItemState, number>;
  dropped: number;
  skipped: Record<string, number>;
  missing: string[];
  answersFile: string;
}

export const STATES: readonly ItemState[] = ['done', 'doing', 'todo'];

export const STATE_TEXT: Record<ItemState, string> = { done: 'Fatto', doing: 'In corso', todo: 'Da fare' };

export const STATE_HINT: Record<ItemState, string> = {
  done: 'Decisioni accettate o applicate, task chiusi',
  doing: 'Applicate in parte, in prova o in attesa della tua conferma; task aperti',
  todo: 'Proposte non applicate, task e epic non cominciati, idee da scegliere',
};

const KIND_ORDER: readonly ItemKind[] = ['decision', 'task', 'epic', 'idea', 'request'];

export const KIND_TEXT: Record<ItemKind, string> = {
  decision: 'Decisioni',
  task: 'Task delle fasi 0 e 1',
  epic: 'Epic delle fasi 2-5',
  idea: 'Idee dalla ricerca',
  request: 'Richieste in coda',
};

const PHASE_ORDER = ['0', '1', '1A', '1B', '2', '3', '4', '5'];

export interface Segment {
  state: ItemState;
  count: number;
  /** Width in the bar, 0-100. */
  percent: number;
}

/** The three parts of the bar, in order; widths sum to 100 unless there is nothing. */
export function barSegments(counts: Record<ItemState, number>): Segment[] {
  const total = STATES.reduce((sum, state) => sum + Math.max(0, counts[state]), 0);
  return STATES.map((state) => {
    const count = Math.max(0, counts[state]);
    return { state, count, percent: total === 0 ? 0 : (count * 100) / total };
  });
}

/** The share done, as a whole percentage (rounded down: 99,6% is not done). */
export function percentDone(counts: Record<ItemState, number>): number {
  const total = STATES.reduce((sum, state) => sum + Math.max(0, counts[state]), 0);
  return total === 0 ? 0 : Math.floor((Math.max(0, counts.done) * 100) / total);
}

export interface ItemFilter {
  state: ItemState | 'all';
  /** A phase, `all`, or `none` for items without one. */
  phase: string;
  kind: ItemKind | 'all';
  query: string;
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function filterItems(items: readonly ProgressItem[], filter: ItemFilter): ProgressItem[] {
  const words = fold(filter.query).split(/\s+/).filter((word) => word !== '');
  return items.filter((item) => {
    if (filter.state !== 'all' && item.state !== filter.state) return false;
    if (filter.kind !== 'all' && item.kind !== filter.kind) return false;
    if (filter.phase === 'none' ? item.phase !== null : filter.phase !== 'all' && item.phase !== filter.phase) return false;
    const haystack = fold(`${item.id} ${item.title} ${item.status}`);
    return words.every((word) => haystack.includes(word));
  });
}

/** The phases present, in roadmap order; unknown ones at the end. */
export function phases(items: readonly ProgressItem[]): string[] {
  const found = [...new Set(items.map((item) => item.phase).filter((phase): phase is string => phase !== null))];
  const rank = (phase: string): number => {
    const index = PHASE_ORDER.indexOf(phase);
    return index === -1 ? PHASE_ORDER.length : index;
  };
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function phaseText(phase: string): string {
  return `Fase ${phase}`;
}

/** Counts per state of a list (for the filter buttons). */
export function countStates(items: readonly ProgressItem[]): Record<ItemState | 'all', number> {
  const counts = { all: items.length, done: 0, doing: 0, todo: 0 };
  for (const item of items) counts[item.state] += 1;
  return counts;
}

export interface ItemGroup {
  kind: ItemKind;
  title: string;
  items: ProgressItem[];
}

export function groupItems(items: readonly ProgressItem[]): ItemGroup[] {
  return KIND_ORDER.map((kind) => ({ kind, title: KIND_TEXT[kind], items: items.filter((item) => item.kind === kind) })).filter((group) => group.items.length > 0);
}

export type QuestionFilter = 'open' | 'answered' | 'all';

export const QUESTION_FILTERS: { value: QuestionFilter; text: string }[] = [
  { value: 'open', text: 'Senza risposta' },
  { value: 'answered', text: 'Risposte inviate' },
  { value: 'all', text: 'Tutte' },
];

export function filterQuestions(questions: readonly OpenQuestion[], filter: QuestionFilter): OpenQuestion[] {
  if (filter === 'all') return [...questions];
  return questions.filter((question) => (filter === 'open') === (question.answer === null));
}

export interface QuestionGroup {
  id: string;
  title: string;
  questions: OpenQuestion[];
}

const KIND_GROUP: Record<Exclude<QuestionKind, 'proposal'>, string> = {
  confirm: 'Decisioni applicate da confermare',
  open: 'Decisioni aperte (OPEN-QUESTIONS.md)',
  waiting: 'In attesa dell’utente (HANDOFF.md)',
};

/** Questions of a proposal together under its title; the other kinds one group each, in the order they come. */
export function groupQuestions(questions: readonly OpenQuestion[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>();
  for (const question of questions) {
    const id = question.kind === 'proposal' ? `proposal:${question.ref}` : question.kind;
    let group = groups.get(id);
    if (group === undefined) {
      const title = question.kind === 'proposal' ? (question.topic === '' ? question.ref : `${question.ref} — ${question.topic}`) : KIND_GROUP[question.kind];
      group = { id, title, questions: [] };
      groups.set(id, group);
    }
    group.questions.push(question);
  }
  return [...groups.values()];
}

/** What the page says of a question already answered; null when it has no answer. */
export function answerStatus(question: OpenQuestion): string | null {
  if (question.answer === null) return null;
  return question.answer.state === 'new' ? `Risposta inviata (${question.answer.at}), in attesa di Claude` : `Risposta applicata da Claude (${question.answer.at})`;
}

export const ANSWER_EMPTY_TEXT = 'Scrivi una risposta prima di inviarla.';

export function answerTooLongText(max: number): string {
  return `La risposta è troppo lunga: al massimo ${String(max)} caratteri.`;
}

/** The text to send, or why not. */
export function checkAnswer(text: string, max: number): { text: string } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { error: ANSWER_EMPTY_TEXT };
  if (trimmed.length > max) return { error: answerTooLongText(max) };
  return { text: trimmed };
}

/** The question marked as answered now, before the page reloads the list. */
export function markAnswered(questions: readonly OpenQuestion[], key: string, at: string): OpenQuestion[] {
  return questions.map((question) => (question.key === key ? { ...question, answer: { state: 'new', at } } : question));
}

/** "3 righe saltate in DECISIONS.md, 1 in HANDOFF.md": lines a parser did not understand. */
export function skippedText(skipped: Record<string, number>): string | null {
  const parts = Object.entries(skipped)
    .filter(([, count]) => count > 0)
    .map(([doc, count]) => `${String(count)} in ${doc}`);
  return parts.length === 0 ? null : `Righe non riconosciute e saltate: ${parts.join(', ')}.`;
}
