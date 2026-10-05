/**
 * The Markdown of a reply, as a tree the page renders with Vue nodes (D-065):
 * never HTML, so a reply cannot put markup in the page. What is not listed
 * here stays text: raw HTML, images (an image would be fetched from someone
 * else's server, carrying data out), links that are not http, https or
 * mailto. Covers what models write: paragraphs, headings (also setext,
 * underlined with `===` or `---`), fenced code, lists (nested), quotes (also
 * with lazy lines, as CommonMark), rules, pipe tables; bold, italic,
 * strikethrough, inline code, links and bare URLs.
 */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

/** Lists and quotes nested deeper than this are shown as plain paragraphs. */
const MAX_DEPTH = 8;
/** How far a code span or a link label is looked for: keeps a crafted reply from stalling the page. */
const MAX_SPAN = 2000;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
/** The underline of a setext heading: only `=` (level 1) or only `-` (level 2), no spaces between. */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** The closing line of a fence, whatever its run (checked against the opening one). */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const SEP_CELL = /^:?-+:?$/;

/** A line, or '' past the end; `index` is never negative. */
function lineAt(lines: readonly string[], index: number): string {
  return lines.at(index) ?? '';
}

/** A capture group of a match, or '' when it did not take part. */
function group(match: RegExpExecArray, index: number): string {
  return match.at(index) ?? '';
}

function blank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A heading's text: without the spaces around it and the closing run of `#` (string operations, no backtracking). */
function headingText(line: string, match: RegExpExecArray): string {
  const text = line.slice(match[0].length).trim();
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === '#') end--;
  if (end === text.length) return text;
  return end === 0 || text.charAt(end - 1) === ' ' || text.charAt(end - 1) === '\t' ? text.slice(0, end).trimEnd() : text;
}

/** The cells of a table row: pipes inside inline code or escaped do not split. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const char = row.charAt(i);
    if (char === '\\' && row.charAt(i + 1) === '|') {
      cell += '|';
      i++;
      continue;
    }
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function separator(line: string): boolean {
  return line.includes('-') && splitRow(line).every((cell) => SEP_CELL.test(cell));
}

function tableAt(lines: readonly string[], i: number): boolean {
  const head = lineAt(lines, i);
  const sep = lineAt(lines, i + 1);
  return head.includes('|') && separator(sep) && splitRow(sep).length === splitRow(head).length;
}

function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lineAt(lines, i);
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || tableAt(lines, i);
}

function ordered(marker: string): boolean {
  return /\d/.test(marker);
}

/** Same kind of list: ordered with the same punctuation, or bullets with the same character. */
function sameList(a: string, b: string): boolean {
  return ordered(a) ? ordered(b) && a.at(-1) === b.at(-1) : a === b;
}

function parseList(lines: readonly string[], from: number, depth: number): [Block, number] {
  const first = ITEM.exec(lineAt(lines, from)) as RegExpExecArray;
  const indent = group(first, 1).length;
  const marker = group(first, 2);
  const items: string[][] = [];
  let current: string[] = [];
  let contentIndent = indent + marker.length + 1;
  let i = from;
  while (i < lines.length) {
    const line = lineAt(lines, i);
    const item = ITEM.exec(line);
    if (item !== null && group(item, 1).length === indent && sameList(marker, group(item, 2)) && !RULE.test(line)) {
      current = [group(item, 3)];
      items.push(current);
      contentIndent = indent + group(item, 2).length + 1;
      i++;
      continue;
    }
    if (blank(line)) {
      let next = i + 1;
      while (next < lines.length && blank(lineAt(lines, next))) next++;
      if (next >= lines.length) break;
      const following = ITEM.exec(lineAt(lines, next));
      if (indentOf(lineAt(lines, next)) > indent && !(following !== null && group(following, 1).length <= indent)) {
        for (; i < next; i++) current.push('');
        continue;
      }
      if (following !== null && group(following, 1).length === indent && sameList(marker, group(following, 2))) {
        i = next;
        continue;
      }
      break;
    }
    if (indentOf(line) > indent) {
      current.push(line.slice(Math.min(indentOf(line), contentIndent)));
      i++;
      continue;
    }
    if (startsBlock(lines, i)) break;
    current.push(line);
    i++;
  }
  const start = ordered(marker) ? Number.parseInt(marker, 10) : 1;
  return [{ kind: 'list', ordered: ordered(marker), start, items: items.map((content) => parseLines(content, depth + 1)) }, i];
}

