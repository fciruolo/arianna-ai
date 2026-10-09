import { ApiError } from './api.ts';
import { errorText } from './italian.ts';
import type { DiffHunk, FileChangeKind, Label } from './types.ts';

/**
 * The page "Progetti" (D-134): an approved project read on this computer.
 * Pure helpers: the types of the API, the file kinds, a small highlighter
 * for the code (no library, text spans only, never HTML), the Italian words.
 */

export const PROJECTS_PATH = '/progetti';

export function isProjectsPath(pathname: string): boolean {
  return pathname === PROJECTS_PATH || pathname === `${PROJECTS_PATH}/`;
}

/** A part of a project (D-145): `name` is `<project>` or `<project>:<part>`; File, Git and Servizi read it. */
export interface BrowsableProject {
  name: string;
  absolute: string;
  /** "Mostra nascosti" is on for this part (D-135). */
  hidden: boolean;
  /** The container. */
  project: string;
  /** The folder of the part in the container; null when the container is itself the part. */
  part: string | null;
}

/** A project as a container (D-145): its parts by name; `single` when it is itself its only part. */
export interface BrowsableContainer {
  name: string;
  absolute: string;
  label: 'L0' | 'L1';
  single: boolean;
  parts: string[];
}

/** A management folder of a container (D-145) and its label; `defaultLabel` the one it has by its name. */
export interface KnowledgeFolder {
  path: string;
  label: Label;
  defaultLabel: Label;
  chosen: boolean;
}

export interface KnowledgeNote {
  folder: string;
  path: string;
  title: string;
  label: Label;
}

/** The tab "Conoscenza" (D-145). */
export interface ProjectKnowledge {
  single: boolean;
  folders: KnowledgeFolder[];
  notes: KnowledgeNote[];
  more: number;
}

const LABEL_RANK: Readonly<Record<Label, number>> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** True when `to` is below `from`: lowering a folder asks an explicit confirmation (D-145). */
export function lowers(from: Label, to: Label): boolean {
  return LABEL_RANK[to] < LABEL_RANK[from];
}

/** The labels a note in a folder may have: the folder's or higher (a note is never below its folder). */
export function noteLabels(folder: Label): Label[] {
  return (['L0', 'L1', 'L2', 'L3'] as const).filter((label) => LABEL_RANK[label] >= LABEL_RANK[folder]);
}

/**
 * The projects of the settings with one management folder relabeled (D-145):
 * what "Conoscenza" sends to the two steps of the Settings. The folder goes
 * in `folders` with its label, also when it equals the one by name: the
 * user chose it. Every other project and field as it is.
 */
export function withFolderLabel<T extends { name: string; folders?: { path: string; label: Label }[] }>(projects: readonly T[], project: string, folder: string, label: Label): T[] {
  return projects.map((item) => {
    if (item.name !== project) return { ...item };
    const others = (item.folders ?? []).filter((entry) => entry.path.toLowerCase() !== folder.toLowerCase());
    return { ...item, folders: [...others, { path: folder, label }].sort((a, b) => a.path.localeCompare(b.path, 'it')) };
  });
}

/** The name of a part as the page shows it: the folder, or the project when the container is the part. */
export function partTitle(part: Pick<BrowsableProject, 'project' | 'part'>): string {
  return part.part ?? part.project;
}

export interface TreeEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number | null;
  shut?: 'hidden' | 'excluded' | 'outside';
  /** A file that may hold a secret: its text comes covered (D-135). */
  secret?: true;
}

export interface ProjectFile {
  path: string;
  size: number;
  text: string;
  openable: boolean;
  /** A secret (D-135); `covered` until "Mostra", with an empty text. */
  secret?: true;
  covered?: true;
}

export interface RepositoryBranch {
  name: string;
  current: boolean;
  at: number;
}

export interface RepositoryCommit {
  id: string;
  parents: string[];
  author: string;
  at: number;
  subject: string;
}

