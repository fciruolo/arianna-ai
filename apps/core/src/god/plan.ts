/**
 * The plan GOD proposes (D-127, G2): one fenced block of its answer,
 *
 *   ```god-plan
 *   {"title": "...", "subtasks": [{"title": "...", "goal": "...", "files": ["apps/x.ts", "docs/y/"], "blocked_by": []}]}
 *   ```
 *
 * read and checked here, by the code, whenever the chat shows it and again
 * when the user approves it: the model's text is never trusted. Each subtask
 * owns its files (a path, or a folder ending with '/'); no file belongs to
 * two subtasks, and the documents every work shares (CHANGELOG, HANDOFF,
 * DECISIONS, the lockfile, the root package.json) belong to none: whoever
 * merges updates them.
 */
export const PLAN_FENCE = 'god-plan';
export const MAX_SUBTASKS = 6;
export const MAX_PLAN_TITLE = 120;
export const MAX_GOAL = 2000;
export const MAX_FILES = 40;
const MAX_PATH = 200;

/** Shared by every work: never owned by a subtask. */
export const SHARED_FILES: readonly string[] = ['CHANGELOG.md', 'docs/HANDOFF.md', 'docs/HANDOFF-STORIA.md', 'docs/DECISIONS.md', 'docs/OPEN-QUESTIONS.md', 'package.json', 'pnpm-lock.yaml'];

export interface PlannedSubtask {
  title: string;
  goal: string;
  files: string[];
  /** Positions (1-based) of earlier subtasks it waits for. */
  blockedBy: number[];
}

export interface GodPlanProposal {
  title: string;
  subtasks: PlannedSubtask[];
}

/** The text of the plan block of an answer, or undefined when it has none. The last block wins. */
export function planBlock(body: string): string | undefined {
  const fence = /```god-plan[ \t]*\n([\s\S]*?)\n```/g;
  let found: string | undefined;
  for (let match = fence.exec(body); match !== null; match = fence.exec(body)) found = match[1];
  return found;
}

/** The answer without its plan blocks: what the chat shows above the card of the plan. */
export function withoutPlan(body: string): string {
  return body.replace(/```god-plan[ \t]*\n[\s\S]*?\n```/g, '').trim();
}

function line(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' || Array.from(text).length > max ? undefined : text;
}

function block(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\r\n?/g, '\n').trim();
  // No control characters but newlines and tabs.
  if (text === '' || Array.from(text).length > max || /\p{Cc}/u.test(text.replace(/[\n\t]/g, ''))) return undefined;
  return text;
}

/** A path of the repository as a subtask may own it: relative, plain, no `..`, no `.git`. */
export function safePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const path = value.trim().replace(/^\.\//, '');
  if (path === '' || path.length > MAX_PATH || path.startsWith('/') || path.includes('\\') || /[\p{Cc}*?[\]]/u.test(path)) return undefined;
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) return undefined;
  return path;
}

/** True when two owned entries meet: the same file, or one a folder holding the other (ignoring case, as the disk). */
export function overlaps(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return true;
  if (x.endsWith('/') && y.startsWith(x)) return true;
  if (y.endsWith('/') && x.startsWith(y)) return true;
  return false;
}

/**
 * The plan of a block, checked: a title, 1 to 6 subtasks, each with a title,
 * a goal, 1 to 40 files of its own and dependencies only on earlier ones.
 * An error is a sentence for the user (and for GOD, when the user pastes it).
 */
export function checkGodPlan(text: string): GodPlanProposal | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'il piano non è JSON valido' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'il piano non è un oggetto JSON' };
  const plan = raw as Record<string, unknown>;
  const title = line(plan.title, MAX_PLAN_TITLE);
  if (title === undefined) return { error: `il piano vuole un titolo di 1-${String(MAX_PLAN_TITLE)} caratteri` };
  const items = Array.isArray(plan.subtasks) ? (plan.subtasks as unknown[]) : [];
  if (items.length < 1 || items.length > MAX_SUBTASKS) return { error: `il piano ha da 1 a ${String(MAX_SUBTASKS)} sottocompiti` };
  const subtasks: PlannedSubtask[] = [];
  for (const [index, item] of items.entries()) {
    const number = index + 1;
    const where = `sottocompito ${String(number)}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { error: `${where}: non è un oggetto` };
    const entry = item as Record<string, unknown>;
    const subtaskTitle = line(entry.title, MAX_PLAN_TITLE);
    if (subtaskTitle === undefined) return { error: `${where}: serve un titolo di 1-${String(MAX_PLAN_TITLE)} caratteri` };
    const goal = block(entry.goal, MAX_GOAL);
    if (goal === undefined) return { error: `${where}: serve un obiettivo di 1-${String(MAX_GOAL)} caratteri` };
    const listed = Array.isArray(entry.files) ? (entry.files as unknown[]) : [];
    if (listed.length < 1 || listed.length > MAX_FILES) return { error: `${where}: servono da 1 a ${String(MAX_FILES)} file suoi` };
    const files: string[] = [];
    for (const value of listed) {
      const path = safePath(value);
      if (path === undefined) return { error: `${where}: ${JSON.stringify(value)} non è un percorso del repository` };
      if (SHARED_FILES.some((shared) => overlaps(shared, path))) return { error: `${where}: ${path} è un documento condiviso, lo aggiorna chi unisce` };
      if (!files.some((other) => overlaps(other, path))) files.push(path);
    }
    const waits = Array.isArray(entry.blocked_by) ? (entry.blocked_by as unknown[]) : [];
    const blockedBy: number[] = [];
    for (const on of waits) {
      if (typeof on !== 'number' || !Number.isInteger(on) || on < 1 || on >= number) return { error: `${where}: "blocked_by" nomina solo sottocompiti precedenti (da 1 a ${String(number - 1)})` };
      if (!blockedBy.includes(on)) blockedBy.push(on);
    }
    subtasks.push({ title: subtaskTitle, goal, files, blockedBy });
  }
  for (const [index, subtask] of subtasks.entries()) {
    for (const [other, next] of subtasks.slice(index + 1).entries()) {
      const shared = subtask.files.find((path) => next.files.some((file) => overlaps(path, file)));
      if (shared !== undefined) return { error: `i sottocompiti ${String(index + 1)} e ${String(index + other + 2)} toccano gli stessi file (${shared}): mai due sottocompiti sugli stessi file` };
    }
  }
  return { title, subtasks };
}

/** The plan of an answer of GOD, checked; undefined when the answer has no plan block. */
export function planOfAnswer(body: string): GodPlanProposal | { error: string } | undefined {
  const text = planBlock(body);
  return text === undefined ? undefined : checkGodPlan(text);
}

/** A short name for the folder of a subtask, from its title: lowercase ASCII letters, digits and dashes. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return slug === '' ? 'lavoro' : slug;
}

/** The part of the n-th subtask ever made (1-999): `g<NNN>-<slug>`. */
export function partName(sequence: number, title: string): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) throw new RangeError('the subtasks of GOD are numbered 1-999');
  return `g${String(sequence).padStart(3, '0')}-${slugOf(title)}`;
}
