import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Hex } from '@arianna/policy';

import { appendEvent } from './events.ts';
import type { Queryable } from './db/client.ts';

/**
 * "Sviluppo di Arianna" (D-102): how far the development of Arianna is, read
 * from the documents of the repository (never a register of its own), and the
 * answers of the user to the open questions, appended to data/dev/RISPOSTE.md
 * (outside git) for Claude Code to apply at the start of its next session.
 *
 * The parsers are pure and tolerant: a line they do not understand is skipped
 * and counted, never an error that breaks the page. config/labels.toml has no
 * rule for docs/, so the documents are L2 by default (default-deny): the core
 * reads them from fixed paths under ARIANNA_HOME and serves them only to the
 * local web chat, never to a cloud executor or an external channel.
 */

export type ItemState = 'done' | 'doing' | 'todo';
export type ItemKind = 'decision' | 'task' | 'epic' | 'idea' | 'request';
export type DocName = 'DECISIONS.md' | 'PROPOSTE.md' | 'ROADMAP.md' | 'PHASE-0-1-TASKS.md' | 'OPEN-QUESTIONS.md' | 'HANDOFF.md';
export type QuestionKind = 'proposal' | 'confirm' | 'open' | 'waiting';
export type AnswerState = 'new' | 'done';

export const DOCS: readonly DocName[] = ['DECISIONS.md', 'PROPOSTE.md', 'ROADMAP.md', 'PHASE-0-1-TASKS.md', 'OPEN-QUESTIONS.md', 'HANDOFF.md'];
/** Where the answers go, relative to ARIANNA_HOME: fixed, never from the client; data/ is outside git. */
const ANSWERS_DIR = 'data/dev';
const ANSWERS_NAME = 'RISPOSTE.md';
export const ANSWERS_FILE = `${ANSWERS_DIR}/${ANSWERS_NAME}`;
export const MAX_ANSWER_CHARS = 4000;
/** A document larger than this is not read (the real ones are a few hundred KB at most). */
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 110;
const MAX_QUESTION = 400;
const MAX_DETAIL = 600;
const MAX_EXPLAIN = 800;
const MAX_OPTION_LABEL = 80;
const MAX_OPTION_EFFECT = 300;
const MAX_OPTIONS = 6;

export interface ProgressItem {
  /** D-081, 1.10, F2.3, Idea 4, Coda 2. */
  id: string;
  kind: ItemKind;
  title: string;
  state: ItemState;
  /** The state as the document writes it, shortened. */
  status: string;
  /** 0, 1A, 1B, 2-5; null when the document does not say. */
  phase: string | null;
  source: DocName;
}

/** A choice of a question: the label goes in the answer when the user clicks it. */
export interface QuestionOption {
  label: string;
  /** What happens if the user chooses it ('' when the document does not say). */
  effect: string;
  recommended: boolean;
}

/**
 * The explanation of a question (D-122): what is being decided and why, the
 * options with their consequences (the recommended ones first), an example.
 * Written in the documents as "Contesto:", "Opzione consigliata:", "Opzione:"
 * and "Esempio:" lines; null for a question written without them.
 */
export interface Explanation {
  context: string | null;
  options: QuestionOption[];
  example: string | null;
}

export interface OpenQuestion {
  /** Stable while the document does not change the question: D-078#3, conf-D-081, oq-..., ho-.... */
  key: string;
  kind: QuestionKind;
  /** What the question is about: D-078, or the topic of a table row. */
  ref: string;
  /** The title of the proposal or decision, when there is one. */
  topic: string;
  text: string;
  /** Recommendation or note of the document, shortened. */
  detail: string | null;
  /** Context, options and example, when the document writes them (D-122). */
  explain: Explanation | null;
  source: DocName;
  /** The latest answer in docs/RISPOSTE.md: new until Claude marks it as applied. */
  answer: { state: AnswerState; at: string } | null;
}

export interface Progress {
  items: ProgressItem[];
  questions: OpenQuestion[];
  counts: Record<ItemState, number>;
  /** Decisions superseded or rejected: not in the bar. */
  dropped: number;
  /** Lines a parser did not understand, per document. */
  skipped: Partial<Record<DocName, number>>;
  /** Documents that are missing or unreadable. */
  missing: DocName[];
  answersFile: string;
}

interface Parsed<T> {
  values: T[];
  skipped: number;
}

