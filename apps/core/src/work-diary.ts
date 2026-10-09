import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { Project } from '@arianna/config';
import type { FileChange } from '@arianna/executors';
import { isAtMost, isLabel, maxLabel, type Label } from '@arianna/policy';

import { localTimestamp } from './capture.ts';
import { parsePage } from './orchestrator/kb.ts';
import { HEADER_BYTES, KnowledgeError, MAX_NOTE_BYTES, openWorkplan, type KnowledgeEnv } from './project-knowledge.ts';

/**
 * The diary of the works (I-15, D-147): at the end of each work of an agent
 * in the cloud on a project (the Coder from a conversation with Arianna or in
 * its direct chat, on Claude or Codex; ended well, failed or stopped), the
 * core writes an entry in the knowledge of that project, in
 * `Workplan/diario/AAAA-MM-GG.md`. Written by the code, never by a model,
 * from what the core already has and only from what already left for the
 * cloud: the brief that passed the gateway, the report the cloud wrote, the
 * paths of the project's files. So an entry is never above L1; the file
 * carries the higher of that and the label of the folder Workplan.
 */

/** The subfolder of Workplan the diary lives in. */
export const DIARY_FOLDER = 'diario';
/** A day file stops growing before the search refuses to read it (MAX_NOTE_BYTES): the next entries go to `<day>-2.md`. */
export const DIARY_MAX_BYTES = 150_000;
const MAX_REQUEST = 4_000;
const MAX_REPORT = 6_000;
const MAX_FILES = 50;
const MAX_DAY_FILES = 20;
const CUT = '[…]';

export type WorkOutcome = 'ok' | 'failed' | 'stopped';