function parseTable(lines: readonly string[], from: number): [Block, number] {
  const head = splitRow(lineAt(lines, from));
  const align = splitRow(lineAt(lines, from + 1)).map((cell): Align => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const rows: Inline[][][] = [];
  let i = from + 2;
  while (i < lines.length && !blank(lineAt(lines, i)) && lineAt(lines, i).includes('|')) {
    const cells = splitRow(lineAt(lines, i));
    rows.push(head.map((_, index) => parseInline(cells[index] ?? '')));
    i++;
  }
  return [{ kind: 'table', align, head: head.map((cell) => parseInline(cell)), rows }, i];
}

/** A fence's opening run (backticks or tildes), or null when the line opens no fence. */
function fenceOpening(line: string): string | null {
  const fence = FENCE.exec(line);
  if (fence === null || (group(fence, 1).startsWith('`') && group(fence, 2).includes('`'))) return null;
  return group(fence, 1);
}

/** Whether `line` closes the fence opened by `open`: same character, a run at least as long. */
function closesFence(line: string, open: string): boolean {
  const close = FENCE_CLOSE.exec(line);
  return close !== null && group(close, 1).charAt(0) === open.charAt(0) && group(close, 1).length >= open.length;
}

/**
 * Whether a quoted line leaves text a lazy line can continue: not blank, a
 * heading, a rule, a fence or an empty list item, also behind nested `>`.
 */
function opensParagraph(content: string): boolean {
  let inner = content;
  for (let nested = QUOTE.exec(inner); nested !== null; nested = QUOTE.exec(inner)) inner = group(nested, 1);
  if (blank(inner) || HEADING.test(inner) || RULE.test(inner) || fenceOpening(inner) !== null) return false;
  const item = ITEM.exec(inner);
  return item === null || !blank(group(item, 3));
}

/**
 * A quote: its lines with `>`, and the lazy ones after them (CommonMark). A
 * line without `>` still belongs to the quote when it continues a paragraph
 * there: the line before has text and is not a heading, a rule or in fenced
 * code, and the line itself starts no block. A lazy `===` stays text,
 * escaped, so it cannot underline the paragraph it continues.
 */
function parseQuote(lines: readonly string[], from: number, depth: number): [Block, number] {
  const body: string[] = [];
  /** The opening run of the fence the quote is inside, or null. */
  let fence: string | null = null;
  /** Whether the last line of the quote leaves a paragraph open. */
  let open = false;
  let i = from;
  while (i < lines.length) {
    const line = lineAt(lines, i);
    const quoted = QUOTE.exec(line);
    if (quoted === null) {
      if (!open || blank(line) || startsBlock(lines, i)) break;
      body.push(SETEXT.test(line) ? `\\${line.trim()}` : line);
      i++;
      continue;
    }
    const content = group(quoted, 1);
    body.push(content);
    i++;
    if (fence !== null) {
      if (closesFence(content, fence)) fence = null;
      open = false;
      continue;
    }
    // An underline after an open paragraph turns it into a heading, which takes no lazy line.
    const underlines: boolean = open && SETEXT.test(content);
    fence = fenceOpening(content);
    open = fence === null && !underlines && opensParagraph(content);
  }
  return [{ kind: 'quote', blocks: parseLines(body, depth + 1) }, i];
}

function parseLines(lines: readonly string[], depth: number): Block[] {
  if (depth > MAX_DEPTH) {
    const text = lines.join('\n').trim();
    return text === '' ? [] : [{ kind: 'paragraph', inlines: [{ kind: 'text', text }] }];
  }
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lineAt(lines, i);
    if (blank(line)) {
      i++;
      continue;
    }
    const opening = fenceOpening(line);
    if (opening !== null) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lineAt(lines, i), opening)) body.push(lineAt(lines, i++));
      i++;
      const info = line.trimStart().slice(opening.length);
      const lang = info.trim().split(/\s+/)[0] ?? '';
      blocks.push({ kind: 'code', lang: lang === '' ? null : lang, text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: group(heading, 1).length, inlines: parseInline(headingText(line, heading)) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const [quote, next] = parseQuote(lines, i, depth);
      blocks.push(quote);
      i = next;
      continue;
    }
    if (ITEM.test(line)) {
      const [list, next] = parseList(lines, i, depth);
      blocks.push(list);
      i = next;
      continue;
    }
    if (tableAt(lines, i)) {
      const [table, next] = parseTable(lines, i);
      blocks.push(table);
      i = next;
      continue;
    }
    const body = [line.trim()];
    i++;
    let level = 0;
    while (i < lines.length && !blank(lineAt(lines, i))) {
      const underline = SETEXT.exec(lineAt(lines, i));
      if (underline !== null) {
        // Checked before startsBlock: under a paragraph `---` is an underline, not a rule.
        level = group(underline, 1).startsWith('=') ? 1 : 2;
        i++;
        break;
      }
      if (startsBlock(lines, i)) break;
      body.push(lineAt(lines, i++).trim());
    }
    const inlines = parseInline(body.join('\n'));
    blocks.push(level === 0 ? { kind: 'paragraph', inlines } : { kind: 'heading', level, inlines });
  }
  return blocks;
}