/** Markdown of a cell or a line, as plain text on one line. */
export function plain(text: string): string {
  return text
    .replace(/\\\|/g, '|')
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/~~/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** The cells of a markdown table row, split on pipes that are not escaped. */
export function cells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) return undefined;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function isSeparator(row: readonly string[]): boolean {
  return row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function slug(text: string): string {
  return plain(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** The short title of a decision: its first clause. */
function decisionTitle(text: string): string {
  const flat = plain(text);
  let first = /^(.{20,}?)(?:[;:]\s|\.\s|$)/.exec(flat)?.[1] ?? flat;
  // A clause cut inside a parenthesis ends before it.
  if ((first.match(/\(/g) ?? []).length > (first.match(/\)/g) ?? []).length) first = first.slice(0, first.lastIndexOf('(')).trim();
  return shorten(first, MAX_TITLE);
}

/**
 * Where a decision stands, from its "Stato" cell. `dropped`: superseded or
 * rejected, outside the bar. Applied in part, on trial or waiting for the
 * user's confirmation is in progress; accepted or applied is done; a proposal
 * not applied is still to do.
 */
export function decisionState(status: string): ItemState | 'dropped' {
  const text = plain(status).toLowerCase();
  if (/^(sostituit|rifiutat|annullat|superat)/.test(text)) return 'dropped';
  if (/prima parte|in parte|in prova|da confermare/.test(text)) return 'doing';
  if (/^accettat/.test(text) || /applicat/.test(text)) return 'done';
  return 'todo';
}

export function confirmPending(status: string): boolean {
  return /da confermare/.test(plain(status).toLowerCase());
}

export interface DecisionRow {
  id: string;
  date: string;
  title: string;
  status: string;
  state: ItemState | 'dropped';
}

/** The table of docs/DECISIONS.md: id, date, decision, reason, status. */
export function parseDecisions(text: string): Parsed<DecisionRow> {
  const values: DecisionRow[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!/^\|\s*D-/.test(line)) continue;
    const row = cells(line);
    const id = row?.[0] ?? '';
    if (row === undefined || row.length !== 5 || !/^D-\d{3}[a-z]?$/.test(id) || plain(row[2] ?? '') === '' || plain(row[4] ?? '') === '') {
      skipped += 1;
      continue;
    }
    const status = row[4] ?? '';
    values.push({ id, date: row[1] ?? '', title: decisionTitle(row[2] ?? ''), status: shorten(plain(status), 90), state: decisionState(status) });
  }
  return { values, skipped };
}

export type ExplainField = 'context' | 'option' | 'recommended' | 'example';

const FIELD_NAMES: Record<string, ExplainField> = { contesto: 'context', 'opzione consigliata': 'recommended', opzione: 'option', esempio: 'example' };

/**
 * A line of an explanation (D-122): "Contesto: ...", "Opzione consigliata: ...",
 * "Opzione: ...", "Esempio: ...", with or without a list mark, bold or
 * indentation; undefined for any other line. The text may be '' (the caller
 * counts it as skipped).
 */
export function explainField(line: string): { field: ExplainField; text: string } | undefined {
  const flat = plain(line.replace(/^\s*[-*]\s+/, ''));
  const match = /^(Contesto|Opzione consigliata|Opzione|Esempio)\s*:\s*(.*)$/i.exec(flat);
  if (match === null) return undefined;
  const field = FIELD_NAMES[(match[1] ?? '').toLowerCase()];
  return field === undefined ? undefined : { field, text: (match[2] ?? '').trim() };
}

/**
 * "Label — what happens": the first long or en dash with spaces splits the
 * two; without one, the first " - ". Undefined for an option without a
 * separator whose label is too long to be a label (the caller skips it).
 */
export function parseOption(text: string, recommended: boolean): QuestionOption | undefined {
  const match = /^(.+?)\s+[—–]\s+(.+)$/.exec(text) ?? /^(.+?)\s+-\s+(.+)$/.exec(text);
  const label = (match?.[1] ?? text).trim().replace(/[.:;,]+$/, '');
  if (match === null && label.length > MAX_OPTION_LABEL) return undefined;
  return { label: shorten(label, MAX_OPTION_LABEL), effect: shorten((match?.[2] ?? '').trim(), MAX_OPTION_EFFECT), recommended };
}

/** Collects the fields of one question; `done` gives null when there were none. */
export class ExplanationBuilder {
  private context: string[] = [];
  private example: string[] = [];
  /** Raw text of the options: a continuation line may still add to the last one. */
  private options: { text: string; recommended: boolean }[] = [];
  /** The field the next continuation line belongs to. */
  private last: string[] | { text: string } | undefined;
  /** Fields with no text, options beyond MAX_OPTIONS or without a label. */
  skipped = 0;

  add(field: ExplainField, text: string): void {
    this.last = undefined;
    if (text === '') {
      this.skipped += 1;
      return;
    }
    if (field === 'context' || field === 'example') {
      this.last = field === 'context' ? this.context : this.example;
      this.last.push(text);
    } else if (this.options.length >= MAX_OPTIONS) {
      this.skipped += 1;
    } else {
      const option = { text, recommended: field === 'recommended' };
      this.options.push(option);
      this.last = option;
    }
  }

  /** A line that continues the field above it: false when no field is open. */
  continueField(text: string): boolean {
    if (this.last === undefined || text === '') return false;
    if (Array.isArray(this.last)) this.last.push(text);
    else this.last.text = `${this.last.text} ${text}`;
    return true;
  }

  done(): Explanation | null {
    const parsed: QuestionOption[] = [];
    for (const option of this.options) {
      const value = parseOption(option.text, option.recommended);
      if (value === undefined) this.skipped += 1;
      else parsed.push(value);
    }
    if (this.context.length === 0 && this.example.length === 0 && parsed.length === 0) return null;
    const join = (parts: string[]): string | null => (parts.length === 0 ? null : shorten(parts.join(' '), MAX_EXPLAIN));
    // The recommended options first, as the rule of the questions asks; the order of the document otherwise.
    const options = [...parsed.filter((option) => option.recommended), ...parsed.filter((option) => !option.recommended)];
    return { context: join(this.context), options, example: join(this.example) };
  }
}

export interface ProposalQuestion {
  id: string;
  number: number;
  text: string;
  detail: string | null;
  explain: Explanation | null;
}

export interface Proposals {
  titles: Map<string, string>;
  questions: ProposalQuestion[];
  /**
   * Proposals with a "### Risposte dell'utente" section: the date of its heading
   * ('' without one; the last section wins) and the numbers it answers.
   */
  answered: Map<string, { at: string; numbers: Set<number> }>;
  skipped: number;
}

/** A question of a proposal: the bold part is the question, the rest its recommendation. */
function splitQuestion(body: string): { text: string; detail: string | null } {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(body.trim());
  let text: string;
  let rest: string;
  if (bold !== null) {
    text = bold[1] ?? '';
    rest = bold[2] ?? '';
  } else {
    const mark = body.indexOf('?');
    text = mark === -1 ? body : body.slice(0, mark + 1);
    rest = mark === -1 ? '' : body.slice(mark + 1);
  }
  const detail = plain(rest);
  return { text: shorten(plain(text), MAX_QUESTION), detail: detail === '' ? null : shorten(detail, MAX_DETAIL) };
}

/**
 * docs/PROPOSTE.md: "## D-0NN — title" sections with a "### Domande per l'utente"
 * numbered list; a "### Risposte dell'utente (date, ...)" numbered list answers
 * the questions with the same numbers.
 */
export function parseProposals(text: string): Proposals {
  const titles = new Map<string, string>();
  const answered = new Map<string, { at: string; numbers: Set<number> }>();
  let answers: Set<number> | undefined;
  const questions: ProposalQuestion[] = [];
  let skipped = 0;
  let current: string | undefined;
  let inQuestions = false;
  let open: { number: number; lines: string[]; explain: ExplanationBuilder } | undefined;
  const close = (): void => {
    if (open !== undefined && current !== undefined) {
      const { text: question, detail } = splitQuestion(open.lines.join(' '));
      const explain = open.explain.done();
      skipped += open.explain.skipped;
      if (question === '') skipped += 1;
      else questions.push({ id: current, number: open.number, text: question, detail, explain });
    }
    open = undefined;
  };
  let fenced = false;
  for (const line of text.split('\n')) {
    // Code blocks (commands of a proposal) hold lines that look like headings.
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,2}\s/.test(line)) {
      close();
      inQuestions = false;
      const heading = /^##\s+(D-\d{3}[a-z]?)\s+[—–-]\s+(.+)$/.exec(line);
      current = heading?.[1];
      answers = undefined;
      if (heading !== null && current !== undefined) titles.set(current, shorten(plain(heading[2] ?? ''), MAX_TITLE));
      continue;
    }
    if (/^###\s/.test(line)) {
      close();
      inQuestions = current !== undefined && /^###\s+Domande per l/i.test(line);
      answers = undefined;
      if (current !== undefined && /^###\s+Risposte dell/i.test(line)) {
        answers = new Set();
        answered.set(current, { at: /\d{4}-\d{2}-\d{2}/.exec(line)?.[0] ?? '', numbers: answers });
      }
      continue;
    }
    if (answers !== undefined) {
      const number = /^(\d+)\.\s/.exec(line)?.[1];
      if (number !== undefined) answers.add(Number(number));
      continue;
    }
    if (!inQuestions) continue;
    const item = /^(\d+)\.\s+(.*)$/.exec(line);
    if (item !== null) {
      close();
      open = { number: Number(item[1]), lines: [item[2] ?? ''], explain: new ExplanationBuilder() };
    } else if (line.trim() === '' || line.trim() === '---') {
      close();
    } else if (open !== undefined) {
      // "Contesto:", "Opzione:", "Esempio:" under the question explain it (D-122); any other line continues it.
      const field = explainField(line);
      // An indented line after a field continues that field.
      if (field !== undefined) open.explain.add(field.field, field.text);
      else if (!(/^\s/.test(line) && open.explain.continueField(plain(line)))) open.lines.push(line.trim());
    } else {
      skipped += 1;
    }
  }
  close();
  return { titles, questions, answered, skipped };
}

