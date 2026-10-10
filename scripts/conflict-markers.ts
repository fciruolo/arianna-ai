// Refuses a commit whose staged files still hold the markers of a merge
// conflict (<<<<<<<, =======, >>>>>>> at the start of a line). Run by
// .githooks/pre-commit before `pnpm check`, which does not read CHANGELOG.md
// or the documents: a merge commit once kept them there (2026-10-10).
// Reads the staged content (the index), not the working tree. A setext
// heading underlined with exactly seven '=' would be refused too: underline
// it with a different length.
import { execFileSync } from 'node:child_process';

const MARKER = /^(?:<{7}|={7}|>{7})(?: |$)/;

/** The 1-based lines of `text` that are conflict markers. */
export function markerLines(text: string): number[] {
  const lines: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (MARKER.test(line.replace(/\r$/, ''))) lines.push(index + 1);
  });
  return lines;
}

function staged(): string[] {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter((path) => path !== '');
}

function stagedText(path: string): string | undefined {
  const bytes = execFileSync('git', ['show', `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  // A binary file (a NUL byte) has no lines to check.
  return bytes.includes(0) ? undefined : bytes.toString('utf8');
}

function main(): void {
  const found: string[] = [];
  try {
    for (const path of staged()) {
      const text = stagedText(path);
      if (text === undefined) continue;
      for (const line of markerLines(text)) found.push(`${path}:${String(line)}`);
    }
  } catch (error) {
    // Refused, never let through: a check that cannot read is not a check.
    process.stderr.write(`Commit rifiutato: non riesco a leggere i file in stage per cercare i segni di conflitto (${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}).\n`);
    process.exit(1);
  }
  if (found.length === 0) return;
  process.stderr.write(`Commit rifiutato: segni di un conflitto di unione ancora presenti:\n${found.map((place) => `  ${place}`).join('\n')}\n`);
  process.exit(1);
}

// import.meta.main, not a comparison of URL and argv: that one is false for a
// path with a space or through a link, and the check would quietly let all pass.
if (import.meta.main) main();
