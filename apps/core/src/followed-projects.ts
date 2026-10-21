import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CatalogError, cleanLine, readRegular, releaseBusy, takeBusy, writeAtomic, type CatalogGateway } from './git-catalog.ts';
import {
  checkModelItems,
  fetchFailure,
  modelFailure,
  modelData,
  NEWS_MODEL,
  newsPrompt,
  parseCompare,
  parseReleases,
  rawItems,
  type Comparison,
  type NewsItem,
  type NewsRelease,
  type NewsSummarizer,
} from './design-news.ts';
import {
  ACCOUNT_ID,
  checkAccount,
  emptyAccountState,
  invalidAddress,
  MAX_ACCOUNTS,
  parseAccountState,
  parseAccountUrl,
  type AccountState,
  type AccountView,
  type FollowedAccount,
} from './followed-accounts.ts';
import type { GithubGet } from './github-api.ts';
import { folderOf, parseSourceUrl, SOURCE_ID } from './source-catalogs.ts';

/**
 * The projects Arianna follows for ideas (D-202, generalizing D-186 after
 * D-093): public GitHub repositories whose releases the user reads, choosing
 * for each news entry «Implementiamo» or «Non interessa». Open Design is
 * followed through its catalog (design-news.ts) and listed here as fixed;
 * the others (OpenWork by default) are read only through the public API of
 * GitHub, in read only: the releases, and the comparison between the last
 * release seen and the newest one (messages of the commits, names of the
 * files). Never a clone, never code of the project run. Only the name of the
 * repository leaves, in the address, through the gateway as L0 towards the
 * web. Checked only when the user asks («Controlla novità» or
 * `pnpm projects:followed check`); no scheduled task (as D-186).
 *
 * Accounts too (D-271, followed-accounts.ts): `https://github.com/<owner>`,
 * at most 5, whose new repositories the user may follow with «Segui».
 *
 * Files in `data/catalogs/followed/`: `projects.json` (the list, with
 * `accounts` since D-271, missing in the files written before; missing, the
 * default list with OpenWork), `<owner>__<repo>.json` (the release last seen
 * and the news of the last check) and `account-<owner>.json` (the
 * repositories seen and the new ones of the last check: no `__`, so it never
 * meets the file of a project). A busy file per project or account keeps the
 * core and the command from checking the same one together.
 */

export const FOLLOWED_FOLDER = 'followed';
const LIST_FILE = 'projects.json';
const LIST_BUSY = 'projects.busy';
export const MAX_PROJECTS = 20;
/** Followed by default, until the user removes it (D-093). */
export const DEFAULT_PROJECTS = ['https://github.com/different-ai/openwork'] as const;
/** Followed through its catalog (D-160, D-186): never added here. */
export const CATALOG_PROJECT = { id: 'nexu-io/open-design', page: 'https://github.com/nexu-io/open-design' } as const;

const MAX_COMPARE_BYTES = 16 * 1024 * 1024;
const MAX_RELEASES_BYTES = 4 * 1024 * 1024;
const COMPARE_PAGE = 250;
/** A tag that may go in the path of the comparison: no `..`, nothing but these characters. */
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export const PROJECT_PROMPT = newsPrompt('a software project the user follows for ideas', 'new functions of the software first, then notable fixes');

export interface FollowedProject {
  /** `owner/repo`, lowercase. */
  id: string;
  page: string;
  addedAt: string;
  /**
   * The description GitHub gives, when the project was followed with «Segui»
   * from the new repositories of an account (D-271, D-272): taken from what
   * that check already read, never asked again. Absent otherwise.
   */
  description?: string;
}

