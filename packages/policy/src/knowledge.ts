// Which notes of a project the Coder may read (I-11, tappa P3, D-166). Pure:
// the core walks the management folders and labels each note from its folder
// and its own header; the executors package checks again what it is given.
// A note passes only when it is at most L1, a plain markdown file at a plain
// path, and not a file an agent would load as its own instructions.
import { isAtMost, isLabel, type Label } from './labels.ts';
import { isSecretPath } from './workspace.ts';

/** The highest label of a note the Coder may read: a cloud executor's ceiling (rule 9). */
export const CODER_NOTE_CEILING: Label = 'L1';

/** Longest path of a note, relative to where the project's knowledge lives. */
const MAX_PATH = 512;
/** Folders below a management folder, the file included (MAX_DEPTH of the walk of the core, plus the file). */
const MAX_SEGMENTS = 8;

/**
 * Files an agent binary loads as instructions from a folder it is given
 * (`--add-dir` of claude loads CLAUDE.md; codex reads AGENTS.md): a note with
 * such a name would turn the user's text into the Coder's orders. Lowercased.
 */
const INSTRUCTION_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'gemini.md']);

export type CoderNoteSkip = 'path' | 'secret' | 'link' | 'instructions' | 'label';

export type CoderNoteDecision = { decision: 'allow'; label: Label } | { decision: 'skip'; reason: CoderNoteSkip };

export interface CoderNoteCheck {
  /** Relative to where the knowledge lives (`Workplan/piano.md`), with `/` separators. */
  path: unknown;
  /** The note's effective label: its folder's, raised by its header. Anything that is not a label counts as L2 (default-deny). */
  label: unknown;
  /** True when the entry is a symbolic link: never followed, never given. */
  link?: unknown;
}

/**
 * A plain relative path of a markdown note: no empty, `.` or `..` segment, no
 * hidden segment (`.claude/`, `.git/`), no backslash or control character, at
 * most MAX_SEGMENTS segments, ending in `.md`.
 */
export function isCoderNotePath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.length > MAX_PATH || /[\p{Cc}\\]/u.test(path)) return false;
  const segments = path.split('/');
  if (segments.length < 2 || segments.length > MAX_SEGMENTS) return false;
  if (!segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.'))) return false;
  return path.toLowerCase().endsWith('.md');
}

/**
 * Decides whether the Coder may read one note of a project (D-166), in this
 * order: a plain markdown path inside a management folder (`path`), no secret
 * name on the way (`secret`, as the pre-flight scan), not a link (`link`), not
 * an instruction file of an agent (`instructions`), at most L1 (`label`).
 */
export function checkCoderNote(note: CoderNoteCheck): CoderNoteDecision {
  if (!isCoderNotePath(note.path)) return { decision: 'skip', reason: 'path' };
  if (isSecretPath(note.path)) return { decision: 'skip', reason: 'secret' };
  if (note.link !== undefined && note.link !== false) return { decision: 'skip', reason: 'link' };
  const name = note.path.split('/').at(-1)?.normalize('NFC').toLowerCase() ?? '';
  if (INSTRUCTION_FILES.has(name)) return { decision: 'skip', reason: 'instructions' };
  const label: Label = isLabel(note.label) ? note.label : 'L2';
  if (!isAtMost(label, CODER_NOTE_CEILING)) return { decision: 'skip', reason: 'label' };
  return { decision: 'allow', label };
}
