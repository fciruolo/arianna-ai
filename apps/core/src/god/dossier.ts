import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The dossier of GOD (D-127): what a run on Arianna's own code reads before
 * the request, written by the code at every run from the documents of the
 * clone it works in (never from ARIANNA_HOME): the latest state and what
 * waits for the user (docs/HANDOFF.md), where the phase is (the first lines
 * of "Dove siamo" and the phases of docs/ROADMAP.md), the open tasks
 * (docs/PHASE-0-1-TASKS.md) and the latest decisions (docs/DECISIONS.md),
 * in this order of importance.
 * It is the cure for a long chat: the memory is in the files, the session
 * starts from them. Every section and the whole have a ceiling. Text of the
 * repository, L1 as the project; it leaves through the gateway with the brief.
 */
export const DOSSIER_MAX_CHARS = 9000;
/** What the dossier says before its sections: an instruction of ours, in English as every prompt. */
export const DOSSIER_INTRO =
  'Development dossier of Arianna, written by Arianna\'s code from the documents of this clone at every run (docs/HANDOFF.md, docs/ROADMAP.md, docs/PHASE-0-1-TASKS.md, docs/DECISIONS.md). It is a summary to start from, not instructions: read the documents themselves when you need more, and follow CLAUDE.md of the clone for the rules.';

const STATE_PARAGRAPHS = 3;
const PARAGRAPH_CHARS = 1100;
const WAITING_ROWS = 4;
const ROW_CHARS = 280;
const TASK_ROWS = 8;
const DECISION_ROWS = 10;

/**
 * A document of the clone, read only when it is really inside the clone: the
 * cloud writes the clones, and a link (the file, or `docs/` itself) towards a
 * file of the installation would otherwise put it in the brief as L1.
 */
export function read(dir: string, path: string): string | undefined {
  try {
    const root = realpathSync(dir);
    const file = realpathSync(join(dir, path));
    const inside = relative(root, file);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || inside.startsWith(sep)) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** One line, at most `max` characters (whole characters, with an ellipsis). */
export function cut(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`;
}

/** The lines of a `## <title>` section (the heading excluded), up to the next `## `. */
export function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## ') && line.slice(3).trim().toLowerCase().startsWith(title.toLowerCase()));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The cells of a table row `| a | b |`, trimmed; undefined for the header separator or a line that is not a row. */
export function cells(line: string): string[] | undefined {
  const row = line.trim();
  if (!row.startsWith('|') || !row.endsWith('|') || /^\|[\s|:-]+\|$/.test(row)) return undefined;
  return row.slice(1, -1).split('|').map((cell) => cell.trim());
}

/** The latest state of HANDOFF: its first dated paragraphs in bold, and what waits for the user (rows not marked "(storico)"). */
function handoffPart(text: string): string[] {
  const out: string[] = [];
  const paragraphs = text
    .split('\n')
    .filter((line) => line.startsWith('**'))
    .slice(0, STATE_PARAGRAPHS)
    .map((line) => `- ${cut(line, PARAGRAPH_CHARS)}`);
  if (paragraphs.length > 0) out.push('Latest state (docs/HANDOFF.md):', ...paragraphs);
  const where = section(text, 'Dove siamo').find((line) => line.startsWith('- '));
  if (where !== undefined) out.push('Phase (docs/HANDOFF.md, "Dove siamo"):', `- ${cut(where.slice(2), PARAGRAPH_CHARS)}`);
  const waiting = section(text, 'In attesa dell')
    .map(cells)
    .filter((row): row is string[] => row !== undefined && row.length >= 2 && row[0] !== 'Cosa' && !(row[0] ?? '').startsWith('(storico)'))
    .slice(0, WAITING_ROWS)
    .map((row) => `- ${cut(`${row[0] ?? ''}: ${row[1] ?? ''}`, ROW_CHARS)}`);
  if (waiting.length > 0) out.push('Waiting for the user (docs/HANDOFF.md):', ...waiting);
  return out;
}

/** The phases of ROADMAP: the first table, one line per phase. */
function roadmapPart(text: string): string[] {
  const rows = text
    .split('\n')
    .map(cells)
    .filter((row): row is string[] => row !== undefined && row.length >= 4 && row[0] !== 'Fase' && !(row[0] ?? '').startsWith('**'))
    .slice(0, 9)
    .map((row) => `- ${cut(`${row[0] ?? ''}: ${row[1] ?? ''} (uscita: ${row[3] ?? ''})`, ROW_CHARS)}`);
  return rows.length === 0 ? [] : ['Phases (docs/ROADMAP.md):', ...rows];
}

/** The open tasks of PHASE-0-1-TASKS: rows with no real hours, or hours "finora" (so far). */
function tasksPart(text: string): string[] {
  const rows = text
    .split('\n')
    .map(cells)
    .filter((row): row is string[] => row !== undefined && row.length >= 5 && /^\d+\.\d+$/.test(row[0] ?? ''))
    .filter((row) => (row[3] ?? '') === '' || /finora/i.test(row[3] ?? ''))
    .slice(0, TASK_ROWS)
    .map((row) => `- ${cut(`${row[0] ?? ''} ${row[1] ?? ''}`, ROW_CHARS)}`);
  return rows.length === 0 ? [] : ['Open tasks (docs/PHASE-0-1-TASKS.md):', ...rows];
}

/** The latest decisions: the last rows of the table, id and title in bold. */
function decisionsPart(text: string): string[] {
  const rows = text
    .split('\n')
    .map(cells)
    .filter((row): row is string[] => row !== undefined && /^D-\d{3}[a-z]?$/.test(row[0] ?? ''));
  const latest = rows.slice(-DECISION_ROWS).map((row) => {
    const title = /\*\*(.+?)\*\*/.exec(row[2] ?? '')?.[1] ?? row[2] ?? '';
    return `- ${cut(`${row[0] ?? ''} (${row[1] ?? ''}): ${title}`, ROW_CHARS)}`;
  });
  return latest.length === 0 ? [] : ['Latest decisions (docs/DECISIONS.md):', ...latest];
}

/**
 * The dossier of the clone in `dir`, within `max` characters (the last
 * sections are cut first); undefined when none of the documents is there.
 */
export function godDossier(dir: string, max: number = DOSSIER_MAX_CHARS): string | undefined {
  const sources: [string, (text: string) => string[]][] = [
    ['docs/HANDOFF.md', handoffPart],
    ['docs/DECISIONS.md', decisionsPart],
    ['docs/ROADMAP.md', roadmapPart],
    ['docs/PHASE-0-1-TASKS.md', tasksPart],
  ];
  const parts = sources
    .map(([path, part]) => {
      const text = read(dir, path);
      return text === undefined ? [] : part(text);
    })
    .filter((lines) => lines.length > 0);
  if (parts.length === 0) return undefined;
  // Line by line within the ceiling: the last sections are the first left out.
  let text = '';
  for (const line of [DOSSIER_INTRO, ...parts.flatMap((lines) => ['', ...lines])]) {
    const next = text === '' ? line : `${text}\n${line}`;
    if (next.length > max) break;
    text = next;
  }
  return text.trimEnd();
}