/** The blocks of a Markdown text. */
export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replace(/\r\n?/g, '\n').split('\n'), 0);
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const BARE_URL = /https?:\/\/[^\s<>"'`]{1,2000}/y;
const URL_TRAIL = '.,;:!?\'"]';

/** The href of a link the page may open, or null: only http, https and mailto. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function tickRun(source: string, at: number): number {
  let end = at;
  while (source.charAt(end) === '`') end++;
  return end - at;
}

/** Where the backtick run of length `run` that closes a code span starts, or -1. */
function closingTicks(source: string, from: number, run: number): number {
  const limit = Math.min(source.length, from + MAX_SPAN);
  for (let j = from; j < limit; j++) {
    if (source.charAt(j) !== '`') continue;
    const length = tickRun(source, j);
    if (length === run) return j;
    j += length - 1;
  }
  return -1;
}

/**
 * Where `char` is between `from` and `limit`, or -1, also on a newline or a
 * `[` first: a link's address or title stops at the next link, so the scans
 * of many links never overlap.
 */
function findWithin(source: string, char: string, from: number, limit: number): number {
  for (let j = from; j < limit; j++) {
    const current = source.charAt(j);
    if (current === char) return j;
    if (current === '\n' || current === '[') return -1;
  }
  return -1;
}

/** Characters that end a bare link address: never unencoded in a URL, and they start the next link. */
const HREF_STOP = '[]<';

/**
 * The closing `]` of each `[`, matched in one pass (escapes and code spans
 * skipped): looking for it from every `[` would be quadratic.
 */
function matchBrackets(source: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let j = 0; j < source.length; j++) {
    const char = source.charAt(j);
    if (char === '\\') {
      j++;
      continue;
    }
    if (char === '`') {
      const run = tickRun(source, j);
      const close = closingTicks(source, j + run, run);
      j = close === -1 ? j + run - 1 : close + run - 1;
      continue;
    }
    if (char === '[') open.push(j);
    else if (char === ']') {
      const start = open.pop();
      if (start !== undefined) pairs.set(start, j);
    }
  }
  return pairs;
}

/** `[label](href "title")` starting at `at`, or null; `brackets` from matchBrackets. */
function linkAt(source: string, at: number, brackets: ReadonlyMap<number, number>): { label: string; href: string; end: number } | null {
  const j = brackets.get(at);
  if (j === undefined || j - at > MAX_SPAN || source.charAt(j + 1) !== '(') return null;
  const label = source.slice(at + 1, j);
  let k = j + 2;
  const hrefLimit = Math.min(source.length, k + MAX_SPAN);
  while (source.charAt(k) === ' ') k++;
  let href: string;
  if (source.charAt(k) === '<') {
    const end = findWithin(source, '>', k, hrefLimit);
    if (end === -1) return null;
    href = source.slice(k + 1, end);
    k = end + 1;
  } else {
    const start = k;
    let parens = 0;
    while (k < hrefLimit && !SPACE.test(source.charAt(k)) && !HREF_STOP.includes(source.charAt(k))) {
      if (source.charAt(k) === '(') parens++;
      if (source.charAt(k) === ')' && parens-- === 0) break;
      k++;
    }
    href = source.slice(start, k);
  }
  while (source.charAt(k) === ' ') k++;
  const quote = source.charAt(k);
  if (quote === '"' || quote === "'") {
    const end = findWithin(source, quote, k + 1, hrefLimit);
    if (end === -1) return null;
    k = end + 1;
    while (source.charAt(k) === ' ') k++;
  }
  return source.charAt(k) === ')' ? { label, href, end: k + 1 } : null;
}

/** A bare URL starting at `at`, without the punctuation that usually follows it. */
function bareUrlAt(source: string, at: number): string | null {
  if (at > 0 && (WORD.test(source.charAt(at - 1)) || source.charAt(at - 1) === '/')) return null;
  BARE_URL.lastIndex = at;
  const match = BARE_URL.exec(source);
  if (match === null) return null;
  // Trailing punctuation and unbalanced closing parentheses belong to the sentence: counted once, trimmed from the end.
  const found = match[0];
  let opened = 0;
  let closed = 0;
  for (const char of found) {
    if (char === '(') opened++;
    else if (char === ')') closed++;
  }
  let end = found.length;
  while (end > 0) {
    const char = found.charAt(end - 1);
    if (URL_TRAIL.includes(char)) end--;
    else if (char === ')' && opened < closed) {
      closed--;
      end--;
    } else break;
  }
  const url = found.slice(0, end);
  return url.length > 'https://'.length ? url : null;
}

