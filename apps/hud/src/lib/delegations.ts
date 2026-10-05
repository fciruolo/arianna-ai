import type { DelegationFile, DiffHunk, DiffLine, FileDiff, MessageCredit } from './types.ts';

/**
 * "Who did what" and "Files changed" under the answers written in the cloud
 * (D-082): pure logic of the chat, tested without a browser. The texts are in
 * italian.ts.
 */

/** The credits by message id, for the chat to look up under each message. */
export function creditsByMessage(credits: readonly MessageCredit[]): Map<string, MessageCredit> {
  return new Map(credits.map((credit) => [credit.messageId, credit]));
}

/** A message that gets a credit line: the Coder's report, or an answer written by a cloud model. */
export function hasCredit(message: { role: string; agent: string | null; model: string | null }): boolean {
  return message.role === 'assistant' && (message.agent !== null || message.model !== null);
}

/** The files that can be opened: a deleted one is no longer there. */
export function canPreview(file: DelegationFile): boolean {
  return file.change !== 'deleted';
}

const LANGUAGES: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  vue: 'vue',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  py: 'python',
  sh: 'sh',
  sql: 'sql',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  php: 'php',
  swift: 'swift',
};

/** The language of a file for the code block, from its extension; '' when unknown. */
export function languageOf(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? '';
}

/**
 * The file as one fenced code block of Markdown, for the existing renderer
 * (D-065): the fence is longer than any run of backticks in the text, so that
 * nothing in the file can close it or become Markdown.
 */
export function codeFence(text: string, path: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return `${fence}${languageOf(path)}\n${body}${fence}\n`;
}

/** A line of a diff as the chat draws it: its numbers in the old and new file, and its sign. */
export interface DiffRow {
  kind: DiffLine['kind'] | 'gap';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** The rows of a file's diff (D-117): each hunk's lines with their numbers, a gap row between hunks. */
export function diffRows(hunks: readonly DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [at, hunk] of hunks.entries()) {
    if (at > 0 || hunk.oldStart > 1 || hunk.newStart > 1) rows.push({ kind: 'gap', oldLine: null, newLine: null, text: '' });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === 'added') {
        rows.push({ kind: 'added', oldLine: null, newLine, text: line.text });
        newLine += 1;
      } else if (line.kind === 'removed') {
        rows.push({ kind: 'removed', oldLine, newLine: null, text: line.text });
        oldLine += 1;
      } else {
        rows.push({ kind: 'context', oldLine, newLine, text: line.text });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return rows;
}

/** Lines added and removed over the files whose diff is shown. */
export function diffTotals(files: readonly FileDiff[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    if ('error' in file) continue;
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}
