import { createHash, randomBytes } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { projectParts, rulesFor, rulesOfProject, type Project, type ProjectRules } from '@arianna/config';

/**
 * "Esporta in CLAUDE.md e AGENTS.md" (I-14 R3, D-176): the saved rules of a
 * container written, on the user's request and after a preview, in the two
 * files Claude Code and Codex read by themselves, in every part (each part is
 * a repository, where they are launched). A convenience for work outside
 * Arianna: Arianna keeps reading its own rules. Nothing in the files says who
 * wrote them (the rules forbid traces of AI): which files Arianna wrote is
 * kept outside git, in data/rules-export.json, as the sha256 of what it wrote.
 * A file that is there and is not exactly that is the user's, and it is never
 * touched; nor is anything that is not a plain file.
 */

export const EXPORT_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/** Which executor reads which file (D-181): an item marked for the other one stays out of it. */
const READER = { 'CLAUDE.md': 'claude', 'AGENTS.md': 'codex' } as const;

/**
 * new: not there; same: already the rules; arianna: written by Arianna and
 * unchanged since; foreign: the user's, left alone; stale: written by Arianna,
 * unchanged, and now with no rule for its executor, so it goes (D-181).
 */
export type ExportStatus = 'new' | 'same' | 'arianna' | 'foreign' | 'stale';

export interface ExportTarget {
  /** Relative to the container: `CLAUDE.md`, or `<part>/CLAUDE.md`. */
  path: string;
  status: ExportStatus;
}

export interface ExportPlan {
  /** The saved rules, as the user wrote them: what the confirmation checks. */
  text: string;
  files: ExportTarget[];
  /** What each file will hold (D-181): CLAUDE.md the rules for Claude Code, AGENTS.md those for Codex. */
  contents?: Record<(typeof EXPORT_FILES)[number], string>;
}

export interface ExportEnv {
  /** ARIANNA_HOME: the ledger lives in its data/. */
  home: string;
}

export type ExportOutcome =
  | { ok: true; files: { path: string; status: 'written' | 'same' | 'foreign' | 'removed' }[] }
  | { ok: false; reason: 'no-rules' | 'changed' | 'files-changed' };

/** The outcome for a project that is not there, or has no rules. */
export const NO_RULES: ExportOutcome = { ok: false, reason: 'no-rules' };

type Ledger = Record<string, string>;

function ledgerPath(env: ExportEnv): string {
  return join(env.home, 'data', 'rules-export.json');
}

function readLedger(env: ExportEnv): Ledger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(env), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ledger: Ledger = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') ledger[key] = value;
    return ledger;
  } catch {
    return {};
  }
}

/**
 * Through a file of its own: a half-written file is never read. `replace`
 * renames over the file (one Arianna wrote, checked just before); otherwise a
 * hard link, which fails when a file appeared meanwhile instead of replacing it.
 */