/** The tables of docs/PHASE-0-1-TASKS.md: id, task, hours, real hours, done when. */
export function parseTasks(text: string): Parsed<ProgressItem> {
  const values: ProgressItem[] = [];
  let skipped = 0;
  let phase: string | null = null;
  for (const line of text.split('\n')) {
    const heading = /^##\s+Fase\s+(\d[AB]?)\b/.exec(line);
    if (heading !== null) {
      phase = heading[1] ?? null;
      continue;
    }
    if (/^##\s/.test(line)) phase = null;
    if (!/^\|\s*\d+\.\d+\s*\|/.test(line)) continue;
    const row = cells(line);
    if (row === undefined || row.length !== 5 || plain(row[1] ?? '') === '') {
      skipped += 1;
      continue;
    }
    const real = plain(row[3] ?? '').toLowerCase();
    const state: ItemState = real === '' ? 'todo' : /finora|aperto fino|in corso/.test(real) ? 'doing' : 'done';
    const status = real === '' ? 'Da fare' : `Ore reali: ${shorten(plain(row[3] ?? ''), 70)}`;
    values.push({ id: row[0] ?? '', kind: 'task', title: shorten(plain(row[1] ?? ''), MAX_TITLE), state, status, phase: phase ?? (row[0] ?? '').split('.')[0] ?? null, source: 'PHASE-0-1-TASKS.md' });
  }
  return { values, skipped };
}

/** Splits on " · " outside parentheses. */
function splitDots(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(' · ', index)) {
      parts.push(text.slice(start, index));
      start = index + 3;
      index += 2;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** The epics of docs/ROADMAP.md: "**Fase N (ore)...:** epic hours · epic hours (note) · ...". */
export function parseEpics(text: string): Parsed<ProgressItem> {
  const values: ProgressItem[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const match = /^\*\*Fase\s+(\d[AB]?)\b[^*]*\*\*\s*(.*)$/.exec(line);
    if (match === null) continue;
    const phase = match[1] ?? '';
    split: for (const [index, part] of splitDots(match[2] ?? '').entries()) {
      const note = /\(([^)]*)\)\s*\.?$/.exec(part)?.[1] ?? '';
      const name = plain(part.replace(/\s*\([^)]*\)\s*\.?$/, '').replace(/\s+\d+(?:-\d+)?\s*\.?$/, ''));
      if (name === '') {
        skipped += 1;
        continue split;
      }
      const lower = note.toLowerCase();
      const state: ItemState = /\bfatt[ao]\b/.test(lower) && !/anticipat|in parte/.test(lower) ? 'done' : /anticipat|in parte|in corso/.test(lower) ? 'doing' : 'todo';
      values.push({
        id: `F${phase}.${String(index + 1)}`,
        kind: 'epic',
        title: shorten(name.charAt(0).toUpperCase() + name.slice(1), MAX_TITLE),
        state,
        status: note === '' ? 'Da fare' : shorten(plain(note), 90),
        phase,
        source: 'ROADMAP.md',
      });
    }
  }
  return { values, skipped };
}

