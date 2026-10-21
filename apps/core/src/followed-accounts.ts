import { CatalogError, cleanLine } from './git-catalog.ts';
import { fetchFailure, NewsShapeError } from './design-news.ts';
import type { GithubGet } from './github-api.ts';
import type { CatalogGateway } from './git-catalog.ts';

/**
 * The accounts followed for ideas (D-271, after D-202): a GitHub user or
 * organization, `https://github.com/<owner>`, whose **new** public
 * repositories the user reads at each check, each with «Segui», which adds
 * it to the projects followed (their releases are read only from then on).
 * The source is the public API of GitHub in read only, the same client of
 * D-186: `/users/<owner>/repos` (it answers for organizations too, so one
 * request tells nothing new about the kind of account), the newest first by
 * date of creation, 100 per page. Only the name of the account leaves, in
 * the address, through the gateway as L0 towards the web. Never a clone,
 * never code of a repository run.
 *
 * The first check records the repositories there are as already seen (up to
 * 5 pages, 500 repositories) and says how many; the later ones read pages
 * until one holds a repository already seen (at most 3: GitHub allows 60
 * requests an hour without an account), and what is new — not a fork, not
 * archived, public — becomes the list of the check. A repository made public
 * long after it was created may be missed: it is older than the ones seen.
 * And if every repository seen were deleted or renamed, the next check would
 * give the newest ones (at most 3 pages) as new: rare, and only one list.
 */

export const MAX_ACCOUNTS = 5;
export const ACCOUNT_PER_PAGE = 100;
/** Pages read at the first check, and at the later ones. */
export const FIRST_PAGES = 5;
export const LATER_PAGES = 3;
/** Names kept as seen, the newest first. */
export const MAX_KNOWN = 2000;
/** New repositories kept from one check. */
export const MAX_FRESH = 30;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** The owner as GitHub allows it: letters, digits, single dashes inside, at most 39. */
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}';
const ACCOUNT_URL = new RegExp(`^https://github\\.com/(${OWNER})$`);
/** The id of an account: its name, lowercase (no `/`, unlike a project). */
export const ACCOUNT_ID = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const LICENSE = /^[A-Za-z0-9.+-]{1,64}$/;

export interface FollowedAccount {
  /** The owner, lowercase. */
  id: string;
  page: string;
  addedAt: string;
}

/** A new repository of an account, as the page shows it. */
export interface AccountRepo {
  /** `owner/repo`, lowercase: what «Segui» adds. */
  id: string;
  /** The name as GitHub writes it. */
  name: string;
  page: string;
  description: string;
  createdAt: string;
  /** SPDX id, when GitHub detects one. */
  license: string | null;
}

export interface AccountState {
  version: 1;
  id: string;
  /** The names (lowercase) already seen; null until the first check went through. */
  known: string[] | null;
  /** How many public repositories the first check recorded as seen (forks and archived ones apart). */
  firstCount: number | null;
  checkedAt: string | null;
  message: string | null;
  /** The new repositories of the last check that found some, and when. */
  fresh: AccountRepo[];
  freshAt: string | null;
}

export interface AccountView extends FollowedAccount {
  checking: boolean;
  checkedAt: string | null;
  message: string | null;
  firstCount: number | null;
  freshAt: string | null;
  /** `followed`: already among the projects followed. */
  fresh: (AccountRepo & { followed: boolean })[];
}

export interface AccountCheckDeps {
  get: GithubGet;
  /** Asked with the whole address before each request (L0, web). */
  gateway: CatalogGateway;
  now?: () => Date;
}

/** `https://github.com/<owner>`, a trailing `/` allowed; anything else is not an account. */
export function parseAccountUrl(value: unknown): FollowedAccount | undefined {
  if (typeof value !== 'string') return undefined;
  const match = ACCOUNT_URL.exec(value.trim().replace(/\/$/, ''));
  if (match === null) return undefined;
  const id = (match[1] ?? '').toLowerCase();
  return { id, page: `https://github.com/${id}`, addedAt: '' };
}

