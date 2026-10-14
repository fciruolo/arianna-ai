/**
 * "Progetti seguiti" in "Sviluppo di Arianna" (D-202): the shapes the core
 * gives (followed-projects.ts) and the texts of the section. The news is
 * public text of a third party, perhaps worded by the local model: the page
 * shows it, never as an instruction. «Implementiamo» and «Non interessa»
 * write the choice in data/dev/RISPOSTE.md for Claude Code.
 */
import type { NewsItem, NewsRelease } from './design-news.ts';

export type ProjectChoice = 'implement' | 'skip';

export interface ProjectNews {
  version: 1;
  repository: string;
  from: string | null;
  to: string;
  fetchedAt: string;
  state: 'ready' | 'missing';
  message: string | null;
  source: 'model' | 'raw' | null;
  model: string | null;
  items: NewsItem[];
  releases: NewsRelease[];
  commits: number;
  truncated: boolean;
}

export interface FollowedProject {
  id: string;
  page: string;
  addedAt: string;
  /** Open Design: its news come with the catalog of the styles. */
  catalog: boolean;
  checking: boolean;
  seen: string | null;
  checkedAt: string | null;
  message: string | null;
  news: ProjectNews | null;
}

export const CHOICE_TEXT: Record<ProjectChoice, string> = { implement: 'Implementiamo', skip: 'Non interessa' };

/** Where the entries of a news come from, in one line. */
export function projectSourceText(news: ProjectNews): string {
  const range = news.from === null ? news.to : `${news.from} → ${news.to}`;
  const counts = `${String(news.commits)} commit`;
  if (news.source === 'model') return `Raggruppate dal modello locale · ${counts} · ${range}`;
  if (news.source === 'raw') return `Elenco dei commit per tipo · ${counts} · ${range}`;
  return range;
}

/** The state of the buttons of an entry: null while nothing was chosen. */
export function choiceStatus(item: NewsItem): string | null {
  if (item.answer === null || item.answer === undefined) return null;
  return item.answer.state === 'done' ? `Scelta il ${item.answer.at}: Claude Code l’ha già letta` : `Scelta il ${item.answer.at}: Claude Code la leggerà a inizio sessione`;
}

/** Marks an entry as chosen, without reading again. */
export function markChosen(projects: FollowedProject[], key: string, at: string): FollowedProject[] {
  return projects.map((project) =>
    project.news === null
      ? project
      : {
          ...project,
          news: { ...project.news, items: project.news.items.map((item) => (item.key === key && (item.answer === null || item.answer === undefined) ? { ...item, answer: { state: 'new' as const, at } } : item)) },
        },
  );
}

/** The link of a commit on the page of its project. */
export function commitUrl(project: FollowedProject, sha: string): string {
  return `${project.page}/commit/${sha}`;
}
