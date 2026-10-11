import { createHash, randomBytes } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { projectParts, rulesOfProject, type Project, type ProjectRules } from '@arianna/config';

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

/** new: not there; same: already the rules; arianna: written by Arianna and unchanged since; foreign: the user's, left alone. */
export type ExportStatus = 'new' | 'same' | 'arianna' | 'foreign';

export interface ExportTarget {
  /** Relative to the container: `CLAUDE.md`, or `<part>/CLAUDE.md`. */
  path: string;
  status: ExportStatus;
}

export interface ExportPlan {
  /** The rules as the files will hold them. */
  text: string;
  files: ExportTarget[];
}

export interface ExportEnv {
  /** ARIANNA_HOME: the ledger lives in its data/. */
  home: string;
}

export type ExportOutcome =
  | { ok: true; files: { path: string; status: 'written' | 'same' | 'foreign' }[] }
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

/** The file content of the rules: the saved text with a final line break. */
function exportedText(rules: ProjectRules, project: string): string | undefined {
  const text = rulesOfProject(rules, project);
  return text === undefined ? undefined : `${text}\n`;
}

interface Target {
  /** Relative to the container. */
  path: string;
  absolute: string;
  /** The ledger's key: the project's name, never a path of this computer. */
  key: string;
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
      return { path, absolute: join(part.absolute, file), key: `${project.name}/${path}` };
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

/** What an export would do now: the preview. Undefined when the project has no rules. */
export function planRulesExport(env: ExportEnv, project: Project, rules: ProjectRules): ExportPlan | undefined {
  const text = exportedText(rules, project.name);
  if (text === undefined) return undefined;
  const ledger = readLedger(env);
  return { text, files: targets(project).map((target) => ({ path: target.path, status: statusOf(target, text, ledger) })) };
}

/**
 * Writes the files the preview showed as new or Arianna's. `expected` is what
 * the user saw: rules changed meanwhile, or files that are no longer as the
 * preview listed them (a part added, a file of the user removed), write nothing.
 */
export function writeRulesExport(env: ExportEnv, project: Project, rules: ProjectRules, expected: ExportPlan): ExportOutcome {
  const text = exportedText(rules, project.name);
  if (text === undefined) return { ok: false, reason: 'no-rules' };
  if (text !== expected.text) return { ok: false, reason: 'changed' };
  const ledger = readLedger(env);
  const plan = targets(project).map((target) => ({ target, status: statusOf(target, text, ledger) }));
  const seen = expected.files.map((file) => `${file.path}:${file.status}`).join('\n');
  if (plan.map(({ target, status }) => `${target.path}:${status}`).join('\n') !== seen) return { ok: false, reason: 'files-changed' };
  const files: { path: string; status: 'written' | 'same' | 'foreign' }[] = [];
  let recorded = false;
  try {
    for (const { target, status } of plan) {
      if (status === 'same' || status === 'foreign') {
        files.push({ path: target.path, status });
        continue;
      }
      // Recorded before the write: a write that fails leaves a file without this hash, never a file of Arianna's unrecorded.
      ledger[target.key] = sha256(text);
      recorded = true;
      writeAtomic(target.absolute, text, status === 'arianna');
      files.push({ path: target.path, status: 'written' });
    }
  } finally {
    if (recorded) writeLedger(env, ledger);
  }
  return { ok: true, files };
}