function writeAtomic(path: string, content: string, replace: boolean): void {
  const temporary = join(dirname(path), `.arianna-export-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeLedger(env: ExportEnv, ledger: Ledger): void {
  mkdirSync(dirname(ledgerPath(env)), { recursive: true });
  writeAtomic(ledgerPath(env), `${JSON.stringify(ledger, null, 2)}\n`, true);
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The saved rules of the project with a final line break, undefined when it has none. */
function savedText(rules: ProjectRules, project: string): string | undefined {
  const text = rulesOfProject(rules, project);
  return text === undefined ? undefined : `${text}\n`;
}

/** The content of each file (D-181): the rules as its executor reads them, with a final line break; empty when none is for it. */
function contentsOf(text: string): Record<(typeof EXPORT_FILES)[number], string> {
  const of = (file: (typeof EXPORT_FILES)[number]): string => {
    const kept = rulesFor(text, READER[file]);
    return kept === undefined ? '' : `${kept}\n`;
  };
  return { 'CLAUDE.md': of('CLAUDE.md'), 'AGENTS.md': of('AGENTS.md') };
}

interface Target {
  /** Relative to the container. */
  path: string;
  absolute: string;
  /** The ledger's key: the project's name, never a path of this computer. */
  key: string;
  file: (typeof EXPORT_FILES)[number];
}

/** The two files in every part that is a real folder now. */
function targets(project: Project): Target[] {
  return projectParts(project).flatMap((part) => {
    try {
      if (!lstatSync(part.absolute).isDirectory()) return [];
    } catch {
      return [];
    }
    return EXPORT_FILES.map((file) => {
      const path = part.part === null ? file : `${part.part}/${file}`;
      return { path, absolute: join(part.absolute, file), key: `${project.name}/${path}`, file };
    });
  });
}

function statusOf(target: Target, wanted: string, ledger: Ledger): ExportStatus {
  let content: Buffer;
  try {
    // A link, a folder or anything else that is not a plain file is never written through.
    if (!lstatSync(target.absolute).isFile()) return 'foreign';
    content = readFileSync(target.absolute);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'new' : 'foreign';
  }
  if (content.toString('utf8') === wanted) return 'same';
  return ledger[target.key] === sha256(content) ? 'arianna' : 'foreign';
}

/**
 * What each file would get (D-181). A file with no rule for its executor is
 * not written: left out when it is not there, `stale` (it goes) when Arianna
 * wrote it and nobody changed it, so that an old CLAUDE.md never keeps a rule
 * that is now for Codex only; one of the user's is listed and left alone.
 */
function planOf(project: Project, contents: Record<(typeof EXPORT_FILES)[number], string>, ledger: Ledger): { target: Target; status: ExportStatus }[] {
  return targets(project).flatMap((target) => {
    const status = statusOf(target, contents[target.file], ledger);
    if (contents[target.file] !== '') return [{ target, status }];
    if (status === 'new' || status === 'same') return [];
    return [{ target, status: status === 'arianna' ? ('stale' as const) : status }];
  });
}

/** What an export would do now: the preview. Undefined when the project has no rules. */
export function planRulesExport(env: ExportEnv, project: Project, rules: ProjectRules): ExportPlan | undefined {
  const text = savedText(rules, project.name);
  if (text === undefined) return undefined;
  const contents = contentsOf(text);
  const ledger = readLedger(env);
  return { text, files: planOf(project, contents, ledger).map(({ target, status }) => ({ path: target.path, status })), contents };
}

/**
 * Writes the files the preview showed as new or Arianna's. `expected` is what
 * the user saw: rules changed meanwhile, or files that are no longer as the
 * preview listed them (a part added, a file of the user removed), write nothing.
 */
export function writeRulesExport(env: ExportEnv, project: Project, rules: ProjectRules, expected: ExportPlan): ExportOutcome {
  const text = savedText(rules, project.name);
  if (text === undefined) return { ok: false, reason: 'no-rules' };
  if (text !== expected.text) return { ok: false, reason: 'changed' };
  const contents = contentsOf(text);
  const ledger = readLedger(env);
  const plan = planOf(project, contents, ledger);
  const seen = expected.files.map((file) => `${file.path}:${file.status}`).join('\n');
  if (plan.map(({ target, status }) => `${target.path}:${status}`).join('\n') !== seen) return { ok: false, reason: 'files-changed' };
  const files: { path: string; status: 'written' | 'same' | 'foreign' | 'removed' }[] = [];
  let recorded = false;
  try {
    for (const { target, status } of plan) {
      if (status === 'same' || status === 'foreign') {
        files.push({ path: target.path, status });
        continue;
      }
      if (status === 'stale') {
        // Checked just above as a plain file with Arianna's hash: it goes, and so does its line of the ledger.
        rmSync(target.absolute);
        Reflect.deleteProperty(ledger, target.key);
        recorded = true;
        files.push({ path: target.path, status: 'removed' });
        continue;
      }
      // Recorded before the write: a write that fails leaves a file without this hash, never a file of Arianna's unrecorded.
      ledger[target.key] = sha256(contents[target.file]);
      recorded = true;
      writeAtomic(target.absolute, contents[target.file], status === 'arianna');
      files.push({ path: target.path, status: 'written' });
    }
  } finally {
    if (recorded) writeLedger(env, ledger);
  }
  return { ok: true, files };
}