const DELIMITERS: readonly { mark: string; kind: 'strong' | 'em' | 'strike' }[] = [
  { mark: '**', kind: 'strong' },
  { mark: '__', kind: 'strong' },
  { mark: '~~', kind: 'strike' },
  { mark: '*', kind: 'em' },
  { mark: '_', kind: 'em' },
];

/**
 * The inline elements of a paragraph, a heading or a table cell; a newline is
 * a line break. Inside a link's label (`inLink`) no other link is made.
 */
export function parseInline(source: string, inLink = false): Inline[] {
  const out: Inline[] = [];
  /** Delimiters with no closing after a position: later searches fail at once. */
  const unclosed = new Map<string, number>();
  const brackets = source.includes('[') ? matchBrackets(source) : new Map<number, number>();
  let text = '';
  const flush = (): void => {
    if (text !== '') out.push({ kind: 'text', text });
    text = '';
  };

  /** Where the closing `mark` starts (after a non-space, never in code), or -1. */
  function closing(from: number, mark: string): number {
    const known = unclosed.get(mark);
    if (known !== undefined && from >= known) return -1;
    const char = mark.charAt(0);
    for (let j = from; j < source.length; j++) {
      const current = source.charAt(j);
      if (current === '\\') {
        j++;
        continue;
      }
      if (current === '`') {
        const run = tickRun(source, j);
        const close = closingTicks(source, j + run, run);
        j = close === -1 ? j + run - 1 : close + run - 1;
        continue;
      }
      if (current !== char) continue;
      let end = j;
      while (source.charAt(end) === char) end++;
      const run = end - j;
      const fits = mark.length === 1 ? run !== 2 : run >= 2;
      if (fits && j > from && !SPACE.test(source.charAt(j - 1)) && !(char === '_' && WORD.test(source.charAt(end)))) return end - mark.length;
      j = end - 1;
    }
    unclosed.set(mark, Math.min(from, unclosed.get(mark) ?? from));
    return -1;
  }

  let i = 0;
  outer: while (i < source.length) {
    const char = source.charAt(i);
    if (char === '\\' && i + 1 < source.length && PUNCTUATION.test(source.charAt(i + 1))) {
      text += source.charAt(i + 1);
      i += 2;
      continue;
    }
    if (char === '\n') {
      flush();
      out.push({ kind: 'break' });
      i++;
      continue;
    }
    if (char === '`') {
      const run = tickRun(source, i);
      const close = closingTicks(source, i + run, run);
      if (close === -1) {
        text += source.slice(i, i + run);
        i += run;
        continue;
      }
      let code = source.slice(i + run, close).replace(/\n/g, ' ');
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      flush();
      out.push({ kind: 'code', text: code });
      i = close + run;
      continue;
    }
    if (char === '!' && source.charAt(i + 1) === '[') {
      const image = linkAt(source, i + 1, brackets);
      if (image !== null) {
        text += source.slice(i, image.end);
        i = image.end;
        continue;
      }
    }
    if (char === '[' && !inLink) {
      const link = linkAt(source, i, brackets);
      if (link !== null) {
        const href = safeHref(link.href);
        if (href === null) {
          text += source.slice(i, link.end);
        } else {
          flush();
          out.push({ kind: 'link', href, children: parseInline(link.label, true) });
        }
        i = link.end;
        continue;
      }
    }
    if (char === 'h' && !inLink) {
      const url = bareUrlAt(source, i);
      const href = url === null ? null : safeHref(url);
      if (url !== null && href !== null) {
        flush();
        out.push({ kind: 'link', href, children: [{ kind: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }
    for (const { mark, kind } of DELIMITERS) {
      if (!source.startsWith(mark, i)) continue;
      const after = source.charAt(i + mark.length);
      const opens = after !== '' && !SPACE.test(after) && !(mark.charAt(0) === '_' && i > 0 && WORD.test(source.charAt(i - 1)));
      const close = opens ? closing(i + mark.length, mark) : -1;
      if (close === -1) {
        text += mark;
        i += mark.length;
        continue outer;
      }
      flush();
      out.push({ kind, children: parseInline(source.slice(i + mark.length, close)) });
      i = close + mark.length;
      continue outer;
    }
    text += char;
    i++;
  }
  flush();
  return out;
}

/** The plain text of inline elements, for comparing a link's label with its address. */
export function inlineText(inlines: readonly Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case 'text':
        case 'code':
          return inline.text;
        case 'break':
          return '\n';
        default:
          return inlineText(inline.children);
      }
    })
    .join('');
}