export interface OpenQuestionsDoc {
  questions: OpenQuestion[];
  ideas: ProgressItem[];
  skipped: number;
}

/**
 * docs/OPEN-QUESTIONS.md: the open decisions (rows not struck through), the
 * questions of proposals that docs/PROPOSTE.md does not hold, the research ideas.
 */
export function parseOpenQuestions(text: string, coveredProposals: ReadonlySet<string>): OpenQuestionsDoc {
  const questions: OpenQuestion[] = [];
  const ideas: ProgressItem[] = [];
  let skipped = 0;
  let section: 'open' | 'proposals' | 'ideas' | undefined;
  let proposal: { id: string; topic: string } | undefined;
  let header = true;
  for (const line of text.split('\n')) {
    if (/^#{2,3}\s/.test(line)) {
      section = /^##\s+Decisioni aperte/.test(line) ? 'open' : /^###\s+Domande delle proposte/.test(line) ? 'proposals' : /^##\s+Idee/.test(line) ? 'ideas' : undefined;
      header = true;
      continue;
    }
    if (section === undefined || !line.trim().startsWith('|')) continue;
    const row = cells(line);
    if (row === undefined) {
      skipped += 1;
      continue;
    }
    if (isSeparator(row)) continue;
    if (header) {
      header = false;
      continue;
    }
    if (section === 'open') {
      if (row.length !== 3) {
        skipped += 1;
      } else if (!(row[0] ?? '').startsWith('~~') && plain(row[0] ?? '') !== '') {
        const due = plain(row[2] ?? '');
        const detail = plain(row[1] ?? '');
        questions.push({
          key: `oq-${slug(row[0] ?? '')}`,
          kind: 'open',
          ref: due === '' ? 'Aperta' : `Entro: ${shorten(due, 40)}`,
          topic: '',
          text: shorten(plain(row[0] ?? ''), MAX_QUESTION),
          detail: detail === '' ? null : shorten(detail, MAX_DETAIL),
          explain: null,
          source: 'OPEN-QUESTIONS.md',
          answer: null,
        });
      }
    } else if (section === 'proposals') {
      const head = /^(D-\d{3}[a-z]?)\s*(.*)$/.exec(plain(row[0] ?? ''));
      if (row.length !== 3 || head === null) {
        skipped += 1;
        continue;
      }
      const id = head[1] ?? '';
      if (proposal?.id !== id) proposal = { id, topic: head[2] ?? '' };
      else if ((head[2] ?? '') !== '') proposal.topic = head[2] ?? '';
      if (coveredProposals.has(id)) continue;
      const question = plain(row[1] ?? '');
      const number = /^(\d+)\.\s/.exec(question)?.[1];
      questions.push({
        key: `oq-${id}-${number ?? slug(question).slice(0, 24).replace(/-+$/, '')}`,
        kind: 'proposal',
        ref: id,
        topic: proposal.topic,
        text: shorten(question, MAX_QUESTION),
        detail: plain(row[2] ?? '') === '' ? null : shorten(plain(row[2] ?? ''), MAX_DETAIL),
        explain: null,
        source: 'OPEN-QUESTIONS.md',
        answer: null,
      });
    } else {
      const number = plain(row[0] ?? '');
      if (row.length !== 5 || !/^\d+$/.test(number) || plain(row[1] ?? '') === '') {
        skipped += 1;
        continue;
      }
      ideas.push({
        id: `Idea ${number}`,
        kind: 'idea',
        title: shorten(plain(row[1] ?? ''), MAX_TITLE),
        state: 'todo',
        status: shorten(`Da scegliere · ${plain(row[4] ?? '')}`, 90),
        phase: /^\d[AB]?$/.test(plain(row[2] ?? '')) ? plain(row[2] ?? '') : null,
        source: 'OPEN-QUESTIONS.md',
      });
    }
  }
  return { questions, ideas, skipped };
}