export interface FileChange {
  path: string;
  change: FileChangeKind;
  from?: string;
}

export interface ProjectGit {
  repository: boolean;
  branches: RepositoryBranch[];
  changes: FileChange[];
  log: RepositoryCommit[];
}

export type CommitFileDiff = FileChange & ({ added: number; removed: number; hunks: DiffHunk[] } | { error: string });

export interface CommitDiff {
  commit: string;
  parent: string | null;
  files: CommitFileDiff[];
}

/** Why an entry is shown with a lock. */
export const SHUT_TEXT: Readonly<Record<NonNullable<TreeEntry['shut']>, string>> = {
  hidden: 'nascosto: accendi "Mostra nascosti" per vederlo',
  excluded: 'escluso: dipendenze, non codice del progetto; accendi "Mostra nascosti" per vederlo',
  outside: 'un collegamento che porta fuori dal progetto',
};

/** Why a file or a diff is not shown, from the codes of the core. */
export const FILE_ERROR_TEXT: Readonly<Record<string, string>> = {
  refused: 'Questo file resta chiuso: i file nascosti si vedono con "Mostra nascosti", quelli con valori del vault mai.',
  covered: 'Può contenere un segreto: il testo non si mostra nel diff. Aprilo dalla scheda File (con "Mostra nascosti" acceso, se è nascosto) e premi "Mostra".',
  'too-large': 'File troppo grande da mostrare (oltre 256 KiB).',
  binary: 'Non è un file di testo.',
  deleted: 'Il file non c’è più.',
  'not-found': 'Non trovato.',
  'not-approved': 'Il progetto non è più fra quelli approvati.',
  busy: 'Il Coder sta lavorando su questo progetto: git si mostra quando finisce.',
  'too-many': 'Troppi file in questo commit: non mostrato.',
};

/** The short badge of a file by extension (VUE, TS, MD…); IMG for images, empty for others. */
export function fileBadge(name: string): { text: string; tone: string } {
  const extension = extensionOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico'].includes(extension)) return { text: 'IMG', tone: 'img' };
  const known: Record<string, string> = {
    vue: 'VUE',
    ts: 'TS',
    tsx: 'TSX',
    js: 'JS',
    mjs: 'JS',
    json: '{ }',
    md: 'MD',
    yml: 'YML',
    yaml: 'YML',
    toml: 'TOML',
    html: '</>',
    css: 'CSS',
    py: 'PY',
    sql: 'SQL',
    sh: 'SH',
    swift: 'SW',
  };
  return { text: known[extension] ?? '', tone: extension === 'mjs' ? 'js' : extension === 'yaml' ? 'yml' : extension };
}

/** "Apri in VS Code" (D-134): a link the browser hands to Visual Studio Code; the core runs nothing. */
export function vscodeUrl(absolute: string, path = '', line?: number): string {
  const full = path === '' ? absolute : `${absolute.replace(/\/+$/, '')}/${path}`;
  const encoded = full.split('/').map(encodeURIComponent).join('/');
  return `vscode://file${encoded.startsWith('/') ? '' : '/'}${encoded}${line === undefined ? '' : `:${String(line)}`}`;
}

/** The path of a child of a folder of the tree ('' is the top). */
export function childPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** The git mark of a path in the tree: M modified (or renamed), A added, nothing otherwise; a folder carries the mark of what it holds. */
export function changeMark(changes: readonly FileChange[], path: string, kind: 'dir' | 'file'): 'M' | 'A' | undefined {
  let mark: 'M' | 'A' | undefined;
  for (const change of changes) {
    const hit = kind === 'file' ? change.path === path : change.path.startsWith(`${path}/`);
    if (!hit || change.change === 'deleted') continue;
    if (change.change === 'added') mark ??= 'A';
    else return 'M';
  }
  return mark;
}