export function emptyAccountState(id: string): AccountState {
  return { version: 1, id, known: null, firstCount: null, checkedAt: null, message: null, fresh: [], freshAt: null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function isRepo(value: unknown, owner: string): value is AccountRepo {
  const repo = record(value);
  if (repo === undefined || typeof repo.name !== 'string' || !REPO_NAME.test(repo.name)) return false;
  const id = `${owner}/${repo.name.toLowerCase()}`;
  return (
    repo.id === id &&
    repo.page === `https://github.com/${id}` &&
    typeof repo.description === 'string' &&
    typeof repo.createdAt === 'string' &&
    isoDate(repo.createdAt) === repo.createdAt &&
    (repo.license === null || (typeof repo.license === 'string' && LICENSE.test(repo.license)))
  );
}

/** The state file of an account as this module wrote it; undefined for anything else. */
export function parseAccountState(value: unknown, id: string): AccountState | undefined {
  const state = record(value);
  if (state === undefined || state.version !== 1 || state.id !== id) return undefined;
  if (state.known !== null && !(Array.isArray(state.known) && state.known.every((name) => typeof name === 'string' && REPO_NAME.test(name)))) return undefined;
  if (state.firstCount !== null && !(Number.isInteger(state.firstCount) && (state.firstCount as number) >= 0)) return undefined;
  for (const field of ['checkedAt', 'message', 'freshAt'] as const) {
    if (state[field] !== null && typeof state[field] !== 'string') return undefined;
  }
  if (!Array.isArray(state.fresh) || !state.fresh.every((repo) => isRepo(repo, id))) return undefined;
  return state as unknown as AccountState;
}

interface Listed {
  /** Lowercase. */
  name: string;
  /** Null for what is never news: a fork, an archived, private or disabled repository. */
  repo: AccountRepo | null;
}

/** One page of `/users/<owner>/repos`; repositories of another owner or with a strange name are dropped. */
export function parseRepoPage(value: unknown, owner: string): Listed[] {
  if (!Array.isArray(value)) throw new NewsShapeError('not a list of repositories');
  return value.flatMap((raw): Listed[] => {
    const item = record(raw);
    if (item === undefined || typeof item.full_name !== 'string') return [];
    const [itemOwner, name, ...rest] = item.full_name.split('/');
    if (rest.length > 0 || itemOwner?.toLowerCase() !== owner || name === undefined || !REPO_NAME.test(name) || name === '.' || name === '..') return [];
    const lower = name.toLowerCase();
    const createdAt = isoDate(item.created_at);
    const excluded = item.fork !== false || item.archived === true || item.private !== false || item.disabled === true || createdAt === undefined;
    if (excluded) return [{ name: lower, repo: null }];
    const spdx = record(item.license)?.spdx_id;
    const id = `${owner}/${lower}`;
    return [
      {
        name: lower,
        repo: {
          id,
          name,
          page: `https://github.com/${id}`,
          description: cleanLine(item.description, 300),
          createdAt,
          license: typeof spdx === 'string' && LICENSE.test(spdx) && spdx !== 'NOASSERTION' ? spdx : null,
        },
      },
    ];
  });
}

function failure(error: unknown): string {
  if (error instanceof Error && (error as Error & { code?: string }).code === 'not-found') return 'GitHub non trova l’account';
  return fetchFailure(error);
}

function repositories(count: number): string {
  return count === 1 ? '1 repository' : `${String(count)} repository`;
}

/**
 * One check of an account. Never throws: a failure keeps what was seen and
 * says why. The first check records the repositories as seen, with no news.
 */
export async function checkAccount(deps: AccountCheckDeps, account: FollowedAccount, previous: AccountState): Promise<AccountState> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const first = previous.known === null;
  const known = new Set(previous.known ?? []);
  const pages = first ? FIRST_PAGES : LATER_PAGES;
  const listed: Listed[] = [];
  let more = false;
  for (let page = 1; page <= pages; page += 1) {
    const path = `/users/${account.id}/repos?type=owner&sort=created&direction=desc&per_page=${String(ACCOUNT_PER_PAGE)}&page=${String(page)}`;
    let entries: Listed[];
    try {
      await deps.gateway(`https://api.github.com${path}`);
      const answer = await deps.get(path, MAX_PAGE_BYTES);
      if (!Array.isArray(answer)) throw new NewsShapeError('not a list of repositories');
      entries = parseRepoPage(answer, account.id);
      // The length GitHub gave, not what was kept: a short page is the last one.
      if (answer.length < ACCOUNT_PER_PAGE) {
        listed.push(...entries);
        break;
      }
    } catch (error) {
      return { ...previous, checkedAt: now, message: `Repository non disponibili: ${failure(error)}.` };
    }
    listed.push(...entries);
    if (!first && entries.some((entry) => known.has(entry.name))) break;
    if (page === pages) more = true;
  }
  const names = [...new Set([...listed.map((entry) => entry.name), ...known])].slice(0, MAX_KNOWN);
  if (first) {
    const count = listed.filter((entry) => entry.repo !== null).length;
    const partial = more ? ` fra i ${String(listed.length)} più recenti (fork compresi: gli altri non li ho letti)` : '';
    return {
      ...previous,
      known: names,
      firstCount: count,
      checkedAt: now,
      message: `Primo controllo: ${repositories(count)} pubblici già presenti${partial}, fork e archiviati esclusi, segnati come già visti. Da ora segnalo quelli nuovi.`,
      fresh: [],
      freshAt: null,
    };
  }
  const fresh: AccountRepo[] = [];
  for (const entry of listed) {
    if (entry.repo !== null && !known.has(entry.name) && !fresh.some((repo) => repo.id === entry.repo?.id)) fresh.push(entry.repo);
  }
  if (fresh.length === 0) return { ...previous, known: names, checkedAt: now, message: 'Nessun repository nuovo.' };
  const shown = fresh.slice(0, MAX_FRESH);
  const notes = [
    fresh.length > MAX_FRESH ? ` Mostro i ${String(MAX_FRESH)} più recenti.` : '',
    more ? ' Potrebbero essercene altri più vecchi: ho letto solo le prime pagine.' : '',
  ].join('');
  return { ...previous, known: names, checkedAt: now, message: `${fresh.length === 1 ? '1 repository nuovo' : `${String(fresh.length)} repository nuovi`}.${notes}`, fresh: shown, freshAt: now };
}

/** The error of an address that is neither a repository nor an account of GitHub. */
export function invalidAddress(): CatalogError {
  return new CatalogError('invalid', 'the address must be https://github.com/<owner>/<repo> or https://github.com/<owner>');
}
