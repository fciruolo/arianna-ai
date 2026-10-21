import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { checkModelItems, fetchFailure, modelData, modelFailure, NEWS_MODEL, newsPrompt, parseCompare, parseReleases, rawItems, type Comparison, type NewsItem, type NewsRelease, type NewsSummarizer } from './design-news.ts';
import { FOLLOWED_FOLDER, isTag, keyPrefix, parseState, type ProjectNews } from './followed-projects.ts';
import { cleanLine, readRegular, writeAtomic, type CatalogGateway } from './git-catalog.ts';
import type { GithubGet } from './github-api.ts';
import { startsOmlx } from './omlx-settings.ts';

/**
 * «Server dei modelli (oMLX)» in Impostazioni → Modelli (D-265): the version
 * of oMLX installed, read by running the command of the oMLX endpoint with
 * `--version` (nothing else is ever run), and the newest release of
 * `jundot/omlx` read from the public API of GitHub with the client and the
 * gateway of the followed projects (D-202): only the name of the repository
 * leaves, no token, never anything about the installation (the comparison
 * that feeds the news is between two public releases, never from the
 * installed version). Checked once a day by itself and when the user presses
 * «Controlla ora»; never an update: the user installs the DMG with the core
 * stopped, after Claude has read the code of the release (D-221, D-263).
 *
 * State in `data/catalogs/followed/omlx-release.json`, next to the files of
 * the followed projects; the time of the last check survives a restart, so
 * the automatic check runs at most once a day.
 */

export const OMLX_REPOSITORY = 'jundot/omlx';
export const OMLX_PAGE = `https://github.com/${OMLX_REPOSITORY}`;
export const STATE_FILE = 'omlx-release.json';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How often the core looks whether the daily check is due. */
const TICK_MS = 60 * 60 * 1000;
/** After a failed check (no network, GitHub limit, gateway) the automatic one tries again after this long. */
export const RETRY_MS = 6 * 60 * 60 * 1000;
/** The first look after the start: the core is busy for a while. */
const FIRST_TICK_MS = 2 * 60 * 1000;
const VERSION_TIMEOUT_MS = 15_000;
const MAX_RELEASES_BYTES = 4 * 1024 * 1024;
const MAX_COMPARE_BYTES = 16 * 1024 * 1024;
const COMPARE_PAGE = 250;
const RELEASES_PATH = `/repos/${OMLX_REPOSITORY}/releases?per_page=10`;

/** The local model groups the changes of a release as for a followed project (D-202). */
export const OMLX_PROMPT = newsPrompt('oMLX, the local server of language models the user runs on the Mac', 'new functions and speed first, then notable fixes');

// ---------------------------------------------------------------------------
// Versions

/** Pre-releases before the release, a release, then post-releases. */
const RANK = { other: 0, dev: 1, a: 2, b: 3, rc: 4, stable: 5, post: 6 } as const;
type Rank = keyof typeof RANK;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  rank: Rank;
  /** The number after the pre- or post-release mark; 0 without one. */
  n: number;
  /** As written, without a leading `v`. */
  text: string;
}

const VERSION = /(?:^|[^0-9A-Za-z.])v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?([0-9A-Za-z.+-]*)/;
const SUFFIX: readonly [RegExp, Rank][] = [
  [/^(?:dev)[-.]?(\d*)$/i, 'dev'],
  [/^(?:a|alpha)[-.]?(\d*)$/i, 'a'],
  [/^(?:b|beta)[-.]?(\d*)$/i, 'b'],
  [/^(?:rc|c|pre|preview)[-.]?(\d*)$/i, 'rc'],
  [/^(?:post)[-.]?(\d*)$/i, 'post'],
];

/**
 * The first version in a text (`0.7.1`, `v0.7.2`, `omlx 0.6.3rc2`,
 * `0.7.2-rc.1`, `0.7.2.dev3`); undefined without one. A mark that is not
 * known counts as a pre-release, never as a stable release.
 */