export interface ExplanationsDoc {
  /** By the key of the question: D-078#3, conf-D-081, oq-..., ho-.... */
  explanations: Map<string, Explanation>;
  skipped: number;
}

/**
 * The "## Spiegazioni delle domande" section of docs/OPEN-QUESTIONS.md (D-122):
 * a "### <key>" heading per question, then its "Contesto:", "Opzione…:" and
 * "Esempio:" lines. For the questions that have no room under them: rows of a
 * table, confirmations of decisions, rows of HANDOFF.md.
 */
export function parseExplanations(text: string): ExplanationsDoc {
  const explanations = new Map<string, Explanation>();
  let skipped = 0;
  let inSection = false;
  let current: { key: string; builder: ExplanationBuilder } | undefined;
  const close = (): void => {
    if (current !== undefined) {
      const explain = current.builder.done();
      skipped += current.builder.skipped;
      // No fields, or a second block for the same key (the first one stays).
      if (explain === null || explanations.has(current.key)) skipped += 1;
      else explanations.set(current.key, explain);
    }
    current = undefined;
  };
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,2}\s/.test(line)) {
      close();
      inSection = /^##\s+Spiegazioni delle domande/i.test(line);
      continue;
    }
    if (!inSection) continue;
    if (/^###\s/.test(line)) {
      close();
      const key = plain(line.replace(/^###\s+/, ''));
      if (/^\S+$/.test(key)) current = { key, builder: new ExplanationBuilder() };
      else skipped += 1;
      continue;
    }
    if (line.trim() === '') continue;
    const field = explainField(line);
    // Prose before the first key introduces the section.
    if (current === undefined) continue;
    if (field !== undefined) current.builder.add(field.field, field.text);
    // An indented line after a field continues that field; any other line is not understood.
    else if (!(/^\s/.test(line) && current.builder.continueField(plain(line)))) skipped += 1;
  }
  close();
  return { explanations, skipped };
}

export interface HandoffDoc {
  requests: ProgressItem[];
  waiting: OpenQuestion[];
  skipped: number;
}

/**
 * docs/HANDOFF.md: the "Coda dell'utente" paragraph, "(1) ... (2) ...", and
 * the table of "In attesa dell'utente" (rows marked "(storico)" left out).
 */
