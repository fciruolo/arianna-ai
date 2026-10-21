/**
 * «Seguiti» (D-272): one page for what Arianna follows on GitHub for ideas —
 * projects and accounts (D-202, D-271), the releases of oMLX (D-265), the
 * news of Open Design (D-186) — and, as a list with a link, the sources of
 * the catalogs of skills (D-161) and agents (D-079), which keep being managed
 * in the settings. Pure: the rows of the catalogs come from the statuses the
 * page already reads, with no new request to GitHub.
 */
import type { AgentsStatus } from './agents-catalog.ts';
import { dayText, type CatalogJob } from './design-catalog.ts';
import type { NewsItem, NewsPair, NewsRelease } from './design-news.ts';
import type { FollowedAccount, FollowedProject } from './followed-projects.ts';
import type { OmlxReleaseView } from './omlx-release.ts';
import { settingsPathFor } from './route.ts';
import type { SkillsStatus } from './skills-catalog.ts';

export const FOLLOWED_TITLE = 'Seguiti';
export const FOLLOWED_INTRO =
  'Quello che Arianna segue su GitHub per prendere idee: progetti e account, il server dei modelli, Open Design e i cataloghi. Si legge solo quando lo chiedi tu (oMLX una volta al giorno) ed esce solo il nome del progetto; il codice non cambia da solo.';

/** Where the catalogs are managed: the sections of the settings (D-192). */
export const CATALOG_PLACES = {
  skills: { label: 'Gestisci in Skill e stili', path: settingsPathFor('skill-e-stili'), kind: 'Skill' },
  agents: { label: 'Gestisci in Catalogo agenti', path: settingsPathFor('catalogo-agenti'), kind: 'Agenti' },
} as const;

export const OPEN_DESIGN_PLACE = { label: 'Aggiorna il catalogo in Skill e stili', path: settingsPathFor('skill-e-stili') } as const;

export interface CatalogRow {
  kind: keyof typeof CATALOG_PLACES;
  /** `owner/repo`. */
  id: string;
  page: string;
  /** The version in use, in words. */
  inUse: string;
  /** The version waiting to be chosen, in words; null with none. */
  pending: string | null;
  /** A download running, or the last one failed. */
  job: string | null;
}

function versionWords(version: { committedAt: string | null } | null): string | null {
  if (version === null) return null;
  const day = dayText(version.committedAt);
  return day === null ? 'versione scaricata' : `versione del ${day}`;
}

function jobWords(job: CatalogJob | null, queued = false): string | null {
  if (job?.status === 'running') return 'download in corso';
  if (queued) return 'in coda per il download';
  if (job?.status === 'failed') return 'ultimo download non riuscito';
  return null;
}

function row(kind: CatalogRow['kind'], source: { id: string; page: string; adopted: { committedAt: string | null } | null; pending: { committedAt: string | null } | null; job: CatalogJob | null }, queued = false): CatalogRow {
  const pending = versionWords(source.pending);
  return {
    kind,
    id: source.id,
    page: source.page,
    inUse: source.adopted === null ? 'non ancora scaricata' : `in uso la ${versionWords(source.adopted) ?? ''}`,
    pending: pending === null ? null : `in attesa la ${pending}`,
    job: jobWords(source.job, queued),
  };
}

/**
 * The sources of the two catalogs, skills first. Open Design among the skills
 * is left out: it has its own section on the page. A status that did not load
 * gives no rows.
 */
export function catalogRows(skills: SkillsStatus | null, agents: AgentsStatus | null): CatalogRow[] {
  return [
    ...(skills?.sources ?? []).filter((source) => !source.readOnly).map((source) => row('skills', source)),
    ...(agents?.sources ?? []).map((source) => row('agents', source, source.queued)),
  ];
}

/** What the grid of «Seguiti» shows (D-272): one large card per project, account, oMLX and Open Design. */
export type CardKind = 'project' | 'account' | 'omlx' | 'open-design';

/** A line of a card that the search reads: a release, an entry of the news, a new repository. */
export interface CardRow {
  kind: 'release' | 'news' | 'repo';
  /** What the result shows. */
  text: string;
  /** Read by the search too, shown only around a hit: notes, summary, commits, description. */
  extra: string;
}

export interface FollowedCard {
  /** `project:<id>`, `account:<id>`, `omlx`, `open-design`. */
  key: string;
  kind: CardKind;
  title: string;
  page: string;
  description: string;
  /** The last release seen; null when none. */
  release: string | null;
  checkedAt: string | null;
  /** How many news (entries or new repositories), and the first three. */
  count: number;
  top: string[];
  /** A word on the card: «Account», «Server dei modelli», «Stili», «Aggiornamento». */
  tag: string | null;
  rows: CardRow[];
}

interface NewsLike {
  items: NewsItem[];
  releases: NewsRelease[];
}

function newsRows(news: NewsLike | null): CardRow[] {
  if (news === null) return [];
  return [
    ...news.releases.map((release): CardRow => ({ kind: 'release', text: release.name, extra: release.notes })),
    ...news.items.map((item): CardRow => ({ kind: 'news', text: item.title, extra: [item.summary, ...item.commits.map((change) => change.message)].join('\n') })),
  ];
}

