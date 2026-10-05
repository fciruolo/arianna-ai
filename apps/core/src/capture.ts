import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAtMost, labelForKbPage, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { checkPagePath, KB_DIR, KB_INBOX, KbError } from './orchestrator/kb.ts';

/**
 * Deterministic capture into kb/inbox (D-080, first part): a thought, a link
 * or a note becomes a new page, without a model. The header is written only
 * here; what the user wrote goes to the body, where it cannot change the
 * label. The label is never below L2, whatever the channel or the
 * conversation it came from: lowering it is the user's choice, later.
 */
export const CAPTURE_KINDS = ['thought', 'link', 'note'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
export const CAPTURE_CHANNELS = ['hud', 'cli'] as const;
export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

export const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_TITLE = 200;
const MAX_URL = 2_000;
const MAX_SLUG = 40;
/** Same second, same slug: -2, -3... before giving up. */
const MAX_ATTEMPTS = 50;

export type CaptureErrorCode = 'invalid' | 'too-large' | 'not-allowed' | 'unavailable';

/** Messages name fixed reasons, never the captured text. */
export class CaptureError extends Error {
  override name = 'CaptureError';
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type CaptureSource = { channel: CaptureChannel; id: string } | { messageId: string };

export interface CaptureInput {
  home: string;
  rules: LabelRules;
  text: string;
  kind: CaptureKind;
  /** Written as `capture:<channel>:<id>`, or `message:<id>` for a message of the chat saved in the inbox (D-089). */
  source: CaptureSource;
  url?: string;
  title?: string;
  /** The label of what the capture came from (a work conversation: L1); it can only raise the note. */
  from?: Label;
  now?: Date;
}

export interface CaptureResult {
  /** Relative to ARIANNA_HOME, e.g. kb/inbox/2026-10-05-081244-comprare-il-pane.md. */
  path: string;
  label: Label;
}

export function isCaptureKind(value: unknown): value is CaptureKind {
  return CAPTURE_KINDS.some((kind) => kind === value);
}

/** An http(s) URL, normalized; anything else (file:, javascript:, data:...) is refused. */
export function checkCaptureUrl(value: string): string {
  if (value.length > MAX_URL || /\s/.test(value)) throw new CaptureError('invalid', 'url must be a single http(s) address');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CaptureError('invalid', 'url must be a single http(s) address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new CaptureError('invalid', 'url must be http or https');
  return parsed.href;
}

/** ASCII, lowercase, dashes: "Càparra dell'affitto!" → "caparra-dell-affitto". */
export function slugOf(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug === '' ? 'nota' : slug;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Local time with its offset: 2026-10-05T08:12:44+02:00. */
export function localTimestamp(now: Date): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const date = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function fileStamp(now: Date): string {
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function checkInput(input: CaptureInput): { text: string; url?: string; title?: string } {
  if (!isCaptureKind(input.kind)) throw new CaptureError('invalid', `kind must be one of ${CAPTURE_KINDS.join(', ')}`);
  if ('messageId' in input.source) {
    if (!/^[1-9]\d{0,18}$/.test(input.source.messageId)) throw new CaptureError('invalid', 'invalid source');
  } else if (!CAPTURE_CHANNELS.includes(input.source.channel) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.source.id)) {
    throw new CaptureError('invalid', 'invalid source');
  }
  if (typeof input.text !== 'string') throw new CaptureError('invalid', 'text is required');
  if (Buffer.byteLength(input.text, 'utf8') > MAX_CAPTURE_BYTES) {
    throw new CaptureError('too-large', `text is longer than ${String(MAX_CAPTURE_BYTES / 1024)} KiB`);
  }
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (text === '') throw new CaptureError('invalid', 'text is empty');
  if (text.includes('\0')) throw new CaptureError('invalid', 'text holds a NUL character');
  const url = input.url === undefined ? undefined : checkCaptureUrl(input.url.trim());
  if (input.kind === 'link' && url === undefined) throw new CaptureError('invalid', 'a link needs an url');
  let title: string | undefined;
  if (input.title !== undefined) {
    title = input.title.trim();
    // One line, no control characters nor line separators: the title goes to the header.
    if (title === '' || title.length > MAX_TITLE || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) throw new CaptureError('invalid', `title must be one line of at most ${String(MAX_TITLE)} characters`);
  }
  return { text, ...(url === undefined ? {} : { url }), ...(title === undefined ? {} : { title }) };
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** kb/ must be a real folder; kb/inbox is created if missing, and must be a real folder too. */
export function inboxDir(home: string): string {
  let dir = home;
  for (const [index, segment] of KB_INBOX.split('/').entries()) {
    dir = join(dir, segment);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      if (index === 0) throw new CaptureError('unavailable', `there is no ${KB_DIR}/ folder`);
      try {
        mkdirSync(dir, { mode: 0o700 });
        continue;
      } catch (error) {
        // Created meanwhile by another capture: look at it again below.
        if (errorCode(error) !== 'EEXIST') throw new CaptureError('unavailable', `cannot create ${KB_INBOX}`);
      }
      try {
        stat = lstatSync(dir);
      } catch {
        throw new CaptureError('unavailable', `cannot create ${KB_INBOX}`);
      }
    }
    // A link would take the note elsewhere.
    if (!stat.isDirectory()) throw new CaptureError('unavailable', `${KB_INBOX} is not a folder`);
  }
  return dir;
}

/** The folder still is home/kb/inbox, with no link swapped in since it was checked. */
export function sameInbox(home: string, dir: string): boolean {
  try {
    return realpathSync(dir) === join(realpathSync(home), ...KB_INBOX.split('/'));
  } catch {
    return false;
  }
}

function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** The value of the `source:` line, written only here. */
export function sourceLine(source: CaptureSource): string {
  return 'messageId' in source ? `message:${source.messageId}` : `capture:${source.channel}:${source.id}`;
}

export function captureNote(input: CaptureInput): CaptureResult {
  const { text, url, title } = checkInput(input);
  const now = input.now ?? new Date();
  const base = `${KB_INBOX}/${fileStamp(now)}-${slugOf(title ?? text.split('\n', 1)[0] ?? '')}`;

  // The folder rule may raise the inbox above L2: then nothing is written.
  const label = maxLabel('L2', input.from ?? 'L2', labelForKbPage(input.rules, `${base}.md`, undefined));
  if (!isAtMost(label, 'L2')) throw new CaptureError('not-allowed', `${KB_INBOX} is labeled ${label}: captures stop at L2`);

  const dir = inboxDir(input.home);
  const header = [
    '---',
    `label: ${label}`,
    `source: ${sourceLine(input.source)}`,
    `captured_at: ${localTimestamp(now)}`,
    `kind: ${input.kind}`,
    'status: new',
    ...(url === undefined ? [] : [`url: ${url}`]),
    // JSON strings are YAML strings: quotes, colons and # stay text; parsePage reads them without the quotes.
    ...(title === undefined ? [] : [`title: ${JSON.stringify(title)}`]),
    '---',
  ].join('\n');
  const content = `${header}\n\n${text}\n`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let path: string;
    try {
      path = checkPagePath(`${base}${attempt === 1 ? '' : `-${String(attempt)}`}.md`);
    } catch (error) {
      if (error instanceof KbError) throw new CaptureError('invalid', 'cannot name the note');
      throw error;
    }
    const file = join(dir, path.split('/').at(-1) ?? '');
    let fd: number;
    try {
      // O_EXCL: an existing page is never touched; O_NOFOLLOW: a link is refused, not followed.
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw new CaptureError('unavailable', 'cannot create the note');
    }
    let written = false;
    try {
      // A folder swapped for a link between the checks and the open: the empty file goes, nothing is written.
      if (sameInbox(input.home, dir)) {
        writeFileSync(fd, content);
        written = true;
      }
    } catch {
      // Disk full, I/O error: below, the partial note goes.
    } finally {
      closeSync(fd);
    }
    if (!written) {
      remove(file);
      throw new CaptureError('unavailable', 'cannot create the note');
    }
    return { path, label };
  }
  throw new CaptureError('unavailable', 'too many notes with the same name in this second');
}
