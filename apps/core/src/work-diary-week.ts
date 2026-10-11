import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { Project } from '@arianna/config';
import { isAtMost, maxLabel, type Label } from '@arianna/policy';

import { localTimestamp } from './capture.ts';
import { parsePage } from './orchestrator/kb.ts';
import { diaryFolder, KnowledgeError, MAX_NOTE_BYTES, type KnowledgeEnv } from './project-knowledge.ts';
import { diaryDay, headerLabel, inlineCode, oneLine, type WorkOutcome } from './work-diary.ts';

/**
 * The summary of the week of the diary of the works (I-15 D2, D-177): next to
 * the day files, `Workplan/diario/settimana-AAAA-Www.md` (ISO week), written
 * by the code, never by a model, from the entries of the diary of that week
 * alone, and written again whole each time an entry of that week is added.
 * It says only what the day files say: totals by outcome, by agent, by
 * executor and model, by part; one line per work with a wiki link to its day;
 * the files changed most often. The texts of the cloud stay in the day files:
 * here only the start of the request, as inline code (nothing in it renders).
 * A day file it cannot read or understand is left out, never fails the summary.
 */

const MAX_WORKS = 300;
const MAX_TOP = 20;
const MAX_TOP_FILES = 10;
const MAX_REQUEST = 120;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})(?:-(\d{1,2}))?\.md$/;
const HEADING = /^## (\d{2}):(\d{2}) · (.+) · (riuscito|non riuscito|fermato)\s*$/;
const OUTCOME_OF: Record<string, WorkOutcome> = { riuscito: 'ok', 'non riuscito': 'failed', fermato: 'stopped' };
const OUTCOME_TEXT: Record<WorkOutcome, { one: string; many: string }> = {
  ok: { one: 'riuscito', many: 'riusciti' },
  failed: { one: 'non riuscito', many: 'non riusciti' },
  stopped: { one: 'fermato', many: 'fermati' },
};
const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** One work as a day file of the diary tells it. */
export interface DiaryWork {
  /** `AAAA-MM-GG`, from the name of the day file. */
  day: string;
  /** The day file without `.md`, the target of the wiki link. */
  file: string;
  time: string;
  /** The agent, as the heading names it (`Coder`). */
  agent: string;
  /** Executor, alias and model (`Claude Sonnet (claude-sonnet-4-5)`); empty when the heading has none. */
  runner: string;
  outcome: WorkOutcome;
  /** The part; null for the whole project; undefined when the entry does not say. */
  part?: string | null;
  /** How many files changed, when they were read. */
  fileCount?: number;
  /** The paths listed (at most 50 per work, as the entry lists them). */
  files: string[];
  /** The first line of the request, when it left. */
  request?: string;
}