export interface FollowedSources {
  projects: FollowedProject[];
  accounts: FollowedAccount[];
  omlx: OmlxReleaseView | null;
  openDesign: NewsPair | null;
}

/** The cards of the grid: projects in their order, then accounts, oMLX and Open Design. */
export function followedCards(sources: FollowedSources): FollowedCard[] {
  const cards: FollowedCard[] = [];
  for (const project of sources.projects) {
    if (project.catalog) continue;
    const items = project.news?.items ?? [];
    cards.push({
      key: `project:${project.id}`,
      kind: 'project',
      title: project.id,
      page: project.page,
      description: project.description ?? '',
      release: project.seen,
      checkedAt: project.checkedAt,
      count: items.length,
      top: items.slice(0, 3).map((item) => item.title),
      tag: null,
      rows: newsRows(project.news),
    });
  }
  for (const account of sources.accounts) {
    cards.push({
      key: `account:${account.id}`,
      kind: 'account',
      title: account.id,
      page: account.page,
      description: account.firstCount === null ? 'Account GitHub: i repository nuovi, da seguire uno a uno.' : `Account GitHub: ${String(account.firstCount)} repository al primo controllo, poi i nuovi.`,
      release: null,
      checkedAt: account.checkedAt,
      count: account.fresh.length,
      top: account.fresh.slice(0, 3).map((repo) => repo.name),
      tag: 'Account',
      rows: account.fresh.map((repo): CardRow => ({ kind: 'repo', text: repo.id, extra: repo.description })),
    });
  }
  const omlx = sources.omlx;
  if (omlx !== null) {
    const items = omlx.news?.items ?? [];
    cards.push({
      key: 'omlx',
      kind: 'omlx',
      title: 'oMLX',
      page: omlx.latest?.url ?? 'https://github.com/jundot/omlx',
      description: `Il server dei modelli sul Mac: installata ${omlx.installed.version === null ? 'una versione non ancora letta' : `la ${omlx.installed.version}`}.`,
      release: omlx.latest?.version ?? null,
      checkedAt: omlx.checkedAt,
      count: items.length,
      top: items.slice(0, 3).map((item) => item.title),
      tag: omlx.update ? 'Aggiornamento' : 'Server dei modelli',
      rows: newsRows(omlx.news),
    });
  }
  const pair = sources.openDesign;
  if (pair !== null) {
    const news = pair.pending ?? pair.adopted;
    const items = news?.items ?? [];
    cards.push({
      key: 'open-design',
      kind: 'open-design',
      title: 'nexu-io/open-design',
      page: 'https://github.com/nexu-io/open-design',
      description: 'Gli stili e le skill del Designer; le novità del programma arrivano con il catalogo.',
      release: news?.releases[0]?.name ?? null,
      checkedAt: news?.fetchedAt ?? null,
      count: items.length,
      top: items.slice(0, 3).map((item) => item.title),
      tag: 'Stili',
      rows: newsRows(news),
    });
  }
  return cards;
}

/** A piece of a text, a hit of the search or not. */
export interface Segment {
  text: string;
  hit: boolean;
}

/** The text cut around every occurrence of the query, ignoring case. */
export function highlight(text: string, query: string): Segment[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [{ text, hit: false }];
  const lower = text.toLowerCase();
  // toLowerCase may change the length of a few characters: then the text as it is, without marks.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const segments: Segment[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) segments.push({ text: text.slice(from, at), hit: false });
    segments.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) segments.push({ text: text.slice(from), hit: false });
  return segments;
}

/** A few words of a long text around the first hit, on one line; empty without a hit. */
export function snippet(text: string, query: string, around = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const needle = query.trim().toLowerCase();
  const at = needle === '' ? -1 : flat.toLowerCase().indexOf(needle);
  if (at < 0) return '';
  const start = Math.max(0, at - around);
  const end = Math.min(flat.length, at + needle.length + around);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export const ROW_KIND_TEXT: Record<CardRow['kind'], string> = { release: 'Release', news: 'Novità', repo: 'Repository nuovo' };

export interface SearchResult {
  cardKey: string;
  /** The name of the project the row belongs to. */
  source: string;
  kind: CardRow['kind'];
  text: string;
  /** The words around a hit found only in notes, summary, commits or description; empty otherwise. */
  context: string;
}

/**
 * The search of «Seguiti» (D-272), all on the page, no request: the cards
 * that match (by name, description or one of their rows) and the rows found.
 * An empty query keeps every card and finds no row.
 */
export function searchFollowed(cards: readonly FollowedCard[], query: string): { cards: FollowedCard[]; results: SearchResult[] } {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { cards: [...cards], results: [] };
  const has = (text: string): boolean => text.toLowerCase().includes(needle);
  const results: SearchResult[] = [];
  const found: FollowedCard[] = [];
  for (const card of cards) {
    const rows = card.rows.filter((row) => has(row.text) || has(row.extra));
    for (const row of rows) results.push({ cardKey: card.key, source: card.title, kind: row.kind, text: row.text, context: has(row.text) ? '' : snippet(row.extra, query) });
    if (rows.length > 0 || has(card.title) || has(card.description)) found.push(card);
  }
  return { cards: found, results };
}

/** «Nessuna novità con …»: what the page says when the search finds nothing. */
export function noResultText(query: string): string {
  return `Nessuna novità con «${query.trim()}».`;
}
