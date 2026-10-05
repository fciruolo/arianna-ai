import type { DelegationFile, MessageCredit } from './types.ts';

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