export function parseVersion(text: unknown): Version | undefined {
  if (typeof text !== 'string') return undefined;
  const match = VERSION.exec(text.slice(0, 4096));
  if (match === null) return undefined;
  const [whole, major = '0', minor = '0', patch = '0', rawSuffix = ''] = match;
  // Build metadata (`+local`) says nothing about the order.
  const suffix = rawSuffix.split('+')[0]?.replace(/^[-.]/, '').replace(/\.$/, '') ?? '';
  let rank: Rank = 'stable';
  let n = 0;
  if (suffix !== '') {
    const known = SUFFIX.map(([pattern, kind]) => [pattern.exec(suffix), kind] as const).find(([found]) => found !== null);
    rank = known?.[1] ?? 'other';
    n = Number(known?.[0]?.[1] ?? '0') || 0;
  }
  const start = whole.search(/[v\d]/);
  const written = whole.slice(start).replace(/^v/, '');
  return { major: Number(major), minor: Number(minor), patch: Number(patch), rank, n, text: cleanLine(written.split('+')[0] ?? written, 40) };
}

/** Whether a version is a release for everybody: no pre-release mark (a post-release counts). */
export function isStable(version: Version): boolean {
  return version.rank === 'stable' || version.rank === 'post';
}

/** Negative when `a` comes before `b`, 0 when they are the same version. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || RANK[a.rank] - RANK[b.rank] || a.n - b.n;
}

// ---------------------------------------------------------------------------
// The command that says the version

export interface OmlxEndpoint {
  id: string;
  command?: readonly string[] | undefined;
}

const OMLX_BINARY = /^omlx(-cli)?$/;
const PYTHON = /^python(3(\.\d+)?)?$/;

/**
 * What runs to read the version of an endpoint's oMLX: its own program with
 * `--version` (`omlx`, `omlx-cli`, or `python -m omlx.cli`), only when the
 * whole command is one the core recognises as oMLX (startsOmlx). A launcher
 * in front (`uvx omlx serve`, which could download) or any other program
 * gives undefined: nothing runs.
 */
export function versionCommand(command: readonly string[] | undefined): string[] | undefined {
  if (command === undefined || !startsOmlx(command)) return undefined;
  const [program, flag, module] = command;
  if (program === undefined || program.startsWith('-')) return undefined;
  if (OMLX_BINARY.test(basename(program))) return [program, '--version'];
  if (PYTHON.test(basename(program)) && flag === '-m' && module === 'omlx.cli') return [program, '-m', 'omlx.cli', '--version'];
  return undefined;
}

/** The first endpoint whose command starts oMLX; undefined when none does. */
export function omlxEndpoint(endpoints: readonly OmlxEndpoint[]): (OmlxEndpoint & { command: readonly string[] }) | undefined {
  for (const endpoint of endpoints) {
    if (endpoint.command !== undefined && startsOmlx(endpoint.command)) return { ...endpoint, command: endpoint.command };
  }
  return undefined;
}

/** Runs a program with its arguments and gives what it printed; rejects with a code. */
export type VersionRunner = (argv: readonly string[]) => Promise<string>;

export class VersionError extends Error {
  override name = 'VersionError';
  readonly code: 'not-found' | 'timeout' | 'failed';

