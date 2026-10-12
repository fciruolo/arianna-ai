/**
 * "Novità di Open Design" (I-21, D-186): the shapes the core gives
 * (design-news.ts) and the texts of the section in "Sviluppo di Arianna" and
 * beside the comparison of the catalog. The news is public text of a third
 * party, perhaps worded by the local model: the page shows it, never as an
 * instruction. "Da rifare nello Studio" writes it in data/dev/RISPOSTE.md.
 */

export type NewsGroup = 'feat' | 'fix' | 'styles' | 'skills' | 'other';

export interface NewsCommit {
  sha: string;
  short: string;
  message: string;
}

export interface NewsItem {
  key: string;
  title: string;
  summary: string;
  group: NewsGroup | null;
  commits: NewsCommit[];
  /** In "Sviluppo di Arianna": the entry already in RISPOSTE.md, if any. */
  answer?: { state: 'new' | 'done'; at: string } | null;
}

export interface NewsRelease {
  tag: string;
  name: string;
  publishedAt: string | null;
  url: string;
  notes: string;
}

export interface DesignNews {
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
  files: { styles: number; skills: number; other: number };
}

export interface NewsPair {
  pending: DesignNews | null;
  adopted: DesignNews | null;
  preparing: boolean;
}

export const GROUP_TEXT: Record<NewsGroup, string> = { feat: 'Funzioni', fix: 'Correzioni', styles: 'Stili', skills: 'Skill', other: 'Altro' };

export const REDO_TEXT = 'Da rifare nello Studio';

/** The entries as the page lists them: in groups for the raw list, one group for the entries of the model. */
export function groupNews(items: readonly NewsItem[]): { title: string | null; items: NewsItem[] }[] {
  const groups: { title: string | null; items: NewsItem[] }[] = [];
  for (const item of items) {
    const title = item.group === null ? null : GROUP_TEXT[item.group];
    const last = groups.at(-1);
    if (last?.title === title) last.items.push(item);
    else groups.push({ title, items: [item] });
  }
  return groups;
}

/** Where the entries come from, in one line. */
export function sourceText(news: DesignNews): string {
  const range = `${news.from === null ? '?' : news.from.slice(0, 7)} → ${news.to.slice(0, 7)}`;
  const files = news.files.styles + news.files.skills + news.files.other;
  const counts = `${String(news.commits)} commit${files === 0 ? '' : `, ${String(files)} file cambiati`}`;
  if (news.source === 'model') return `Raggruppate dal modello locale · ${counts} · ${range}`;
  if (news.source === 'raw') return `Elenco dei commit per tipo · ${counts} · ${range}`;
  return range;
}

/** The state of the button of an entry. */
export function redoStatus(item: NewsItem): string | null {
  if (item.answer === null || item.answer === undefined) return null;
  return item.answer.state === 'done' ? `Già scelta il ${item.answer.at}: Claude Code l’ha messa nelle proposte` : `Scelta il ${item.answer.at}: Claude Code la trasformerà in una proposta`;
}

/** Marks an entry as sent, without reading again. */
export function markRedo(pair: NewsPair, key: string, at: string): NewsPair {
  const mark = (news: DesignNews | null): DesignNews | null =>
    news === null ? null : { ...news, items: news.items.map((item) => (item.key === key && (item.answer === null || item.answer === undefined) ? { ...item, answer: { state: 'new', at } } : item)) };
  return { ...pair, pending: mark(pair.pending), adopted: mark(pair.adopted) };
}

/** A news worth a section: ready with entries, or missing with its reason. */
export function shownNews(pair: NewsPair | null): { label: string; news: DesignNews }[] {
  if (pair === null) return [];
  const shown: { label: string; news: DesignNews }[] = [];
  if (pair.pending !== null) shown.push({ label: 'Versione scaricata, in attesa', news: pair.pending });
  if (pair.adopted !== null) shown.push({ label: 'Versione in uso', news: pair.adopted });
  return shown;
}