export interface WorkEntry {
  at: Date;
  /** The agent by the name of its card (`coder`). */
  agent: string;
  executor: 'claude' | 'codex';
  /** The router alias (`sonnet`, `sol`...). */
  alias: string;
  /** The model the binary reported at start, when it did. */
  model?: string;
  /** The project as `arianna.toml` names it: the container. */
  project: string;
  /** The part of a container; null when the project is one git. */
  part: string | null;
  outcome: WorkOutcome;
  /** Why it did not end well: our own text, never the executor's output. */
  reason?: string;
  /** The brief as it left through the gateway; absent when it did not leave. */
  request?: string;
  /** Paths and kinds only; undefined when they could not be read. */
  files?: readonly FileChange[];
  /** The commit the run left, when HEAD moved. */
  commit?: string;
  /** The report of the agent, as the chat stored it. */
  report?: string;
  /** Where the conversation opens in the chat of Arianna. */
  conversationUrl?: string;
  /**
   * The highest label of what the entry carries (brief, report, the paths of
   * the project). Only what went to the cloud: never above L1.
   */
  label: Label;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The local day of `at`, as the name of its file. */
export function diaryDay(at: Date): string {
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** One line, without control characters, at most `max` characters. */
function oneLine(text: string, max = 200): string {
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

const capitalized = (word: string): string => (word === '' ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`);

/** The longest run of backticks in `text`. */
function longestTicks(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
}

/**
 * Text of the cloud as a fenced block: nothing in it renders in Obsidian (no
 * link, no image fetched, no other note embedded), and no line of it can
 * close the fence, which is longer than any run of backticks in it.
 */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestTicks(text) + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** A path as inline code, whatever backticks it holds. */
function inlineCode(text: string): string {
  const ticks = '`'.repeat(longestTicks(text) + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${ticks}${padded}${ticks}`;
}

/** At most `max` characters: the start kept. */
function cut(text: string, max: number): string {
  const clean = text.replace(/\r\n/g, '\n').replaceAll('\0', '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - CUT.length)}${CUT}`;
}

const OUTCOMES: Record<WorkOutcome, string> = { ok: 'riuscito', failed: 'non riuscito', stopped: 'fermato' };
const CHANGES: Record<string, string> = { added: 'aggiunto', modified: 'modificato', deleted: 'cancellato', renamed: 'rinominato' };
const URL = /^http:\/\/[A-Za-z0-9.[\]:-]+\/c\/[0-9a-f-]{36}$/;

/** "Coder · Claude Sonnet (claude-sonnet-4-5)". */
export function workerName(entry: Pick<WorkEntry, 'agent' | 'executor' | 'alias' | 'model'>): string {
  const model = entry.model === undefined ? '' : ` (${oneLine(entry.model, 100)})`;
  return `${capitalized(oneLine(entry.agent, 64))} · ${capitalized(entry.executor)} ${capitalized(oneLine(entry.alias, 32))}${model}`;
}

/** One entry of the diary, as markdown: our lines, the texts of the cloud in fenced blocks. */
export function formatWorkEntry(entry: WorkEntry): string {
  const time = `${pad(entry.at.getHours())}:${pad(entry.at.getMinutes())}`;
  const lines = [`## ${time} · ${workerName(entry)} · ${OUTCOMES[entry.outcome]}`, ''];
  lines.push(`- Parte: ${entry.part === null ? 'tutto il progetto' : inlineCode(oneLine(entry.part, 100))}`);
  lines.push(`- Esito: ${OUTCOMES[entry.outcome]}${entry.reason === undefined ? '' : ` (${oneLine(entry.reason, 300)})`}`);
  if (entry.commit !== undefined && /^[0-9a-f]{7,64}$/.test(entry.commit)) lines.push(`- Commit: ${inlineCode(entry.commit)}`);
  if (entry.conversationUrl !== undefined && URL.test(entry.conversationUrl)) lines.push(`- Conversazione: [apri in Arianna](${entry.conversationUrl})`);
  lines.push(`- Etichetta: ${entry.label}`, '');

  lines.push('### Richiesta', '');
  lines.push(entry.request === undefined || entry.request.trim() === '' ? 'Non è uscita: il lavoro si è fermato prima.' : fenced(cut(entry.request, MAX_REQUEST)), '');

  const files = entry.files;
  if (files === undefined) {
    lines.push('### File cambiati', '', 'Non letti.', '');
  } else {
    lines.push(`### File cambiati (${String(files.length)})`, '');
    if (files.length === 0) lines.push('Nessuno.');
    for (const file of files.slice(0, MAX_FILES)) {
      const from = file.from === undefined ? '' : ` da ${inlineCode(oneLine(file.from, 1024))}`;
      lines.push(`- ${inlineCode(oneLine(file.path, 1024))} (${CHANGES[file.change] ?? 'cambiato'}${from})`);
    }
    if (files.length > MAX_FILES) lines.push(`- … e altri ${String(files.length - MAX_FILES)}`);
    lines.push('');
  }

  if (entry.report !== undefined && entry.report.trim() !== '') {
    lines.push(`### Riassunto di ${capitalized(oneLine(entry.agent, 64))}`, '', fenced(cut(entry.report, MAX_REPORT)), '');
  }
  return `\n${lines.join('\n')}`;
}

/** The first bytes of a regular file, never through a link nor blocking on a fifo. */
function readHead(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The label a day file declares in its header, when it declares exactly one. */
function headerLabel(file: string): Label | undefined {
  try {
    const labels = parsePage(readHead(file)).header.labels;
    const [label] = labels;
    return labels.length === 1 && label !== undefined && isLabel(label) ? label : undefined;
  } catch {
    return undefined;
  }
}

const errorCode = (error: unknown): string | undefined => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined);

/**
 * Writes `entry` at the end of the day file of the diary of `project` (the
 * container, as configured): `Workplan/diario/<day>.md`, created with a header
 * written here; the next file of the day (`<day>-2.md`...) when that one is
 * full or carries another label. Never through a link, never a file that is
 * not a regular file; the folders are created (0700) when missing. Returns
 * the path relative to the knowledge of the project and the label written.
 */
export function writeWorkDiary(projects: readonly Project[], project: string, env: KnowledgeEnv, entry: WorkEntry): { path: string; label: Label } {
  // Only what went to the cloud is written: a work above L1 is never one of the cloud.
  if (!isLabel(entry.label) || !isAtMost(entry.label, 'L1')) throw new KnowledgeError('refused', 'a work above L1 has no diary entry');
  const workplan = openWorkplan(projects, project, env);
  const label = maxLabel(entry.label, workplan.folder.label);

  const dir = join(workplan.dir, DIARY_FOLDER);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw new KnowledgeError('unavailable', 'cannot create the folder of the diary');
  }
  // Workplan and its diary are real folders: a link would take the entry elsewhere.
  const sameFolder = (): boolean => {
    try {
      return workplan.sameFolder() && lstatSync(dir).isDirectory() && realpathSync(dir) === dir;
    } catch {
      return false;
    }
  };
  if (!sameFolder()) throw new KnowledgeError('refused', `${workplan.folder.path}/${DIARY_FOLDER} is not a plain folder of the project`);

  const text = formatWorkEntry({ ...entry, label });
  const bytes = Buffer.byteLength(text, 'utf8');
  const day = diaryDay(entry.at);
  for (let index = 1; index <= MAX_DAY_FILES; index += 1) {
    const name = `${day}${index === 1 ? '' : `-${String(index)}`}.md`;
    const file = join(dir, name);
    const path = `${workplan.folder.path}/${DIARY_FOLDER}/${name}`;
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined) {
      const title = `Diario dei lavori del ${day}${index === 1 ? '' : ` (${String(index)})`}`;
      const header = ['---', `label: ${label}`, `source: diary:${workplan.project.name}`, `captured_at: ${localTimestamp(entry.at)}`, 'kind: diary', `project: ${workplan.project.name}`, `title: ${JSON.stringify(title)}`, '---'].join('\n');
      const content = `${header}\n\nVoci scritte da Arianna alla fine di ogni lavoro nel progetto ${workplan.project.name}.\n${text}`;
      if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new KnowledgeError('too-large', 'the entry is too long');
      let fd: number;
      try {
        // O_EXCL: a file made meanwhile is never overwritten; O_NOFOLLOW: a link is refused.
        fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        // Made meanwhile by another process: the next name of the day.
        if (errorCode(error) === 'EEXIST') continue;
        throw new KnowledgeError('unavailable', 'cannot create the diary');
      }
      let written = false;
      try {
        if (sameFolder()) {
          writeSync(fd, content);
          written = true;
        }
      } catch {
        // Disk full, I/O error: below, the partial file goes.
      } finally {
        closeSync(fd);
      }
      if (!written) {
        try {
          unlinkSync(file);
        } catch {
          // Already gone.
        }
        throw new KnowledgeError('unavailable', 'cannot write the diary');
      }
      return { path, label };
    }
    // A link or anything else than a file where the diary is: refused, never followed nor replaced.
    if (!stat.isFile()) throw new KnowledgeError('refused', `${path} is not a regular file`);
    if (stat.size + bytes > DIARY_MAX_BYTES) continue;
    // One label per file: an entry goes with the entries of its own label.
    if (headerLabel(file) !== label) continue;
    let fd: number;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new KnowledgeError('refused', `${path} cannot be opened as a regular file`);
    }
    try {
      // The same file that was checked, still in the same folder.
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || !sameFolder()) throw new KnowledgeError('refused', `${path} changed while it was opened`);
      writeSync(fd, text);
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('unavailable', 'cannot write the diary');
    } finally {
      closeSync(fd);
    }
    return { path, label };
  }
  throw new KnowledgeError('unavailable', 'too many diary files for this day');
}