  constructor(code: VersionError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** execFile, never a shell: the folder of the home, the environment the servers get (no proxy, no network). */
export function createVersionRunner(options: { cwd: string; env: Record<string, string>; timeoutMs?: number }): VersionRunner {
  return (argv) =>
    new Promise((resolve, reject) => {
      const [file, ...args] = argv;
      if (file === undefined) {
        reject(new VersionError('failed', 'no program'));
        return;
      }
      execFile(
        file,
        args,
        { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? VERSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, windowsHide: true, shell: false },
        (error, stdout, stderr) => {
          if (error !== null) {
            const failure = error as NodeJS.ErrnoException & { killed?: boolean };
            if (failure.code === 'ENOENT') reject(new VersionError('not-found', 'the program is not there'));
            else if (failure.killed === true) reject(new VersionError('timeout', 'no version in time'));
            else reject(new VersionError('failed', 'the program failed'));
            return;
          }
          // stdout is the answer of argparse; stderr only when stdout says nothing (a warning there could hold a number).
          resolve(stdout.trim() === '' ? stderr : stdout);
        },
      );
    });
}

/** Why the version could not be read, in Italian. */
export function versionFailure(error: unknown): string {
  if (error instanceof VersionError) {
    if (error.code === 'not-found') return 'Versione installata non leggibile: il comando di oMLX non si trova. oMLX è installato?';
    if (error.code === 'timeout') return 'Versione installata non leggibile: oMLX non l’ha detta in tempo.';
  }
  return 'Versione installata non leggibile: oMLX non ha risposto a --version.';
}

export const NO_OMLX_ENDPOINT = 'Nessun endpoint avvia oMLX: la versione installata non si legge.';
export const LAUNCHER_ENDPOINT = 'Il comando dell’endpoint passa da un altro programma: la versione si legge solo da omlx, omlx-cli o python -m omlx.cli.';
export const UNREADABLE_VERSION = 'Versione installata non leggibile: oMLX ha risposto senza un numero di versione.';

// ---------------------------------------------------------------------------
// Releases and state

export interface OmlxRelease extends NewsRelease {
  /** The version read from the tag, without `v`. */
  version: string;
  prerelease: boolean;
}

export interface InstalledVersion {
  version: string | null;
  endpoint: string | null;
  readAt: string | null;
  /** Why it could not be read, in Italian; null when it was. */
  error: string | null;
}

export interface OmlxReleaseState {
  version: 1;
  installed: InstalledVersion;
  /** The last check of GitHub, by the clock or by the button, done or failed. */
  checkedAt: string | null;
  /** What went wrong at the last check, in Italian; null when it went well. */
  message: string | null;
  /** The last check could not read GitHub: the automatic one tries again after RETRY_MS. */
  failed: boolean;
  /** The newest stable release. */
  latest: OmlxRelease | null;
  /** The newest pre-release after it, as information only. */
  prerelease: OmlxRelease | null;
  /** What changed in `latest` since the stable release before it (D-202 path). */
  news: ProjectNews | null;
}

export interface OmlxReleaseView extends OmlxReleaseState {
  checking: boolean;
  /** A stable release newer than the version installed. */
  update: boolean;
  /** When the automatic check runs next; null before the first one. */
  nextCheckAt: string | null;
}

export function emptyState(): OmlxReleaseState {
  return { version: 1, installed: { version: null, endpoint: null, readAt: null, error: null }, checkedAt: null, message: null, failed: false, latest: null, prerelease: null, news: null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const text = (value: unknown): value is string | null => value === null || typeof value === 'string';

function parseRelease(value: unknown): OmlxRelease | null | undefined {
  if (value === null) return null;
  const item = record(value);
  if (item === undefined || !isTag(item.tag) || typeof item.version !== 'string' || typeof item.name !== 'string' || typeof item.url !== 'string' || !item.url.startsWith(`${OMLX_PAGE}/releases`)) return undefined;
  if (!text(item.publishedAt) || typeof item.notes !== 'string' || typeof item.prerelease !== 'boolean') return undefined;
  return item as unknown as OmlxRelease;
}

/** The state file as this module wrote it; the empty state for anything else. */
export function parseReleaseState(value: unknown): OmlxReleaseState {
  const state = record(value);
  const installed = record(state?.installed);
  if (state?.version !== 1 || installed === undefined) return emptyState();
  if (!text(installed.version) || !text(installed.endpoint) || !text(installed.readAt) || !text(installed.error) || !text(state.checkedAt) || !text(state.message)) return emptyState();
  const latest = parseRelease(state.latest);
  const prerelease = parseRelease(state.prerelease);
  // The news is checked as a followed project's (its keys, tags and repository).
  const news = state.news === null ? null : parseState({ version: 1, id: OMLX_REPOSITORY, seen: null, news: state.news }, OMLX_REPOSITORY)?.news;
  if (latest === undefined || prerelease === undefined || news === undefined) return emptyState();
  return {
    version: 1,
    installed: { version: installed.version, endpoint: installed.endpoint, readAt: installed.readAt, error: installed.error },
    checkedAt: state.checkedAt,
    message: state.message,
    failed: state.failed === true,
    latest,
    prerelease,
    news,
  };
}

/**
 * Whether the automatic check is due: never done, a day gone (six hours
 * after a failed one, so a start without network does not lose the day),
 * or a clock that went back.
 */
export function isDue(checkedAt: string | null, now: Date, failed = false): boolean {
  if (checkedAt === null) return true;
  const last = Date.parse(checkedAt);
  if (Number.isNaN(last)) return true;
  const gone = now.getTime() - last;
  return gone >= (failed ? RETRY_MS : CHECK_INTERVAL_MS) || gone < -TICK_MS;
}

/** A stable release newer than the version installed; false when either is unknown. */
export function hasUpdate(installed: string | null, latest: OmlxRelease | null): boolean {
  if (installed === null || latest === null) return false;
  const have = parseVersion(installed);
  const offered = parseVersion(latest.version);
  return have !== undefined && offered !== undefined && isStable(offered) && compareVersions(offered, have) > 0;
}

/**
 * The releases of the answer of GitHub, newest version first, with their
 * version and whether they are pre-releases (marked so on GitHub, or by
 * the tag). Releases whose tag has no version, or cannot be used in a path,
 * are left out.
 */
export function readReleases(value: unknown): OmlxRelease[] {
  const flagged = new Set<string>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      const item = record(raw);
      if (item !== undefined && item.prerelease === true && typeof item.tag_name === 'string') flagged.add(cleanLine(item.tag_name, 60));
    }
  }
  const found: { release: OmlxRelease; parsed: Version }[] = [];
  for (const release of parseReleases(value, null, OMLX_PAGE)) {
    const parsed = parseVersion(release.tag);
    if (parsed === undefined || !isTag(release.tag)) continue;
    found.push({ release: { ...release, version: parsed.text, prerelease: flagged.has(release.tag) || !isStable(parsed) }, parsed });
  }
  found.sort((a, b) => compareVersions(b.parsed, a.parsed));
  return found.map(({ release }) => release);
}

export interface OmlxReleaseDeps {
  /** data/catalogs of ARIANNA_HOME. */
  dir: string;
  get: GithubGet;
  /** Asked with the whole address before each request (L0, web). */
  gateway: CatalogGateway;
  summarize?: NewsSummarizer;
  noModel?: string;
  /** The endpoints of arianna.toml, read at each use. */
  endpoints: () => readonly OmlxEndpoint[];
  run: VersionRunner;
  onEvent?: (kind: string, payload: Record<string, string | number>) => void;
  now?: () => Date;
}

/** Reads the installed version from the oMLX endpoint; never throws. */
export async function readInstalled(deps: Pick<OmlxReleaseDeps, 'endpoints' | 'run' | 'now'>): Promise<InstalledVersion> {
  const readAt = (deps.now ?? (() => new Date()))().toISOString();
  const endpoint = omlxEndpoint(deps.endpoints());
  if (endpoint === undefined) return { version: null, endpoint: null, readAt, error: NO_OMLX_ENDPOINT };
  const argv = versionCommand(endpoint.command);
  if (argv === undefined) return { version: null, endpoint: endpoint.id, readAt, error: LAUNCHER_ENDPOINT };
  try {
    const parsed = parseVersion(await deps.run(argv));
    if (parsed === undefined) return { version: null, endpoint: endpoint.id, readAt, error: UNREADABLE_VERSION };
    return { version: parsed.text, endpoint: endpoint.id, readAt, error: null };
  } catch (error) {
    return { version: null, endpoint: endpoint.id, readAt, error: versionFailure(error) };
  }
}

/**
 * The news of `latest`: the comparison with the stable release before it
 * (two public tags, nothing about the installation), grouped by the local
 * model as for a followed project, or the raw list. Never throws.
 */
export async function releaseNews(deps: Pick<OmlxReleaseDeps, 'get' | 'gateway' | 'summarize' | 'noModel'>, releases: readonly OmlxRelease[], latest: OmlxRelease, now: string): Promise<ProjectNews> {
  const at = releases.indexOf(latest);
  const previous = releases.slice(at + 1).find((release) => !release.prerelease);
  // The notes of `latest` and of its pre-releases after the stable release before it.
  const end = previous === undefined ? at + 1 : releases.indexOf(previous);
  const notes: NewsRelease[] = releases.slice(at, end).map(({ tag, name, publishedAt, url, notes: written }) => ({ tag, name, publishedAt, url, notes: written }));
  const base = { version: 1 as const, repository: OMLX_REPOSITORY, from: previous?.tag ?? null, to: latest.tag, fetchedAt: now, source: null, model: null, items: [] as NewsItem[], commits: 0, truncated: false };
  if (previous === undefined) return { ...base, releases: notes, state: 'missing', message: 'Nessuna release stabile prima di questa fra le ultime: leggi le note della release.' };
  let comparison: Comparison;
  try {
    const path = `/repos/${OMLX_REPOSITORY}/compare/${previous.tag}...${latest.tag}?per_page=${String(COMPARE_PAGE)}`;
    await deps.gateway(`https://api.github.com${path}`);
    comparison = parseCompare(await deps.get(path, MAX_COMPARE_BYTES));
  } catch (error) {
    return { ...base, releases: notes, state: 'missing', message: `Elenco delle modifiche non disponibile: ${fetchFailure(error)}. Leggi le note della release.` };
  }
  const found = { ...base, releases: notes, commits: comparison.total, truncated: comparison.truncated };
  if (comparison.commits.length === 0) return { ...found, state: 'ready', message: 'Nessun commit fra le due release.' };
  const prefix = keyPrefix(OMLX_REPOSITORY);
  const raw = (why: string): ProjectNews => ({ ...found, state: 'ready', source: 'raw', message: `Elenco dei commit per tipo: ${why}.`, items: rawItems(comparison.commits, prefix) });
  if (deps.summarize === undefined) return raw(deps.noModel ?? 'il modello locale non è configurato');
  const data = modelData(comparison.commits, notes);
  let result;
  try {
    result = await deps.summarize(data.text);
  } catch (error) {
    return raw(modelFailure(error));
  }
  const checked = checkModelItems(result, data.given, prefix);
  if ('reason' in checked) return raw(`la risposta del modello locale non ha passato i controlli (${checked.reason})`);
  return { ...found, state: 'ready', source: 'model', model: cleanLine(result.model, 80) || NEWS_MODEL, message: null, items: checked.items };
}

/**
 * One check of GitHub: the releases, the newest stable and pre-release, and
 * the news of the newest stable one when it changed. Never throws: a failure
 * keeps what was found before and says why.
 */
export async function checkReleases(deps: Pick<OmlxReleaseDeps, 'get' | 'gateway' | 'summarize' | 'noModel' | 'now'>, previous: OmlxReleaseState): Promise<OmlxReleaseState> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let releases: OmlxRelease[];
  try {
    await deps.gateway(`https://api.github.com${RELEASES_PATH}`);
    releases = readReleases(await deps.get(RELEASES_PATH, MAX_RELEASES_BYTES));
  } catch (error) {
    return { ...previous, checkedAt: now, failed: true, message: `Controllo non riuscito: ${fetchFailure(error)}.` };
  }
  const latest = releases.find((release) => !release.prerelease) ?? null;
  const newestPre = releases.find((release) => release.prerelease) ?? null;
  const prerelease = newestPre !== null && (latest === null || releases.indexOf(newestPre) < releases.indexOf(latest)) ? newestPre : null;
  if (latest === null) return { ...previous, checkedAt: now, failed: false, message: releases.length === 0 ? 'oMLX non ha release su GitHub con un numero di versione.' : null, latest: null, prerelease, news: null };
  // The news of a release is read once: the next checks keep it. A raw list waits for the local model, if there is one.
  const known = previous.news !== null && previous.news.to === latest.tag && previous.news.state === 'ready' && (previous.news.source !== 'raw' || deps.summarize === undefined);
  const news = known ? previous.news : await releaseNews(deps, releases, latest, now);
  return { ...previous, checkedAt: now, failed: false, message: null, latest, prerelease, news };
}

export interface OmlxReleases {
  view(): OmlxReleaseView;
  /** «Controlla ora»: the version, then GitHub, in the background; refused while a check runs. */
  checkNow(): void;
  /** Reads the version installed again. */
  refreshVersion(): Promise<OmlxReleaseView>;
  /** The automatic step: a check of GitHub when the last one is a day old; nothing otherwise. */
  tick(): void;
  /** The automatic check: once at start (version), then once a day (GitHub). */
  start(): void;
  stop(): void;
  /** The check started by this process, if any. */
  idle(): Promise<void>;
}

export class OmlxBusyError extends Error {
  override name = 'OmlxBusyError';
}

export function createOmlxReleases(deps: OmlxReleaseDeps): OmlxReleases {
  const base = join(deps.dir, FOLLOWED_FOLDER);
  const file = join(base, STATE_FILE);
  const now = (): Date => deps.now?.() ?? new Date();
  let running: Promise<void> | undefined;
  let first: NodeJS.Timeout | undefined;
  let ticker: NodeJS.Timeout | undefined;

  function read(): OmlxReleaseState {
    const found = readRegular(file, 4 * 1024 * 1024);
    if (found === undefined || 'refused' in found) return emptyState();
    try {
      return parseReleaseState(JSON.parse(found.buffer.toString('utf8')) as unknown);
    } catch {
      return emptyState();
    }
  }

  function write(state: OmlxReleaseState): void {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    writeAtomic(file, state);
  }

  function view(): OmlxReleaseView {
    const state = read();
    const next = state.checkedAt === null ? null : new Date(Date.parse(state.checkedAt) + (state.failed ? RETRY_MS : CHECK_INTERVAL_MS)).toISOString();
    return { ...state, checking: running !== undefined, update: hasUpdate(state.installed.version, state.latest), nextCheckAt: next };
  }

  async function refreshVersion(): Promise<OmlxReleaseView> {
    const installed = await readInstalled(deps);
    write({ ...read(), installed });
    return view();
  }

  function run(): void {
    if (running !== undefined) throw new OmlxBusyError('a check of oMLX is already running');
    running = (async () => {
      try {
        const installed = await readInstalled(deps);
        const next = await checkReleases(deps, { ...read(), installed });
        write(next);
        const update = hasUpdate(next.installed.version, next.latest);
        deps.onEvent?.('omlx.release_checked', { result: next.failed ? 'failed' : next.latest === null ? 'none' : 'ok', update: update ? 1 : 0 });
      } catch {
        // A check never fails the core: a file that cannot be written leaves the old one.
        deps.onEvent?.('omlx.release_check_failed', {});
      } finally {
        running = undefined;
      }
    })();
  }

  function tick(): void {
    const state = read();
    if (running !== undefined || !isDue(state.checkedAt, now(), state.failed)) return;
    run();
  }

  return {
    view,
    checkNow: run,
    tick,
    refreshVersion,
    start() {
      // The version is local: read at once. GitHub only when the day has gone.
      refreshVersion().catch(() => undefined);
      first = setTimeout(tick, FIRST_TICK_MS);
      first.unref();
      ticker = setInterval(tick, TICK_MS);
      ticker.unref();
    },
    stop() {
      clearTimeout(first);
      clearInterval(ticker);
    },
    idle: async () => {
      await running;
    },
  };
}