/** The ISO week of a local day: `{ year, week }`, the week starting on Monday. */
export function isoWeek(at: Date): { year: number; week: number } {
  // Calendar arithmetic on the local date, in UTC: no daylight saving in between.
  const day = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  const thursday = new Date(day + (3 - weekday) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return { year, week };
}

/** The name of the summary of the week of `at`: `settimana-2026-W41.md`. */
export function weekFileName(at: Date): string {
  const { year, week } = isoWeek(at);
  return `settimana-${String(year)}-W${String(week).padStart(2, '0')}.md`;
}

/** The seven local days (Monday first) of the ISO week of `at`, as `AAAA-MM-GG`. */
export function weekDays(at: Date): string[] {
  const monday = at.getDate() - ((at.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => diaryDay(new Date(at.getFullYear(), at.getMonth(), monday + index, 12)));
}

/** A name from a heading of a day file, without anything that renders in markdown or Obsidian. */
function plain(text: string, max = 100): string {
  return oneLine(text.replace(/[^\p{L}\p{N} .,:()/+@·-]+/gu, ' '), max);
}

/** The inside of an inline code span as work-diary.ts writes it. */
function fromInlineCode(text: string): string | undefined {
  const match = /^(`+)(.*)\1$/.exec(text);
  if (match === null) return undefined;
  const inner = match[2] ?? '';
  return inner.startsWith(' ') && inner.endsWith(' ') && inner.length >= 2 ? inner.slice(1, -1) : inner;
}

/**
 * The works of a day file, as work-diary.ts writes them. A line it does not
 * understand is skipped; the fenced texts of the cloud are never read as
 * headings or lines of the entry.
 */
export function parseDiaryDay(text: string, day: string, file: string): DiaryWork[] {
  const works: DiaryWork[] = [];
  let current: DiaryWork | undefined;
  let section: 'request' | 'files' | undefined;
  let fence: string | undefined;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== undefined) {
      if (line.trim() === fence) fence = undefined;
      else if (current !== undefined && section === 'request' && current.request === undefined && line.trim() !== '') current.request = line;
      continue;
    }
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (open !== null) {
      fence = open[1];
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const [, hours = '', minutes = '', who = '', outcome = ''] = heading;
      const at = who.indexOf(' · ');
      current = undefined;
      section = undefined;
      if (Number(hours) > 23 || Number(minutes) > 59) continue;
      current = {
        day,
        file,
        time: `${hours}:${minutes}`,
        agent: at < 0 ? who : who.slice(0, at),
        runner: at < 0 ? '' : who.slice(at + 3),
        outcome: OUTCOME_OF[outcome] ?? 'ok',
        files: [],
      };
      works.push(current);
      continue;
    }
    if (/^#{1,2} /.test(line)) {
      // Another heading of level 1 or 2: not a work of the diary.
      current = undefined;
      section = undefined;
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('### ')) {
      section = undefined;
      if (/^### Richiesta\s*$/.test(line)) section = 'request';
      const files = /^### File cambiati \((\d{1,6})\)\s*$/.exec(line);
      if (files !== null) {
        section = 'files';
        current.fileCount = Number(files[1]);
      }
      continue;
    }
    if (section === undefined) {
      const part = /^- Parte: (.+)$/.exec(line);
      if (part !== null && current.part === undefined) {
        const value = (part[1] ?? '').trim();
        if (value === 'tutto il progetto') current.part = null;
        else {
          const name = fromInlineCode(value);
          if (name !== undefined && name !== '') current.part = name;
        }
      }
      continue;
    }
    if (section === 'files') {
      const path = /^- (`+.*?`+) \(/.exec(line);
      const name = path === null ? undefined : fromInlineCode(path[1] ?? '');
      if (name !== undefined && name !== '') current.files.push(name);
    }
  }
  return works;
}

/** A regular file of the folder, never through a link nor blocking; undefined when it is not one or too large. */
function readPlain(dir: string, name: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const chunk = readSync(fd, buffer, read, stat.size - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Counts, most first, then by name. */
function top(values: Iterable<string>, max: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
}

function dayText(day: string, withWeekday = true): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const at = new Date(year, month - 1, date, 12);
  return `${withWeekday ? `${WEEKDAYS[at.getDay()] ?? ''} ` : ''}${String(date)} ${MONTHS[month - 1] ?? ''}`;
}

const partText = (part: string | null): string => (part === null ? 'tutto il progetto' : inlineCode(oneLine(part, 100)));

/** The body of the summary: what the works say, nothing else. */
export function formatWeekSummary(project: string, days: readonly string[], works: readonly DiaryWork[], left: number): string {
  const first = days[0] ?? '';
  const last = days.at(-1) ?? '';
  const lines = [
    `Riepilogo dei lavori nel progetto ${project} da ${dayText(first)} a ${dayText(last)} ${last.slice(0, 4)}, scritto da Arianna con il codice dalle voci del diario di quei giorni. Si riscrive a ogni voce nuova della settimana: le modifiche fatte qui a mano si perdono, quelle nei giorni restano.`,
    '',
    '## Totali',
    '',
  ];
  const byOutcome = (['ok', 'failed', 'stopped'] as const)
    .map((outcome) => ({ outcome, count: works.filter((work) => work.outcome === outcome).length }))
    .filter((item) => item.count > 0)
    .map((item) => `${String(item.count)} ${item.count === 1 ? OUTCOME_TEXT[item.outcome].one : OUTCOME_TEXT[item.outcome].many}`);
  lines.push(`- Lavori: ${String(works.length)}${byOutcome.length === 0 ? '' : ` (${byOutcome.join(', ')})`}`);
  const groups: [string, string[]][] = [
    ['Per agente', works.map((work) => plain(work.agent, 64))],
    ['Per esecutore e modello', works.filter((work) => work.runner !== '').map((work) => plain(work.runner))],
    ['Per parte', works.filter((work) => work.part !== undefined).map((work) => partText(work.part ?? null))],
  ];
  for (const [title, values] of groups) {
    const counted = top(values, MAX_TOP);
    if (counted.length === 0) continue;
    lines.push('', `### ${title}`, '', ...counted.map(([name, count]) => `- ${name}: ${String(count)}`));
  }

  lines.push('', '## Lavori', '');
  for (const work of works.slice(0, MAX_WORKS)) {
    const parts = [`[[${work.file}|${dayText(work.day)}, ${work.time}]]`, plain(work.agent, 64)];
    if (work.runner !== '') parts.push(plain(work.runner));
    parts.push(OUTCOME_TEXT[work.outcome].one);
    if (work.part !== undefined) parts.push(work.part === null ? 'tutto il progetto' : `parte ${partText(work.part)}`);
    if (work.fileCount !== undefined) parts.push(`${String(work.fileCount)} file`);
    if (work.request !== undefined) {
      const request = oneLine(work.request, MAX_REQUEST);
      if (request !== '') parts.push(inlineCode(request));
    }
    lines.push(`- ${parts.join(' · ')}`);
  }
  if (works.length > MAX_WORKS) lines.push(`- … e altri ${String(works.length - MAX_WORKS)}`);

  const files = top(
    works.flatMap((work) => [...new Set(work.files)]),
    MAX_TOP_FILES,
  );
  if (files.length > 0) {
    lines.push('', '## File cambiati più spesso', '', ...files.map(([path, count]) => `- ${inlineCode(oneLine(path, 1024))}: ${String(count)} ${count === 1 ? 'lavoro' : 'lavori'}`));
  }
  if (left > 0) lines.push('', `File del diario lasciati fuori (non leggibili o con un'etichetta più alta): ${String(left)}.`);
  return `${lines.join('\n')}\n`;
}

const errorCode = (error: unknown): string | undefined => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined);

/**
 * Writes again the summary of the week of `at` in the diary of `project`,
 * from the day files of that week; null when the project has no diary or the
 * week no work. Its label is the highest of the day files read, of its folder
 * and of the label its header already declares (raised by the user); a day
 * file above the diary (Interno, or the folder Workplan when higher) is left
 * out. Written whole, in a new file renamed over the old one: never through a
 * link, never over anything that is not a regular file.
 */
export function writeWeekSummary(projects: readonly Project[], project: string, env: KnowledgeEnv, at: Date): { path: string; label: Label } | null {
  const folder = diaryFolder(projects, project, env);
  if (folder === null) return null;
  const name = weekFileName(at);
  const days = weekDays(at);
  const floor = folder.labelOf(name, []);
  const ceiling = maxLabel('L1', floor);

  let names: string[];
  try {
    names = readdirSync(folder.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    throw new KnowledgeError('unavailable', 'cannot read the folder of the diary');
  }
  const files = names
    .map((file) => ({ file, match: DAY_FILE.exec(file) }))
    .filter((item): item is { file: string; match: RegExpExecArray } => item.match !== null && days.includes(item.match[1] ?? ''))
    .sort((a, b) => (a.match[1] ?? '').localeCompare(b.match[1] ?? '') || Number(a.match[2] ?? 1) - Number(b.match[2] ?? 1));

  const works: DiaryWork[] = [];
  let label: Label = floor;
  let left = 0;
  for (const { file, match } of files) {
    const text = readPlain(folder.dir, file);
    if (text === undefined) {
      left += 1;
      continue;
    }
    let dayLabel: Label;
    try {
      dayLabel = folder.labelOf(file, parsePage(text).header.labels);
    } catch {
      dayLabel = 'L3';
    }
    // A day above the diary (written by hand, a broken header) never raises the summary: it stays out.
    if (!isAtMost(dayLabel, ceiling)) {
      left += 1;
      continue;
    }
    const found = parseDiaryDay(text, match[1] ?? '', file.slice(0, -3));
    if (found.length === 0) continue;
    label = maxLabel(label, dayLabel);
    works.push(...found);
  }
  if (works.length === 0) return null;

  const target = join(folder.dir, name);
  const path = `${folder.path}/${name}`;
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isFile()) throw new KnowledgeError('refused', `${path} is not a regular file`);
  // A label the user wrote in its header is kept when higher.
  const declared = existing === undefined ? undefined : headerLabel(target);
  if (declared !== undefined) label = maxLabel(label, declared);

  const { year, week } = isoWeek(at);
  const title = `Diario dei lavori della settimana ${String(year)}-W${String(week).padStart(2, '0')}`;
  const header = ['---', `label: ${label}`, `source: diary:${project}`, `captured_at: ${localTimestamp(new Date())}`, 'kind: diary', `project: ${project}`, `title: ${JSON.stringify(title)}`, '---'].join('\n');
  const content = `${header}\n\n${formatWeekSummary(project, days, works, left)}`;
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) throw new KnowledgeError('too-large', 'the summary of the week is too long');

  if (!folder.sameFolder()) throw new KnowledgeError('refused', `${folder.path} is not a plain folder of the project`);
  // A hidden name: the search and the tab Conoscenza never list it, even for the instant it lives.
  const temporary = join(folder.dir, `.${name}.${randomUUID()}.tmp`);
  let fd: number;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new KnowledgeError('unavailable', 'cannot write the summary of the week');
  }
  let done = false;
  try {
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    const now = lstatSync(target, { throwIfNoEntry: false });
    if (now !== undefined && !now.isFile()) throw new KnowledgeError('refused', `${path} is not a regular file`);
    if (!folder.sameFolder()) throw new KnowledgeError('refused', `${folder.path} is not a plain folder of the project`);
    // rename replaces the name, never follows it.
    renameSync(temporary, target);
    done = true;
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError('unavailable', `cannot write the summary of the week${errorCode(error) === undefined ? '' : ` (${errorCode(error) ?? ''})`}`);
  } finally {
    if (!done) {
      try {
        unlinkSync(temporary);
      } catch {
        // Already gone.
      }
    }
  }
  return { path, label };
}