/** Bytes as the page says them: "840 B", "2,1 kB", "1,4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace('.', ',')} kB`;
  return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

/** How long ago, in Italian: "ora", "5 min fa", "2 ore fa", "ieri", "3 giorni fa", then the date. */
export function agoText(seconds: number, now: number = Date.now()): string {
  const minutes = Math.floor((now / 1000 - seconds) / 60);
  if (minutes < 1) return 'ora';
  if (minutes < 60) return `${String(minutes)} min fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 ora fa' : `${String(hours)} ore fa`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ieri';
  if (days < 30) return `${String(days)} giorni fa`;
  return new Date(seconds * 1000).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A token of a highlighted line: plain text with a kind, rendered as a span (never HTML). */
export interface CodeToken {
  kind: 'plain' | 'keyword' | 'string' | 'number' | 'comment';
  text: string;
}

const KEYWORDS = new Set(
  [
    'import export from as default const let var function return if else for while do switch case break continue new class extends implements',
    'interface type enum await async try catch finally throw typeof instanceof in of void null undefined true false this super static public',
    'private protected readonly def lambda pass None True False elif with yield struct func guard self fn pub use mod impl match',
    'SELECT FROM WHERE INSERT UPDATE DELETE INTO VALUES',
  ]
    .join(' ')
    .split(' '),
);

/** Line comments by file kind: `//` for the C family, `#` for shell, Python, YAML and TOML. */
function commentStart(extension: string): string[] {
  if (['py', 'sh', 'yml', 'yaml', 'toml', 'rb'].includes(extension)) return ['#'];
  if (extension === 'sql') return ['--'];
  if (['md', 'txt', 'json', ''].includes(extension)) return [];
  return ['//'];
}

/**
 * One line split into tokens: strings, numbers, keywords and a line comment.
 * Good enough to read code, not a parser: a string or comment spanning lines
 * is not followed.
 */
export function highlightLine(line: string, extension: string): CodeToken[] {
  const comments = commentStart(extension);
  const prose = extension === 'md' || extension === 'txt' || extension === '';
  const tokens: CodeToken[] = [];
  const push = (kind: CodeToken['kind'], text: string): void => {
    const last = tokens.at(-1);
    if (last !== undefined && last.kind === 'plain' && kind === 'plain') last.text += text;
    else tokens.push({ kind, text });
  };
  let at = 0;
  while (at < line.length) {
    const rest = line.slice(at);
    if (comments.some((start) => rest.startsWith(start)) || (!prose && rest.startsWith('<!--'))) {
      push('comment', rest);
      break;
    }
    const char = line.charAt(at);
    if (!prose && (char === '"' || char === "'" || char === '`')) {
      let end = at + 1;
      while (end < line.length && line.charAt(end) !== char) end += line.charAt(end) === '\\' ? 2 : 1;
      const stop = Math.min(end + 1, line.length);
      push('string', line.slice(at, stop));
      at = stop;
      continue;
    }
    const number = /^\d[\d_.]*/.exec(rest);
    if (!prose && number !== null && !/[A-Za-z_$]/.test(line.charAt(at - 1))) {
      push('number', number[0]);
      at += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word !== null) {
      push(!prose && KEYWORDS.has(word[0]) ? 'keyword' : 'plain', word[0]);
      at += word[0].length;
      continue;
    }
    push('plain', char);
    at += 1;
  }
  return tokens;
}

/** The extension the highlighter reads, lowercase; '' without one. */
export function extensionOf(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The first line a change touches, for "VS Code" on a changed file; undefined when unknown. */
export function firstChangedLine(hunks: readonly DiffHunk[]): number | undefined {
  for (const hunk of hunks) {
    let line = hunk.newStart;
    for (const entry of hunk.lines) {
      if (entry.kind === 'added') return line;
      if (entry.kind !== 'removed') line += 1;
    }
  }
  return undefined;
}

/** A refusal of the core in Italian, for the file, the folder or git of the page. */
export function browseErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return errorText(cause);
  if (cause.status === 410) return FILE_ERROR_TEXT.deleted ?? '';
  if (cause.status === 413) return FILE_ERROR_TEXT['too-large'] ?? '';
  if (cause.status === 415) return FILE_ERROR_TEXT.binary ?? '';
  if (cause.status === 403 && /approved|does not exist/.test(cause.message)) return FILE_ERROR_TEXT['not-approved'] ?? '';
  if (cause.status === 403) return FILE_ERROR_TEXT.refused ?? '';
  if (cause.status === 409 && /changed since/.test(cause.message)) return 'Il comando è cambiato nel file da quando l’hai visto: ricontrolla e conferma di nuovo.';
  if (cause.status === 409 && /already running/.test(cause.message)) return 'È già avviato.';
  if (cause.status === 409 && /not started from here/.test(cause.message)) return 'Non è stato avviato da qui: fermalo dove l’hai avviato.';
  if (cause.status === 409) return FILE_ERROR_TEXT.busy ?? '';
  if (cause.status === 404) return FILE_ERROR_TEXT['not-found'] ?? '';
  return errorText(cause);
}

/** A service of the tab Servizi (D-134, tappa 2), as the core lists it. */
export interface ServiceRunInfo {
  startedAt: string;
  running: boolean;
  ended: { at: string; code: number | null; signal: string | null; reason: 'exit' | 'stopped' | 'time-limit' | 'error' } | null;
}

export interface ServiceState {
  id: string;
  source: 'package.json' | 'compose' | 'Makefile';
  file: string;
  name: string;
  command: string[];
  script?: string;
  ports: number[];
  stays: boolean;
  /** Of the command and its script, sent back with a start: the core refuses one that changed since. */
  fingerprint: string;
  on: boolean;
  run: ServiceRunInfo | null;
}

export type ServiceLog = ServiceRunInfo & { lines: string[] };

/** The command as the confirmation shows it. */
export function commandText(command: readonly string[]): string {
  return command.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`)).join(' ');
}

/** What the confirmation says before a start or a stop: the command, where it comes from, how long it may run. */
export function confirmText(service: ServiceState, stop: boolean): { title: string; command: string; from: string; duration: string } {
  const from = service.source === 'package.json' ? `package.json → scripts.${service.name}` : service.source === 'compose' ? `${service.file} → services.${service.name}` : `Makefile → ${service.name}`;
  if (stop) {
    const command = service.source === 'compose' && service.run?.running !== true ? `docker compose -f ${service.file} stop ${service.name}` : `arresto di “${service.name}”`;
    return { title: `Fermare “${service.name}”?`, command, from, duration: 'arresto gentile, poi forzato dopo 10 secondi' };
  }
  const duration = service.source === 'compose' ? 'resta acceso con Docker finché lo fermi' : service.stays ? 'resta acceso finché lo fermi o chiudi Arianna' : 'si ferma da solo dopo 10 minuti';
  return { title: `Avviare “${service.name}”?`, command: commandText(service.command), from, duration };
}

/** The state word of a card. */
export function serviceStateText(service: ServiceState): string {
  if (service.run?.running === true) return service.on && service.ports.length > 0 ? 'acceso' : 'in corso';
  if (service.on) return 'acceso';
  if (service.ports.length === 0 && service.source === 'compose') return 'stato sconosciuto';
  return 'spento';
}

/** How a run ended, in Italian. */
export function endedText(run: ServiceRunInfo): string {
  if (run.running) return `avviato ${new Date(run.startedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
  const at = run.ended === null ? '' : new Date(run.ended.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const reason = run.ended?.reason;
  if (reason === 'stopped') return `fermato alle ${at}`;
  if (reason === 'time-limit') return `fermato alle ${at}: oltre 10 minuti`;
  if (reason === 'error') return 'non avviato';
  return `finito alle ${at} (codice ${String(run.ended?.code ?? run.ended?.signal ?? '?')})`;
}