export function parseHandoff(text: string): HandoffDoc {
  const requests: ProgressItem[] = [];
  const waiting: OpenQuestion[] = [];
  let skipped = 0;
  const queue = text.split('\n').find((line) => /^\*\*Coda dell['’]utente/.test(line));
  if (queue !== undefined) {
    const body = queue.replace(/^\*\*[^*]*\*\*\s*/, '');
    const parts = body.split(/(?:^|\s)\((\d+)\)\s+/);
    // parts: [before, n1, text1, n2, text2, ...]
    for (let index = 1; index + 1 < parts.length; index += 2) {
      const number = parts[index] ?? '';
      const raw = parts[index + 1] ?? '';
      const bold = /^\*\*(.+?)\*\*/.exec(raw.trim())?.[1];
      const title = plain(bold ?? raw);
      if (title === '') {
        skipped += 1;
        continue;
      }
      const lower = raw.toLowerCase();
      requests.push({
        id: `Coda ${number}`,
        kind: 'request',
        title: shorten(title, MAX_TITLE),
        state: /\b(fatt[ao]|chius[ao])\b/.test(lower.slice(0, 60)) ? 'done' : 'todo',
        status: 'Richiesta dell’utente',
        phase: null,
        source: 'HANDOFF.md',
      });
    }
  }
  let inWaiting = false;
  let header = true;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) {
      inWaiting = /^##\s+In attesa dell/.test(line);
      header = true;
      continue;
    }
    if (!inWaiting || !line.trim().startsWith('|')) continue;
    const row = cells(line);
    if (row === undefined || row.length < 2) {
      skipped += 1;
      continue;
    }
    if (isSeparator(row)) continue;
    if (header) {
      header = false;
      continue;
    }
    const what = plain(row[0] ?? '');
    if (what === '' || /^\(storico\)/i.test(what)) continue;
    // A pipe left unescaped in the note splits it: the note is the rest of the row.
    const note = plain(row.slice(1).join(' | '));
    waiting.push({
      key: `ho-${slug(what)}`,
      kind: 'waiting',
      ref: 'In attesa',
      topic: '',
      text: shorten(what, MAX_QUESTION),
      detail: note === '' ? null : shorten(note, MAX_DETAIL),
      explain: null,
      source: 'HANDOFF.md',
      answer: null,
    });
  }
  return { requests, waiting, skipped };
}

export interface AnswerEntry {
  at: string;
  key: string;
  state: AnswerState;
}

const ENTRY_HEADING = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (\S+) · (nuova|evasa)\s*$/;

/** The entries of docs/RISPOSTE.md, by their heading line; any other line is the body of one. */
export function parseAnswers(text: string): AnswerEntry[] {
  const entries: AnswerEntry[] = [];
  for (const line of text.split('\n')) {
    const match = ENTRY_HEADING.exec(line);
    if (match === null) continue;
    entries.push({ at: match[1] ?? '', key: match[2] ?? '', state: match[3] === 'evasa' ? 'done' : 'new' });
  }
  return entries;
}

function unique(questions: OpenQuestion[]): OpenQuestion[] {
  const seen = new Map<string, number>();
  return questions.map((question) => {
    const count = (seen.get(question.key) ?? 0) + 1;
    seen.set(question.key, count);
    return count === 1 ? question : { ...question, key: `${question.key}-${String(count)}` };
  });
}

export type DocTexts = Partial<Record<DocName, string>>;

/** Everything the page shows, from the texts of the documents (pure). */
export function buildProgress(docs: DocTexts, answers: string | undefined): Progress {
  const skipped: Partial<Record<DocName, number>> = {};
  const count = (doc: DocName, value: number): void => {
    if (value > 0) skipped[doc] = (skipped[doc] ?? 0) + value;
  };
  const missing = DOCS.filter((doc) => docs[doc] === undefined);

  const decisions = parseDecisions(docs['DECISIONS.md'] ?? '');
  count('DECISIONS.md', decisions.skipped);
  const proposals = parseProposals(docs['PROPOSTE.md'] ?? '');
  count('PROPOSTE.md', proposals.skipped);
  const tasks = parseTasks(docs['PHASE-0-1-TASKS.md'] ?? '');
  count('PHASE-0-1-TASKS.md', tasks.skipped);
  const epics = parseEpics(docs['ROADMAP.md'] ?? '');
  count('ROADMAP.md', epics.skipped);
  const covered = new Set(proposals.questions.map((question) => question.id));
  const open = parseOpenQuestions(docs['OPEN-QUESTIONS.md'] ?? '', covered);
  count('OPEN-QUESTIONS.md', open.skipped);
  const handoff = parseHandoff(docs['HANDOFF.md'] ?? '');
  count('HANDOFF.md', handoff.skipped);

  const items: ProgressItem[] = [];
  let dropped = 0;
  const known = new Set<string>();
  for (const row of decisions.values) {
    known.add(row.id);
    if (row.state === 'dropped') {
      dropped += 1;
      continue;
    }
    items.push({ id: row.id, kind: 'decision', title: proposals.titles.get(row.id) ?? row.title, state: row.state, status: row.status, phase: null, source: 'DECISIONS.md' });
  }
  // A proposal written in PROPOSTE.md and not yet in the register: still to do.
  for (const [id, title] of proposals.titles) {
    if (!known.has(id)) items.push({ id, kind: 'decision', title, state: 'todo', status: 'Proposta, da discutere', phase: null, source: 'PROPOSTE.md' });
  }
  items.push(...tasks.values, ...epics.values, ...open.ideas, ...handoff.requests);

  const questions: OpenQuestion[] = [];
  for (const question of proposals.questions) {
    const answered = proposals.answered.get(question.id);
    questions.push({
      key: `${question.id}#${String(question.number)}`,
      kind: 'proposal',
      ref: question.id,
      topic: proposals.titles.get(question.id) ?? '',
      text: question.text,
      detail: question.detail,
      explain: question.explain,
      source: 'PROPOSTE.md',
      // Answered in conversation and written in the document: already applied.
      answer: answered?.numbers.has(question.number) === true ? { state: 'done', at: answered.at } : null,
    });
  }
  for (const row of decisions.values) {
    if (row.state === 'dropped' || !confirmPending(row.status)) continue;
    const topic = proposals.titles.get(row.id) ?? row.title;
    questions.push({
      key: `conf-${row.id}`,
      kind: 'confirm',
      ref: row.id,
      topic,
      text: `Confermi ${row.id}: ${topic}?`,
      detail: `Stato in DECISIONS.md: ${row.status}`,
      explain: null,
      source: 'DECISIONS.md',
      answer: null,
    });
  }
  questions.push(...open.questions, ...handoff.waiting);

  const explained = parseExplanations(docs['OPEN-QUESTIONS.md'] ?? '');
  count('OPEN-QUESTIONS.md', explained.skipped);
  const latest = new Map<string, AnswerEntry>();
  for (const entry of parseAnswers(answers ?? '')) latest.set(entry.key, entry);
  // unique() renames a repeated key to key-2, key-3: a block of the section reaches it only under that name.
  const withAnswers = unique(questions).map((question) => {
    const entry = latest.get(question.key);
    // The lines under the question win over the section of OPEN-QUESTIONS.md.
    const explain = question.explain ?? explained.explanations.get(question.key) ?? null;
    // An answer sent from the page wins over the section of PROPOSTE.md.
    return { ...question, explain, ...(entry === undefined ? {} : { answer: { state: entry.state, at: entry.at } }) };
  });
  // An explanation whose question is gone (answered, struck through, its row changed): a line to clean up.
  const keys = new Set(withAnswers.map((question) => question.key));
  count('OPEN-QUESTIONS.md', [...explained.explanations.keys()].filter((key) => !keys.has(key)).length);

  const counts: Record<ItemState, number> = { done: 0, doing: 0, todo: 0 };
  for (const item of items) counts[item.state] += 1;
  return { items, questions: withAnswers, counts, dropped, skipped, missing, answersFile: ANSWERS_FILE };
}

