/**
 * A line diff in the unified style, written here without a dependency
 * (D-117): the chat shows what the Coder changed in a file, removed lines in
 * red and added ones in green, with a few lines of context around them.
 *
 * Common lines at the start and at the end are set aside first; what is left
 * is aligned on its longest common subsequence when the table fits in
 * MAX_CELLS, otherwise shown as all removed then all added (still correct,
 * only coarser).
 */

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  /** 1-based first line in the old file (0 when the hunk has no old lines). */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface LineDiff {
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

/** Lines of context around each change. */
export const CONTEXT_LINES = 3;
/** Largest LCS table, in cells (two bytes each). */
export const MAX_CELLS = 4_000_000;

/** The lines of a text; a final newline does not make an empty last line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

interface Op {
  kind: DiffLineKind;
  text: string;
}

/** The edit script of the middle part, by longest common subsequence. */
function alignMiddle(old: readonly string[], next: readonly string[], maxCells: number): Op[] {
  const n = old.length;
  const m = next.length;
  if (n === 0) return next.map((text) => ({ kind: 'added', text }));
  if (m === 0) return old.map((text) => ({ kind: 'removed', text }));
  if ((n + 1) * (m + 1) > Math.min(maxCells, MAX_CELLS)) {
    return [...old.map((text): Op => ({ kind: 'removed', text })), ...next.map((text): Op => ({ kind: 'added', text }))];
  }
  // lcs[i][j]: the LCS of old[i..] and next[j..]. min(n, m) < 2000 here, so two bytes are enough.
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = old[i] === next[j] ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (old[i] === next[j]) {
      ops.push({ kind: 'context', text: old[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ kind: 'removed', text: old[i] ?? '' });
      i += 1;
    } else {
      ops.push({ kind: 'added', text: next[j] ?? '' });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ kind: 'removed', text: old[i] ?? '' });
  for (; j < m; j += 1) ops.push({ kind: 'added', text: next[j] ?? '' });
  return ops;
}

export interface DiffOptions {
  /** Lines of context around each change; CONTEXT_LINES by default. */
  context?: number;
  /** A smaller LCS table than MAX_CELLS, for a caller with a budget over several files. */
  maxCells?: number;
}

/** The diff from `before` to `after`, in hunks with CONTEXT_LINES of context. */
export function diffLines(before: string, after: string, { context = CONTEXT_LINES, maxCells = MAX_CELLS }: DiffOptions = {}): LineDiff {
  const old = splitLines(before);
  const next = splitLines(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  const ops: Op[] = [
    ...old.slice(0, start).map((text): Op => ({ kind: 'context', text })),
    ...alignMiddle(old.slice(start, old.length - end), next.slice(start, next.length - end), maxCells),
    ...old.slice(old.length - end).map((text): Op => ({ kind: 'context', text })),
  ];

  // Line numbers before each op, then the changes grouped with their context:
  // two changes closer than twice the context share a hunk.
  const at: { old: number; next: number }[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    at.push({ old: oldLine, next: newLine });
    if (op.kind !== 'added') oldLine += 1;
    if (op.kind !== 'removed') newLine += 1;
  }
  const ranges: { from: number; to: number }[] = [];
  ops.forEach((op, index) => {
    if (op.kind === 'context') return;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length, index + context + 1);
    const last = ranges.at(-1);
    if (last !== undefined && from <= last.to) last.to = to;
    else ranges.push({ from, to });
  });
  let added = 0;
  let removed = 0;
  const hunks = ranges.map(({ from, to }): DiffHunk => {
    const lines = ops.slice(from, to);
    const oldLines = lines.filter((op) => op.kind !== 'added').length;
    const newLines = lines.filter((op) => op.kind !== 'removed').length;
    added += lines.filter((op) => op.kind === 'added').length;
    removed += lines.filter((op) => op.kind === 'removed').length;
    const first = at[from] ?? { old: 1, next: 1 };
    // As in a unified diff: a side with no lines starts at the line before.
    return {
      oldStart: oldLines === 0 ? first.old - 1 : first.old,
      oldLines,
      newStart: newLines === 0 ? first.next - 1 : first.next,
      newLines,
      lines: lines.map(({ kind, text }) => ({ kind, text })),
    };
  });
  return { added, removed, hunks };
}
