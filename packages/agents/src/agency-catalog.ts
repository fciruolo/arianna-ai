import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  AgencyError,
  buildIndex,
  indexRecord,
  MAX_AGENCY_FILE_BYTES,
  parseAgencyFile,
  parseAgencyLock,
  parseDivisions,
  proposeCard,
  type AgencyEntry,
  type AgencyIndexRecord,
  type AgencyOrigin,
  type AgencyRejection,
} from './agency.ts';
import { templateFor } from './templates.ts';

/**
 * The file-system side of the agency-agents importer (D-079, first part): it
 * reads a clone, never runs anything from it (not even git), and writes only
 * the index and the proposals it is given paths for.
 */

export const AGENCY_CLONE_DIR = join('data', 'catalogs', 'agency-agents');
export const AGENCY_INDEX_FILE = join('data', 'catalogs', 'agency-agents.index.json');
export const AGENCY_PROPOSED_DIR = join('data', 'agency', 'proposed');
export const AGENCY_LOCK_FILE = join('config', 'agency.lock');
const MAX_DEPTH = 6;
const MAX_FILES = 5000;

export interface AgencyScan {
  divisions: string[];
  entries: AgencyEntry[];
  rejected: AgencyRejection[];
  /** Symbolic links and other non-regular entries left out, relative to the clone. */
  skipped: string[];
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readRegular(path: string, shown: string): string {
  if (!isRegularFile(path)) throw new AgencyError(`${shown} is missing or not a regular file`);
  return readFileSync(path, 'utf8');
}

export function readAgencyLock(home: string): AgencyOrigin {
  return parseAgencyLock(readRegular(join(home, AGENCY_LOCK_FILE), AGENCY_LOCK_FILE));
}

/**
 * The commit checked out in the clone, read from `.git` as files: running git
 * in a third-party clone could run its configured hooks or fsmonitor. `.git`
 * must be a real folder (not a `gitdir:` file nor a link), HEAD a regular
 * file, a symbolic ref must stay under `refs/heads/` without dot segments,
 * and every folder on the way to a loose ref must be real, not a link.
 */
export function readCloneHead(clone: string): string {
  const git = join(clone, '.git');
  if (!isRealDirectory(git)) throw new AgencyError('the clone has no .git folder (or it is a file or a symbolic link)');
  const head = readRegular(join(git, 'HEAD'), '.git/HEAD').trim();
  if (!head.startsWith('ref:')) return checkedSha(head, 'HEAD');
  const ref = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (ref === undefined) throw new AgencyError('.git/HEAD points outside refs/heads/');
  const segments = ref.split('/');
  if (segments.some((segment) => segment === '' || /^\.+$/.test(segment))) throw new AgencyError('.git/HEAD names an invalid ref');

  let folder = git;
  let foldersExist = true;
  for (const segment of segments.slice(0, -1)) {
    folder = join(folder, segment);
    let stat;
    try {
      stat = lstatSync(folder);
    } catch {
      foldersExist = false;
      break;
    }
    if (!stat.isDirectory()) throw new AgencyError(`.git/${relative(git, folder)} is not a real folder`);
  }
  if (foldersExist) {
    const loose = join(git, ...segments);
    let stat;
    try {
      stat = lstatSync(loose);
    } catch {
      stat = undefined;
    }
    if (stat !== undefined) {
      if (!stat.isFile()) throw new AgencyError(`.git/${ref} is not a regular file`);
      return checkedSha(readFileSync(loose, 'utf8').trim(), ref);
    }
  }
  const packed = join(git, 'packed-refs');
  if (isRegularFile(packed)) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && sha !== undefined) return checkedSha(sha, ref);
    }
  }
  throw new AgencyError(`ref ${ref} not found in the clone`);
}

function checkedSha(sha: string, ref: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new AgencyError(`${ref} does not hold a commit sha`);
  return sha;
}

/**
 * Every agent file of the divisions in `divisions.json`, recursively. Other
 * folders (`strategy/`, `scripts/`, `examples/`...) are never opened;
 * symbolic links are skipped; dot folders are ignored; an invalid file is
 * rejected with its reason and does not stop the scan.
 */