/** A regular file of at most MAX_DOC_BYTES, or undefined: a link, a folder or a missing file is not read. */
function readDoc(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_DOC_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Reads the documents from `<home>/docs` and builds the page. Never throws for a document. */
export function loadProgress(home: string): Progress {
  const docs: DocTexts = {};
  for (const doc of DOCS) {
    const text = readDoc(join(home, 'docs', doc));
    if (text !== undefined) docs[doc] = text;
  }
  return buildProgress(docs, readDoc(join(home, ANSWERS_FILE)));
}

/**
 * The questions that wait for an answer of the user (D-120): open in the
 * documents and without an entry in data/dev/RISPOSTE.md or a section of
 * answers in PROPOSTE.md. An answer still to apply (`nuova`) waits for Claude,
 * not for the user, so it does not count.
 */
export function pendingQuestions(progress: Pick<Progress, 'questions'>): number {
  return progress.questions.filter((question) => question.answer === null).length;
}

export class DevAnswerError extends Error {
  override name = 'DevAnswerError';
  readonly code: 'invalid' | 'unknown-question' | 'blocked' | 'unavailable';

  constructor(code: DevAnswerError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The text of an answer as it goes in the file: Unix line ends, no control
 * characters (NEL and the line and paragraph separators included), no
 * bidirectional controls that could make a line read differently, trimmed.
 */
const STRIPPED_RANGES: readonly [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const escape = (point: number): string => `\\u${point.toString(16).padStart(4, '0')}`;
const STRIPPED = new RegExp(`[${STRIPPED_RANGES.map(([from, to]) => `${escape(from)}-${escape(to)}`).join('')}]`, 'g');

export function cleanAnswer(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // Built from code points: some of them would end a line in the source.
      .replace(STRIPPED, '')
      .trim()
  );
}

export function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** One entry of the answers file. The answer is quoted line by line, so no line of it can look like a heading. */
export function formatAnswer(question: OpenQuestion, answer: string, now: Date): string {
  const where = question.ref.startsWith('D-') ? `${question.ref}, docs/${question.source}` : `docs/${question.source}`;
  const topic = question.topic === '' || question.text.includes(question.topic) ? '' : ` (${question.topic})`;
  const quoted = answer
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
  return [`## ${stamp(now)} · ${question.key} · nuova`, '', `- **Domanda** (${where})${topic}: ${plain(question.text)}`, '', quoted, ''].join('\n');
}

export const ANSWERS_HEADER = `# Risposte dell'utente per Claude Code

Le risposte scritte nella pagina "Sviluppo di Arianna" delle Impostazioni (D-102). Il file sta in \`data/dev/\`, fuori da git. Il core aggiunge una voce in fondo per ogni risposta; Claude Code legge questo file all'inizio di ogni sessione, applica le risposte nuove ai documenti (DECISIONS, PROPOSTE, OPEN-QUESTIONS, HANDOFF) e cambia lo stato della voce da \`nuova\` a \`evasa\`.

Formato di una voce (la riga \`## \` la legge il core, non va cambiata salvo lo stato):

- intestazione \`## AAAA-MM-GG HH:MM · <chiave> · nuova|evasa\`; la chiave identifica la domanda (\`D-078#3\` = terza domanda di D-078 in PROPOSTE.md; \`conf-D-081\` = conferma di D-081; \`oq-...\` = riga di OPEN-QUESTIONS.md; \`ho-...\` = riga "In attesa dell'utente" di HANDOFF.md). Le chiavi \`oq-\` e \`ho-\` nascono dal testo della riga e cambiano se la riga cambia: per sapere a cosa risponde una voce vale la riga "Domanda";
- una riga con il riferimento e il testo della domanda;
- la risposta dell'utente, citata riga per riga con \`> \`.

Etichetta L1 dichiarata dall'utente: niente dati personali. La legge Claude Code (cloud): ogni risposta passa dal gateway prima di essere scritta, e un blocco (IBAN, codici fiscali, carte, chiavi, token, segreti del vault) la rifiuta.
`;

/** What the gateway decided for an answer: the text to write, or why not. */
export type AnswerGate = (answer: string, key: string) => Promise<{ allow: true; text: string } | { allow: false; reason: string }>;

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** data/dev, created private when missing; a link or anything but a folder is refused. */
function answersDir(home: string): string {
  const dir = join(home, ANSWERS_DIR);
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory()) throw new DevAnswerError('unavailable', `${ANSWERS_DIR} is not a folder`);
    return dir;
  } catch (error) {
    if (!missing(error)) {
      if (error instanceof DevAnswerError) throw error;
      throw new DevAnswerError('unavailable', `${ANSWERS_DIR} cannot be read`);
    }
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    throw new DevAnswerError('unavailable', `${ANSWERS_DIR} cannot be created`);
  }
  return answersDir(home);
}

/** The answers file exists, with its header, as a regular file; a link (even broken) is refused. */
function ensureAnswersFile(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new DevAnswerError('unavailable', `${ANSWERS_FILE} is not a regular file`);
    if (info.size > MAX_DOC_BYTES) throw new DevAnswerError('unavailable', `${ANSWERS_FILE} is too large: Claude Code should clear the applied answers`);
    return;
  } catch (error) {
    if (!missing(error)) {
      if (error instanceof DevAnswerError) throw error;
      throw new DevAnswerError('unavailable', `${ANSWERS_FILE} cannot be read`);
    }
  }
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    // Created meanwhile: the append below checks what it is.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return;
    throw new DevAnswerError('unavailable', `${ANSWERS_FILE} cannot be created`);
  }
  try {
    writeSync(fd, ANSWERS_HEADER);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** One append, never through a link. */
function appendEntry(path: string, entry: string): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  } catch {
    throw new DevAnswerError('unavailable', `${ANSWERS_FILE} cannot be opened for writing`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw new DevAnswerError('unavailable', `${ANSWERS_FILE} is not a regular file`);
    writeSync(fd, `\n${entry}`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends an answer to data/dev/RISPOSTE.md: the question must be one of the
 * open questions of the documents now (its text comes from them, never from
 * the client); the text is limited, then passes the gateway towards Claude
 * Code (cloud), and only the text the gateway allows is written.
 */
export async function saveAnswer(home: string, key: string, text: string, gate: AnswerGate, now: Date = new Date()): Promise<{ key: string; at: string; question: OpenQuestion }> {
  const answer = cleanAnswer(text);
  if (answer === '') throw new DevAnswerError('invalid', 'the answer is empty');
  if (answer.length > MAX_ANSWER_CHARS) throw new DevAnswerError('invalid', `the answer is longer than ${String(MAX_ANSWER_CHARS)} characters`);
  const question = loadProgress(home).questions.find((item) => item.key === key);
  if (question === undefined) throw new DevAnswerError('unknown-question', 'the question is no longer open in the documents');
  const decision = await gate(answer, question.key);
  if (!decision.allow) throw new DevAnswerError('blocked', `the gateway refused the answer: it would go to Claude Code (${decision.reason})`);
  const path = join(answersDir(home), ANSWERS_NAME);
  ensureAnswersFile(path);
  appendEntry(path, formatAnswer(question, decision.text, now));
  return { key: question.key, at: stamp(now), question };
}

/** The key as the L0 event holds it: keys made from the text of a row (`oq-`, `ho-`) only as a hash. */
export function eventKey(key: string): string {
  return /^(D-\d{3}[a-z]?#\d+|conf-D-\d{3}[a-z]?)$/.test(key) ? key : `sha256:${sha256Hex(key).slice(0, 16)}`;
}

/** The event of an answer saved (L0): the key (or its hash) and the source of the question, never the text. */
export async function recordAnswer(sql: Queryable, saved: { key: string; question: OpenQuestion }): Promise<void> {
  await appendEvent(sql, { kind: 'dev.answer_saved', label: 'L0', payload: { key: eventKey(saved.key), kind: saved.question.kind, source: saved.question.source } });
}
