import { CHANGELOG_FILE, parseChangelog, type Changelog } from '../changelog.ts';
import { ChatError } from '../conversations.ts';
import { CARRY_MAX_CHARS } from './carry.ts';
import { GOD_MAIN, type GitRunner } from './clone.ts';
import { cut } from './dossier.ts';

/**
 * "Parlane con GOD" (I-6, D-178): a new conversation with GOD about an entry
 * of the register of the versions. Its context is written by the code, never
 * by the page: the entry is looked up in CHANGELOG.md as the installation's
 * main holds it in git (the page only says which one), with the decisions
 * and tasks it cites and, for a released version, what git records of it
 * (the tag vX.Y.Z, the commits since the tag before and the files they
 * touched, names and line counts only, never contents). Everything here is
 * in the main the clones of GOD hold: Arianna's own code, L1 (D-127).
 */

/** Which entry: the page sends what it shows, the core finds it again in git. */
export interface ChangelogRef {
  /** X.Y.Z, or null for "Non rilasciato". */
  version: string | null;
  section: string;
  text: string;
}

export interface ChangelogEntry {
  version: string | null;
  date: string | null;
  section: string;
  text: string;
}

export interface VersionFile {
  path: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

export interface VersionGit {
  tag: string;
  commit: string;
  /** The tag before, or null when this is the first. */
  previous: string | null;
  commits: { sha: string; subject: string }[];
  moreCommits: number;
  files: VersionFile[];
  moreFiles: number;
}

export interface ChangelogCarry {
  body: string;
  label: 'L1';
  /** X.Y.Z, or `unreleased`. */
  source: string;
  title: string;
}

const MAX_CHANGELOG_BYTES = 2 * 1024 * 1024;
const ENTRY_CHARS = 3000;
const MAX_IDS = 20;
const MAX_COMMITS = 25;
const MAX_FILES = 60;
const TITLE_CHARS = 80;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const ID = /\b(D-\d{3}[a-z]?|I-\d{1,3})\b/g;

/** Checks the body of `POST /api/god/changelog` as it came over the wire. */
export function changelogRefOf(body: Record<string, unknown>): ChangelogRef {
  const { version, section, text } = body;
  if (version !== null && (typeof version !== 'string' || !VERSION.test(version))) throw new ChatError('invalid', 'version must be X.Y.Z or null');
  if (typeof section !== 'string' || section.trim() === '' || section.length > 80) throw new ChatError('invalid', 'section must be a short text');
  if (typeof text !== 'string' || text.trim() === '' || text.length > 20_000) throw new ChatError('invalid', 'text must be the text of an entry');
  return { version, section: section.trim(), text: text.trim() };
}

/** The entry of `changelog` the reference names, or undefined. */
export function findChangelogEntry(changelog: Changelog, ref: ChangelogRef): ChangelogEntry | undefined {
  const version = changelog.versions.find((entry) => (ref.version === null ? entry.unreleased : entry.version === ref.version));
  const section = version?.sections.find((part) => part.title.toLowerCase() === ref.section.toLowerCase());
  const text = section?.items.find((item) => item === ref.text);
  if (version === undefined || section === undefined || text === undefined) return undefined;
  return { version: version.version, date: version.date, section: section.title, text };
}

/** The decisions (D-NNN) and proposals (I-N) an entry cites, once each, in order. */
export function citedIds(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(ID), (match) => match[1] ?? ''))].filter((id) => id !== '').slice(0, MAX_IDS);
}

/** Text from git, on one line and without control characters. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** CHANGELOG.md as the installation's main holds it in git (never the working tree). */
export async function mainChangelog(git: GitRunner, home: string): Promise<Changelog> {
  let text: string;
  try {
    text = await git(['show', `refs/heads/${GOD_MAIN}:${CHANGELOG_FILE}`], home);
  } catch {
    throw new ChatError('not-found', `${CHANGELOG_FILE} non è nel main dell'installazione`);
  }
  if (Buffer.byteLength(text) > MAX_CHANGELOG_BYTES) throw new ChatError('invalid', `${CHANGELOG_FILE} è troppo grande`);
  return parseChangelog(text);
}

/** Parses `git diff --numstat -z --no-renames`: `added\tremoved\tpath\0`. */
export function parseNumstat(output: string): VersionFile[] {
  const files: VersionFile[] = [];
  for (const record of output.split('\0')) {
    const match = /^\s*(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record);
    if (match === null) continue;
    const [, added = '-', removed = '-', path = ''] = match;
    files.push({ path: clean(path), added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) });
  }
  return files;
}

/**
 * What the installation's git records of a released version: its tag, if it
 * is on main, the commits since the tag before and the files they touched.
 * A reason, in English for GOD, when there is nothing to say.
 */