export interface ProjectNews {
  version: 1;
  repository: string;
  /** The release the comparison starts from; null when there was none to compare with. */
  from: string | null;
  /** The newest release read. */
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

/** What is kept per project: the release last seen, the last check and its news. */
export interface ProjectState {
  version: 1;
  id: string;
  /** The tag of the release last seen: the next check compares from it. */
  seen: string | null;
  checkedAt: string | null;
  /** What the last check found, in Italian (a news, none, or why not). */
  message: string | null;
  news: ProjectNews | null;
}

export interface ProjectView extends FollowedProject {
  /** Open Design: its news come with the catalog (Impostazioni → Skill e stili). */
  catalog: boolean;
  checking: boolean;
  seen: string | null;
  checkedAt: string | null;
  message: string | null;
  news: ProjectNews | null;
}

export interface FollowedDeps {
  /** `data/catalogs` of ARIANNA_HOME. */
  dir: string;
  get: GithubGet;
  /** Asked with the whole address before each request (L0, web). */
  gateway: CatalogGateway;
  summarize?: NewsSummarizer;
  noModel?: string;
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
  now?: () => Date;
}

export interface FollowedProjects {
  list(): ProjectView[];
  /** The accounts followed (D-271), with the new repositories of their last check. */
  accounts(): AccountView[];
  /** A repository becomes a project, `https://github.com/<owner>` an account (D-271). */
  add(url: unknown): FollowedProject | FollowedAccount;
  remove(value: unknown): FollowedProject | FollowedAccount;
  /** Starts a check of a project or an account in the background; refused while one of the same runs. */
  check(value: unknown): void;
  /** Every check started by this process. */
  idle(): Promise<void>;
  /** An entry of the news of a project, by its key. */
  findItem(key: string): { project: FollowedProject; news: ProjectNews; item: NewsItem } | undefined;
}

/**
 * The key of an entry: `gh-<owner>__<repo>-<short sha>`, `-2` for a repeated
 * one. Owners have no `_`, so the first `__` always splits two ids apart.
 */
export const PROJECT_KEY = /^gh-[a-z0-9][a-z0-9-]{0,38}__[a-z0-9._-]{1,100}-[0-9a-f]{7}(?:-\d{1,2})?$/;

export function keyPrefix(id: string): string {
  return `gh-${folderOf(id)}-`;
}

/** A tag as it may be written in a line of the code (RISPOSTE.md) or in the path of the comparison. */
export function isTag(value: unknown): value is string {
  return typeof value === 'string' && TAG.test(value) && !value.includes('..');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readJson(path: string, max: number): unknown {
  const read = readRegular(path, max);
  if (read === undefined || 'refused' in read) return undefined;
  try {
    return JSON.parse(read.buffer.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The accounts as written (D-271): none in a file written before them. */
export function readAccounts(base: string): FollowedAccount[] {
  const parsed = record(readJson(join(base, LIST_FILE), 64 * 1024));
  if (parsed === undefined || parsed.version !== 1 || !Array.isArray(parsed.accounts)) return [];
  return parsed.accounts.flatMap((raw) => {
    const item = record(raw);
    if (item === undefined || typeof item.addedAt !== 'string') return [];
    const account = parseAccountUrl(item.page);
    return account !== undefined && account.id === item.id ? [{ ...account, addedAt: item.addedAt }] : [];
  })
    .filter((account, index, all) => all.findIndex((other) => other.id === account.id) === index)
    .slice(0, MAX_ACCOUNTS);
}

/** The list as written; undefined when the file is missing (the default list applies). */
export function readList(base: string): FollowedProject[] | undefined {
  const parsed = record(readJson(join(base, LIST_FILE), 64 * 1024));
  if (parsed === undefined) return undefined;
  if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return [];
  return parsed.projects.flatMap((raw) => {
    const item = record(raw);
    if (item === undefined || typeof item.page !== 'string' || typeof item.addedAt !== 'string') return [];
    try {
      const ref = parseSourceUrl(item.page);
      if (ref.id !== item.id || ref.id === CATALOG_PROJECT.id) return [];
      const description = cleanLine(item.description, 300);
      return [{ id: ref.id, page: ref.page, addedAt: item.addedAt, ...(description === '' ? {} : { description }) }];
    } catch {
      return [];
    }
  });
}

function isNewsItem(value: unknown): value is NewsItem {
  const item = record(value);
  return (
    item !== undefined &&
    typeof item.key === 'string' &&
    PROJECT_KEY.test(item.key) &&
    typeof item.title === 'string' &&
    typeof item.summary === 'string' &&
    Array.isArray(item.commits) &&
    item.commits.every((raw) => {
      const commit = record(raw);
      return commit !== undefined && typeof commit.sha === 'string' && /^[0-9a-f]{40}$/.test(commit.sha) && typeof commit.short === 'string' && typeof commit.message === 'string';
    })
  );
}

/** The state file of a project as this module wrote it; undefined for anything else. */
export function parseState(value: unknown, id: string): ProjectState | undefined {
  const state = record(value);
  if (state === undefined || state.version !== 1 || state.id !== id) return undefined;
  if (state.seen !== null && !isTag(state.seen)) return undefined;
  const news = state.news === null ? null : record(state.news);
  if (news === undefined) return undefined;
  // `repository`, `from` and `to` reach a line of the code in RISPOSTE.md: checked again here.
  if (
    news !== null &&
    (news.version !== 1 ||
      news.repository !== id ||
      (news.from !== null && !isTag(news.from)) ||
      !isTag(news.to) ||
      !Array.isArray(news.items) ||
      !news.items.every(isNewsItem) ||
      !Array.isArray(news.releases))
  ) {
    return undefined;
  }
  return state as unknown as ProjectState;
}

function emptyState(id: string): ProjectState {
  return { version: 1, id, seen: null, checkedAt: null, message: null, news: null };
}

/** The releases with a tag the comparison may use, newest first. */
function usable(releases: NewsRelease[]): NewsRelease[] {
  return releases.filter((release) => isTag(release.tag));
}

/**
 * One check of a project: the releases, and when there is one newer than
 * `state.seen` the comparison and the entries (model or raw list). Never
 * throws: a failure keeps the release seen and says why.
 */
export async function checkProject(deps: Omit<FollowedDeps, 'dir' | 'onEvent'>, project: FollowedProject, previous: ProjectState): Promise<ProjectState> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const keep = (message: string): ProjectState => ({ ...previous, checkedAt: now, message });
  // As many as parseReleases keeps (the 10 newest): a release seen older than those is compared with the newest alone.
  const releasesPath = `/repos/${project.id}/releases?per_page=10`;
  let published: NewsRelease[];
  try {
    await deps.gateway(`https://api.github.com${releasesPath}`);
    published = parseReleases(await deps.get(releasesPath, MAX_RELEASES_BYTES), null, project.page);
  } catch (error) {
    return keep(`Novità non disponibili: ${fetchFailure(error)}.`);
  }
  const releases = usable(published);
  const latest = releases[0];
  if (latest === undefined) {
    return keep(published.length === 0 ? 'Il progetto non ha release pubblicate su GitHub: nessuna novità.' : 'Il progetto ha release, ma con nomi che non so usare per il confronto: nessuna novità.');
  }
  if (previous.seen === latest.tag) return keep(`Nessuna release nuova dopo ${latest.tag}.`);
  // At the first check the comparison starts from the release before the newest, so there is something to read.
  const fromTag = previous.seen ?? releases[1]?.tag ?? null;
  const base = {
    version: 1 as const,
    repository: project.id,
    from: fromTag,
    to: latest.tag,
    fetchedAt: now,
    source: null,
    model: null,
    items: [] as NewsItem[],
    commits: 0,
    truncated: false,
  };
  const at = fromTag === null ? -1 : releases.findIndex((release) => release.tag === fromTag);
  const between = at < 0 ? [latest] : releases.slice(0, at);
  if (fromTag === null) {
    const news: ProjectNews = { ...base, releases: between, state: 'missing', message: `Una sola release (${latest.tag}): da ora segnalo quelle nuove.` };
    return { ...previous, seen: latest.tag, checkedAt: now, message: news.message, news };
  }
  let comparison: Comparison;
  try {
    const comparePath = `/repos/${project.id}/compare/${fromTag}...${latest.tag}?per_page=${String(COMPARE_PAGE)}`;
    await deps.gateway(`https://api.github.com${comparePath}`);
    comparison = parseCompare(await deps.get(comparePath, MAX_COMPARE_BYTES));
  } catch (error) {
    // A release seen that GitHub no longer finds would block every check: start again from the newest.
    if (error instanceof Error && (error as Error & { code?: string }).code === 'not-found') {
      return { ...previous, seen: latest.tag, checkedAt: now, message: `GitHub non trova il confronto da ${fromTag}: da ora segnalo le release dopo ${latest.tag}.` };
    }
    return keep(`Novità non disponibili: ${fetchFailure(error)}.`);
  }
  const found = { ...base, releases: between, commits: comparison.total, truncated: comparison.truncated };
  const done = (news: ProjectNews): ProjectState => ({ ...previous, seen: latest.tag, checkedAt: now, message: `Release nuova: ${latest.tag}.`, news });
  if (comparison.commits.length === 0) return done({ ...found, state: 'ready', message: 'Nessun commit fra le due release.' });
  const prefix = keyPrefix(project.id);
  const raw = (why: string): ProjectNews => ({ ...found, state: 'ready', source: 'raw', message: `Elenco dei commit per tipo: ${why}.`, items: rawItems(comparison.commits, prefix) });
  if (deps.summarize === undefined) return done(raw(deps.noModel ?? 'il modello locale non è configurato'));
  const data = modelData(comparison.commits, between);
  let result;
  try {
    result = await deps.summarize(data.text);
  } catch (error) {
    return done(raw(modelFailure(error)));
  }
  const checked = checkModelItems(result, data.given, prefix);
  if ('reason' in checked) return done(raw(`la risposta del modello locale non ha passato i controlli (${checked.reason})`));
  return done({ ...found, state: 'ready', source: 'model', model: cleanLine(result.model, 80) || NEWS_MODEL, message: null, items: checked.items });
}

export function createFollowedProjects(deps: FollowedDeps): FollowedProjects {
  const base = join(deps.dir, FOLLOWED_FOLDER);
  const running = new Map<string, Promise<void>>();
  const now = (): Date => deps.now?.() ?? new Date();
  const statePath = (id: string): string => join(base, `${folderOf(id)}.json`);
  const accountPath = (id: string): string => join(base, `account-${id}.json`);
  /** The key of a running check: a project id has a `/`, an account one never. */
  const accountKey = (id: string): string => `account:${id}`;

  function followed(): FollowedProject[] {
    const list = readList(base);
    if (list !== undefined) return list;
    return DEFAULT_PROJECTS.map((url) => {
      const { id, page } = parseSourceUrl(url);
      return { id, page, addedAt: '' };
    });
  }

  function readState(id: string): ProjectState {
    return parseState(readJson(statePath(id), 4 * 1024 * 1024), id) ?? emptyState(id);
  }

  function readAccountState(id: string): AccountState {
    return parseAccountState(readJson(accountPath(id), 1024 * 1024), id) ?? emptyAccountState(id);
  }

  /** The account a value names (its id or its address); undefined when it names no account. */
  function accountOf(value: unknown): FollowedAccount | undefined {
    const id = typeof value === 'string' && ACCOUNT_ID.test(value) ? value : parseAccountUrl(value)?.id;
    if (id === undefined) return undefined;
    const account = readAccounts(base).find((item) => item.id === id);
    if (account === undefined) throw new CatalogError('not-found', 'no such followed account');
    return account;
  }

  function find(value: unknown): FollowedProject {
    const id = typeof value === 'string' && SOURCE_ID.test(value) ? value : parseSourceUrl(value).id;
    if (id === CATALOG_PROJECT.id) throw new CatalogError('conflict', 'Open Design is followed through its catalog');
    const project = followed().find((item) => item.id === id);
    if (project === undefined) throw new CatalogError('not-found', 'no such followed project');
    return project;
  }

  function changeList(change: (list: FollowedProject[]) => FollowedProject[], changeAccounts: (list: FollowedAccount[]) => FollowedAccount[] = (list) => list): void {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const busy = join(base, LIST_BUSY);
    if (!takeBusy(busy, token)) throw new CatalogError('conflict', 'the list of projects is being changed by another process');
    try {
      writeAtomic(join(base, LIST_FILE), { version: 1, projects: change(followed()), accounts: changeAccounts(readAccounts(base)) });
    } finally {
      releaseBusy(busy, token);
    }
  }

  function accounts(): AccountView[] {
    const projects = new Set(followed().map((project) => project.id));
    return readAccounts(base).map((account) => {
      const state = readAccountState(account.id);
      return {
        ...account,
        checking: running.has(accountKey(account.id)),
        checkedAt: state.checkedAt,
        message: state.message,
        firstCount: state.firstCount,
        freshAt: state.freshAt,
        fresh: state.fresh.map((repo) => ({ ...repo, followed: projects.has(repo.id) || repo.id === CATALOG_PROJECT.id })),
      };
    });
  }

  function addAccount(account: FollowedAccount): FollowedAccount {
    const added: FollowedAccount = { ...account, addedAt: now().toISOString() };
    changeList(
      (list) => list,
      (current) => {
        if (current.some((item) => item.id === added.id)) throw new CatalogError('conflict', 'this account is already followed');
        if (current.length >= MAX_ACCOUNTS) throw new CatalogError('invalid', `at most ${String(MAX_ACCOUNTS)} accounts`);
        return [...current, added];
      },
    );
    deps.onEvent?.('followed.account_added', { account: added.id });
    return added;
  }

  function checkAccountNow(account: FollowedAccount): void {
    const key = accountKey(account.id);
    if (running.has(key)) throw new CatalogError('conflict', 'a check of this account is already running');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const busy = join(base, `account-${account.id}.busy`);
    const token = randomUUID();
    if (!takeBusy(busy, token)) throw new CatalogError('conflict', 'another process is checking this account');
    const task = (async () => {
      try {
        const before = readAccountState(account.id);
        const next = await checkAccount(deps, account, before);
        // Removed meanwhile: nothing to keep.
        if (readAccounts(base).some((item) => item.id === account.id)) writeAtomic(accountPath(account.id), next);
        deps.onEvent?.('followed.account_checked', { account: account.id, first: before.known === null ? 1 : 0, fresh: next.freshAt === before.freshAt ? 0 : next.fresh.length });
      } catch {
        deps.onEvent?.('followed.account_check_failed', { account: account.id });
      } finally {
        releaseBusy(busy, token);
        running.delete(key);
      }
    })();
    running.set(key, task);
  }

  function list(): ProjectView[] {
    const catalog: ProjectView = { ...CATALOG_PROJECT, addedAt: '', catalog: true, checking: false, seen: null, checkedAt: null, message: null, news: null };
    return [
      catalog,
      ...followed().map((project) => {
        const state = readState(project.id);
        return { ...project, catalog: false, checking: running.has(project.id), seen: state.seen, checkedAt: state.checkedAt, message: state.message, news: state.news };
      }),
    ];
  }

  function add(url: unknown): FollowedProject | FollowedAccount {
    const account = parseAccountUrl(url);
    if (account !== undefined) return addAccount(account);
    let ref;
    try {
      ref = parseSourceUrl(url);
    } catch {
      throw invalidAddress();
    }
    if (ref.id === CATALOG_PROJECT.id) throw new CatalogError('conflict', 'Open Design is already followed through its catalog');
    // Followed from the new repositories of an account: its description comes with it, nothing asked of GitHub.
    const description = readAccounts(base)
      .flatMap((account) => readAccountState(account.id).fresh)
      .find((repo) => repo.id === ref.id)?.description;
    const added: FollowedProject = { id: ref.id, page: ref.page, addedAt: now().toISOString(), ...(description === undefined || description === '' ? {} : { description }) };
    changeList((current) => {
      if (current.some((item) => item.id === ref.id)) throw new CatalogError('conflict', 'this project is already followed');
      if (current.length >= MAX_PROJECTS) throw new CatalogError('invalid', `at most ${String(MAX_PROJECTS)} projects`);
      return [...current, added];
    });
    deps.onEvent?.('followed.added', { project: ref.id });
    return added;
  }

  function remove(value: unknown): FollowedProject | FollowedAccount {
    const account = accountOf(value);
    if (account !== undefined) {
      if (running.has(accountKey(account.id))) throw new CatalogError('conflict', 'a check of this account is running');
      changeList(
        (list) => list,
        (current) => current.filter((item) => item.id !== account.id),
      );
      rmSync(accountPath(account.id), { force: true });
      deps.onEvent?.('followed.account_removed', { account: account.id });
      return account;
    }
    const project = find(value);
    if (running.has(project.id)) throw new CatalogError('conflict', 'a check of this project is running');
    changeList((current) => current.filter((item) => item.id !== project.id));
    rmSync(statePath(project.id), { force: true });
    deps.onEvent?.('followed.removed', { project: project.id });
    return project;
  }

  function check(value: unknown): void {
    const account = accountOf(value);
    if (account !== undefined) {
      checkAccountNow(account);
      return;
    }
    const project = find(value);
    if (running.has(project.id)) throw new CatalogError('conflict', 'a check of this project is already running');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const busy = join(base, `${folderOf(project.id)}.busy`);
    const token = randomUUID();
    if (!takeBusy(busy, token)) throw new CatalogError('conflict', 'another process is checking this project');
    const task = (async () => {
      try {
        const next = await checkProject(deps, project, readState(project.id));
        // Removed meanwhile: nothing to keep.
        if (followed().some((item) => item.id === project.id)) writeAtomic(statePath(project.id), next);
        deps.onEvent?.('followed.checked', { project: project.id, state: next.news?.state ?? 'none', source: next.news?.source ?? 'none', items: next.news?.items.length ?? 0 });
      } catch {
        // A check never fails the core: a file that cannot be written leaves the old one, and says so in the log.
        deps.onEvent?.('followed.check_failed', { project: project.id });
      } finally {
        releaseBusy(busy, token);
        running.delete(project.id);
      }
    })();
    running.set(project.id, task);
  }

  return {
    list,
    accounts,
    add,
    remove,
    check,
    idle: async () => {
      await Promise.all([...running.values()]);
    },
    findItem: (key) => {
      if (!PROJECT_KEY.test(key)) return undefined;
      for (const project of followed()) {
        if (!key.startsWith(keyPrefix(project.id))) continue;
        const news = readState(project.id).news;
        const item = news?.items.find((entry) => entry.key === key);
        if (news !== null && item !== undefined) return { project, news, item };
      }
      return undefined;
    },
  };
}