export function scanCatalog(clone: string): AgencyScan {
  const divisions = parseDivisions(readRegular(join(clone, 'divisions.json'), 'divisions.json'));
  const parsed: AgencyEntry[] = [];
  const rejected: AgencyRejection[] = [];
  const skipped: string[] = [];
  let files = 0;

  const walk = (relativeDir: string, depth: number): void => {
    for (const name of readdirSync(join(clone, relativeDir)).sort()) {
      if (name.startsWith('.')) continue;
      const shown = `${relativeDir}/${name}`;
      const absolute = join(clone, relativeDir, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        skipped.push(shown);
      } else if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) rejected.push({ path: shown, reason: `deeper than ${String(MAX_DEPTH)} folders` });
        else walk(shown, depth + 1);
      } else if (name.endsWith('.md')) {
        files += 1;
        if (files > MAX_FILES) throw new AgencyError(`more than ${String(MAX_FILES)} files in the catalog`);
        if (stat.size > MAX_AGENCY_FILE_BYTES) {
          rejected.push({ path: shown, reason: `larger than ${String(MAX_AGENCY_FILE_BYTES / 1024)} KiB` });
          continue;
        }
        try {
          parsed.push(parseAgencyFile(readFileSync(absolute, 'utf8'), shown));
        } catch (error) {
          if (!(error instanceof AgencyError)) throw error;
          rejected.push({ path: shown, reason: error.message });
        }
      }
    }
  };

  for (const division of divisions) {
    const dir = join(clone, division);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) skipped.push(division);
    else walk(division, 1);
  }
  const index = buildIndex(parsed);
  return { divisions, entries: index.entries, rejected: [...rejected, ...index.rejected].sort((a, b) => (a.path < b.path ? -1 : 1)), skipped };
}

export interface AgencyIndexFile {
  repository: string;
  commit: string;
  agents: AgencyIndexRecord[];
  rejected: AgencyRejection[];
}

/** The index of the catalog: names and descriptions, never the bodies. */
export function writeAgencyIndex(path: string, scan: AgencyScan, origin: AgencyOrigin): AgencyIndexFile {
  const index: AgencyIndexFile = {
    repository: origin.repository,
    commit: origin.commit,
    agents: scan.entries.map(indexRecord),
    rejected: scan.rejected,
  };
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  return index;
}

function inside(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}

export interface ProposalResult {
  written: string[];
  skipped: { slug: string; reason: string }[];
}

/** Names of the active cards in `<home>/agents`, which a proposal must not take. */
function activeCardNames(home: string): Set<string> {
  const dir = join(home, 'agents');
  if (!isRealDirectory(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((entry) => entry.endsWith('.yaml'))
      .map((entry) => entry.slice(0, -'.yaml'.length)),
  );
}

/**
 * Writes `<slug>.yaml` and `<slug>.md` for each entry into `dir`. Refuses a
 * folder inside the active cards (`<home>/agents`): a proposal never becomes
 * active without the user. Skips a slug that is already an active card, and
 * an existing proposal unless `force` (the user may have edited it).
 */
export function writeProposals(
  home: string,
  dir: string,
  entries: readonly AgencyEntry[],
  origin: AgencyOrigin,
  options: { force?: boolean } = {},
): ProposalResult {
  if (inside(join(home, 'agents'), dir)) throw new AgencyError('proposals are never written into agents/');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const active = activeCardNames(home);
  const force = options.force === true;
  const result: ProposalResult = { written: [], skipped: [] };
  for (const entry of entries) {
    if (active.has(entry.slug)) {
      result.skipped.push({ slug: entry.slug, reason: 'an active card in agents/ has this name' });
      continue;
    }
    const proposal = proposeCard(entry, templateFor(entry.division), origin);
    const yamlPath = join(dir, `${proposal.name}.yaml`);
    const mdPath = join(dir, `${proposal.name}.md`);
    if (!force && (existsSync(yamlPath) || existsSync(mdPath))) {
      result.skipped.push({ slug: entry.slug, reason: 'a proposal already exists (--force regenerates it)' });
      continue;
    }
    // `wx` also closes the race between the check and the write.
    const flag = force ? 'w' : 'wx';
    writeFileSync(yamlPath, proposal.yaml, { mode: 0o600, flag });
    writeFileSync(mdPath, proposal.md, { mode: 0o600, flag });
    result.written.push(proposal.name);
  }
  return result;
}