export async function versionGit(git: GitRunner, home: string, version: string): Promise<VersionGit | string> {
  const tag = `v${version}`;
  const commit = (await git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], home, { okCodes: [1] }).catch(() => '')).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return `the installation's git has no tag ${tag}`;
  // Only what main reaches, as the clones of GOD: a tag elsewhere says nothing.
  const base = (await git(['merge-base', commit, `refs/heads/${GOD_MAIN}`], home, { okCodes: [1] }).catch(() => '')).trim();
  if (base !== commit) return `the tag ${tag} is not on main`;
  // The tag before along the first parent: the tags are put on the commits of main.
  const previous = (await git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${commit}^`], home, { okCodes: [128] }).catch(() => '')).trim();
  const before = previous === '' ? '' : (await git(['rev-parse', '--verify', '--quiet', `refs/tags/${previous}^{commit}`], home, { okCodes: [1] }).catch(() => '')).trim();
  const since = /^[0-9a-f]{40,64}$/.test(before) ? before : undefined;
  const log = await git(['log', '--format=%h%x09%s', '-n', String(since === undefined ? 1 : MAX_COMMITS + 1), since === undefined ? commit : `${since}..${commit}`, '--'], home);
  const commits = log
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [sha = '', ...subject] = line.split('\t');
      return { sha: clean(sha), subject: clean(subject.join(' ')) };
    });
  const count = since === undefined ? commits.length : Number((await git(['rev-list', '--count', `${since}..${commit}`], home)).trim()) || commits.length;
  const numstat =
    since === undefined
      ? await git(['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', '-z', '--no-renames', commit], home)
      : await git(['diff', '--numstat', '-z', '--no-renames', since, commit], home);
  const files = parseNumstat(numstat).sort((a, b) => (b.added ?? 0) + (b.removed ?? 0) - ((a.added ?? 0) + (a.removed ?? 0)) || a.path.localeCompare(b.path));
  return {
    tag,
    commit,
    previous: since === undefined ? null : previous,
    commits: commits.slice(0, MAX_COMMITS),
    moreCommits: Math.max(0, count - Math.min(commits.length, MAX_COMMITS)),
    files: files.slice(0, MAX_FILES),
    moreFiles: Math.max(0, files.length - MAX_FILES),
  };
}

/** The summary GOD reads: the entry, the ids it cites, what git says of its version. At most CARRY_MAX_CHARS. */
export function changelogCarryBody(entry: ChangelogEntry, git: VersionGit | string | undefined): string {
  const where = entry.version === null ? 'not released yet ("Non rilasciato")' : `version ${entry.version}${entry.date === null ? '' : ` of ${entry.date}`}`;
  const lines = [`Entry of the register of the versions (CHANGELOG.md on main), ${where}, section «${entry.section}»:`, cut(entry.text, ENTRY_CHARS)];
  const ids = citedIds(entry.text);
  if (ids.length > 0) lines.push('', `It cites: ${ids.join(', ')}. Decisions are in docs/DECISIONS.md, proposals (I-N) in docs/PROPOSTE.md of the clone.`);
  lines.push('');
  if (git === undefined) lines.push('Git: a version not released has no tag yet; its work is on main or on a branch still to merge.');
  else if (typeof git === 'string') lines.push(`Git: ${git}.`);
  else {
    lines.push(`Git of the installation's main: tag ${git.tag} on commit ${git.commit.slice(0, 12)}${git.previous === null ? ' (the first tag: only its own commit)' : `, since ${git.previous}`}.`);
    lines.push(`Commits${git.moreCommits > 0 ? ` (the latest ${String(git.commits.length)})` : ''}:`, ...git.commits.map((item) => `- ${item.sha} ${cut(item.subject, 160)}`));
    if (git.moreCommits > 0) lines.push(`- … and ${String(git.moreCommits)} more`);
    lines.push(`Files changed, lines added and removed (names and counts only):`, ...git.files.map((file) => `- ${file.path} ${file.added === null ? '(binary)' : `+${String(file.added)} -${String(file.removed ?? 0)}`}`));
    if (git.moreFiles > 0) lines.push(`- … and ${String(git.moreFiles)} more files`);
  }
  let body = '';
  for (const line of lines) {
    const next = body === '' ? line : `${body}\n${line}`;
    if (next.length > CARRY_MAX_CHARS) break;
    body = next;
  }
  return body;
}

/** «Su 0.65.0: …», the title of the new conversation. */
export function changelogTitle(entry: ChangelogEntry): string {
  const plain = entry.text.replace(/[*_`]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return cut(`Su ${entry.version ?? 'non rilasciato'}: ${plain}`, TITLE_CHARS);
}

/** The context of "Parlane con GOD" for `ref`, from the installation's git. */
export async function changelogCarry(git: GitRunner, home: string, ref: ChangelogRef): Promise<ChangelogCarry> {
  const entry = findChangelogEntry(await mainChangelog(git, home), ref);
  if (entry === undefined) throw new ChatError('not-found', 'la voce non è nel CHANGELOG.md del main: se è nuova, va prima unita in main');
  const facts = entry.version === null ? undefined : await versionGit(git, home, entry.version).catch(() => 'git could not read this version');
  return { body: changelogCarryBody(entry, facts), label: 'L1', source: entry.version ?? 'unreleased', title: changelogTitle(entry) };
}
