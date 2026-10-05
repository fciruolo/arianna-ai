import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Novità": the register of the versions, read from CHANGELOG.md at the root
 * of ARIANNA_HOME (never a register of its own). The parser is pure and
 * tolerant like the ones of dev-progress.ts: a line it does not understand is
 * skipped and counted, code blocks are skipped, never an error that breaks the
 * page. The file is documentation of the repository, L2 by default
 * (default-deny, as the documents of D-102): the core reads it from a fixed
 * path and serves it only to the local web chat.
 */

export const CHANGELOG_FILE = 'CHANGELOG.md';
/** A file larger than this is not read. */
const MAX_CHANGELOG_BYTES = 2 * 1024 * 1024;

export interface ChangelogSection {
  /** Aggiunto, Cambiato, Corretto, Sicurezza, Rimosso, or any other title as written. */
  title: string;
  items: string[];
}

export interface ChangelogVersion {
  /** X.Y.Z; null for the section "Non rilasciato". */
  version: string | null;
  /** AAAA-MM-GG; null when not released or not written. */
  date: string | null;
  unreleased: boolean;
  /** Free text between the title of the version and its first section (Markdown, paragraphs split by a blank line), or null. */
  summary: string | null;
  sections: ChangelogSection[];
}

export interface Changelog {
  /** The highest released version, or null when there is none. */
  current: string | null;
  /** In the order of the file. */
  versions: ChangelogVersion[];
  /** Lines the parser did not understand. */
  skipped: number;
}

const UNRELEASED = /^##\s+\[?\s*(?:non rilasciat[oa]|unreleased)\s*\]?\s*$/i;
const RELEASE = /^##\s+\[?v?(\d+)\.(\d+)\.(\d+)\]?(?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

function validDate(text: string): boolean {
  const [year, month, day] = text.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Negative when `a` comes before `b` (SemVer X.Y.Z only). */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function parseChangelog(text: string): Changelog {
  const versions: ChangelogVersion[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let version: ChangelogVersion | undefined;
  let section: ChangelogSection | undefined;
  /** The item that a line indented by two spaces continues; a blank line ends it. */
  let open = false;
  /** Lines under a heading that was skipped are skipped with it. */
  let ignoring = false;
  let fence: string | undefined;
  let started = false;
  /** A blank line came before: the next line of a summary starts a paragraph. */
  let paragraph = false;

  const close = (): void => {
    open = false;
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (fenceMark !== undefined && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMark !== undefined) {
      fence = fenceMark;
      close();
      continue;
    }
    if (line.trim() === '') {
      close();
      paragraph = true;
      continue;
    }

    if (/^#\s/.test(line)) {
      close();
      if (started) skipped += 1;
      continue;
    }

    if (/^##\s/.test(line)) {
      close();
      started = true;
      section = undefined;
      version = undefined;
      ignoring = false;
      if (UNRELEASED.test(line)) {
        if (seen.has('unreleased')) {
          skipped += 1;
          ignoring = true;
          continue;
        }
        seen.add('unreleased');
        version = { version: null, date: null, unreleased: true, summary: null, sections: [] };
        versions.push(version);
        continue;
      }
      const match = RELEASE.exec(line);
      const number = match === null ? undefined : [match[1], match[2], match[3]].map((part) => String(Number(part))).join('.');
      const date = match?.[4];
      if (number === undefined || seen.has(number) || (date !== undefined && !validDate(date))) {
        skipped += 1;
        ignoring = true;
        continue;
      }
      seen.add(number);
      version = { version: number, date: date ?? null, unreleased: false, summary: null, sections: [] };
      versions.push(version);
      continue;
    }

    // The text before the first version is the introduction: free.
    if (!started) continue;
    if (ignoring) {
      skipped += 1;
      continue;
    }

    const heading = /^###\s+(.+)$/.exec(line);
    if (heading !== null) {
      close();
      const title = heading[1]?.trim() ?? '';
      if (version === undefined || title === '') {
        skipped += 1;
        section = undefined;
        continue;
      }
      section = version.sections.find((existing) => existing.title.toLowerCase() === title.toLowerCase());
      if (section === undefined) {
        section = { title, items: [] };
        version.sections.push(section);
      }
      continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item !== null) {
      const body = item[1]?.trim() ?? '';
      if (section === undefined || body === '') {
        skipped += 1;
        close();
        continue;
      }
      section.items.push(body);
      open = true;
      continue;
    }

    if (open && section !== undefined && /^ {2,}\S/.test(line)) {
      const last = section.items.length - 1;
      section.items[last] = `${section.items[last] ?? ''} ${line.trim()}`;
      continue;
    }

    // Free text under a version, before its first section: its summary, in paragraphs.
    if (version !== undefined && version.sections.length === 0 && !/^\s*[#>|]/.test(line)) {
      const text = line.trim();
      version.summary = version.summary === null ? text : `${version.summary}${paragraph ? '\n\n' : ' '}${text}`;
      paragraph = false;
      continue;
    }

    skipped += 1;
    close();
  }

  for (const entry of versions) entry.sections = entry.sections.filter((part) => part.items.length > 0);
  const released = versions.flatMap((entry) => (entry.version === null ? [] : [entry.version]));
  const current = released.reduce<string | null>((best, next) => (best === null || compareVersions(next, best) > 0 ? next : best), null);
  return { current, versions, skipped };
}

/** The file as text: a regular file (no link), at most 2 MB; undefined otherwise. */
function readChangelogFile(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_CHANGELOG_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Reads `<home>/CHANGELOG.md`, read only. A missing or refused file is an empty register. Never throws. */
export function loadChangelog(home: string): Changelog {
  const text = readChangelogFile(join(home, CHANGELOG_FILE));
  return text === undefined ? { current: null, versions: [], skipped: 0 } : parseChangelog(text);
}
