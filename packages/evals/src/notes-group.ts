import { proposeWiki, wikiInputLines, type LocalModel, type WikiInput } from '@arianna/executors';

import type { CaseResult, EvalGroup, Measure } from './types.ts';

/**
 * The Wiki proposed by the local model (D-280), with the prompt, the schema
 * and the checks the core uses, on invented notes (evals/notes/wiki.jsonl).
 * A case passes when the action is the expected one ("update" of the right
 * page when a page on the subject exists, "create" in a sensible place,
 * "none" for a note with nothing to keep), every point cites only the notes
 * given, and the text is Italian.
 */
export interface WikiCaseInput {
  note: { title: string; text: string };
  sources?: { title: string; text: string }[];
  folders?: string[];
  pages?: { path: string; title: string; summary: string; points: string[] }[];
}

export interface WikiExpectation {
  action: 'create' | 'update' | 'none';
  /** For "update": the page to update. */
  page?: string;
  /** For "create": accepted beginnings of the path (`laravel`, `laravel/octane`). */
  places?: string[];
}

export interface WikiActual {
  ok: boolean;
  reason?: string;
  action?: string;
  path?: string;
  points?: number;
  /** Every point cites at least one note, only among those given. */
  citationsValid?: boolean;
  italian?: boolean;
}

const ITALIAN = new Set(['il', 'lo', 'la', 'gli', 'le', 'di', 'del', 'della', 'che', 'per', 'con', 'non', 'una', 'uno', 'sono', 'è', 'nel', 'nella', 'alla', 'dei', 'delle', 'si', 'come', 'anche', 'più']);
const ENGLISH = new Set(['the', 'and', 'of', 'to', 'is', 'with', 'for', 'that', 'this', 'are', 'it', 'in', 'on', 'be', 'by', 'an']);

/** Whether a text reads as Italian: more Italian function words than English ones, and some. */
export function looksItalian(text: string): boolean {
  const words = text.toLowerCase().split(/[^\p{L}]+/u);
  const it = words.filter((word) => ITALIAN.has(word)).length;
  const en = words.filter((word) => ENGLISH.has(word)).length;
  return it > 0 && it > en;
}

export function matchesWiki(actual: unknown, expect: unknown): boolean {
  const result = actual as WikiActual;
  const wanted = expect as WikiExpectation;
  if (!result.ok || result.action !== wanted.action) return false;
  if (wanted.action === 'none') return true;
  if (result.citationsValid !== true || result.italian !== true) return false;
  if (wanted.action === 'update') return result.path === wanted.page;
  return wanted.places === undefined || wanted.places.some((place) => result.path === place || (result.path ?? '').startsWith(`${place}/`));
}

const actualOf = (result: CaseResult): WikiActual | undefined => result.actual as WikiActual | undefined;

const WIKI_MEASURES: readonly Measure[] = [
  { name: 'schema', threshold: 1, excludeErrors: true, passed: (result) => actualOf(result)?.ok === true },
  { name: 'update', tag: 'update', threshold: 0.8 },
  { name: 'place', tag: 'create', threshold: 0.7 },
  { name: 'none', tag: 'none', threshold: 0.66 },
  {
    name: 'citations',
    threshold: 1,
    excludeErrors: true,
    passed: (result) => {
      const actual = actualOf(result);
      return actual?.ok === true && (actual.action === 'none' || actual.citationsValid === true);
    },
  },
  {
    name: 'italian',
    threshold: 0.9,
    excludeErrors: true,
    passed: (result) => {
      const actual = actualOf(result);
      return actual?.ok === true && (actual.action === 'none' || actual.italian === true);
    },
  },
];

/** The input of a case as the core gives it: the notes numbered, the pages and folders as they are. */
export function wikiCaseInput(input: WikiCaseInput): WikiInput {
  return {
    note: { id: 'nota-1', title: input.note.title, text: input.note.text },
    sources: (input.sources ?? []).map((source, index) => ({ id: `nota-${String(index + 2)}`, title: source.title, text: source.text })),
    folders: input.folders ?? [],
    pages: input.pages ?? [],
  };
}

export function createNotesGroup(model: () => LocalModel): EvalGroup {
  return {
    name: 'notes',
    tier: 'models',
    threshold: 0.7,
    strictTags: [],
    compare: matchesWiki,
    measures: WIKI_MEASURES,
    subject: {
      status: 'active',
      evaluate: async (raw, signal): Promise<WikiActual> => {
        const input = wikiCaseInput(raw as WikiCaseInput);
        const lines = wikiInputLines(input);
        const outcome = await proposeWiki(model(), input, [lines.note, ...lines.sources, ...lines.folders, ...lines.pages], signal === undefined ? {} : { signal });
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        const decision = outcome.decision;
        if (decision.action === 'none') return { ok: true, action: 'none' };
        const ids = new Set([input.note.id, ...input.sources.map((source) => source.id)]);
        return {
          ok: true,
          action: decision.action,
          path: decision.path,
          points: decision.points.length,
          citationsValid: decision.points.every((point) => point.sources.length > 0 && point.sources.every((source) => ids.has(source))),
          italian: looksItalian([decision.title, decision.summary, ...decision.points.map((point) => point.text)].join(' ')),
        };
      },
    },
  };
}
