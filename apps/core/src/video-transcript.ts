import { decodeEntities } from './link-fetch.ts';

/**
 * The transcript of a video (D-273, tappa A): the subtitles yt-dlp wrote
 * (WebVTT) or the sentences of Parakeet, as numbered segments with their
 * second. The subtitles are untrusted text from the network: read here in one
 * linear pass, with indexOf and loops, never a regular expression that could
 * go back on what the file says.
 */

export interface Line {
  /** Seconds from the start of the video. */
  start: number;
  text: string;
}

export interface Segment extends Line {
  /** 1, 2, 3…: the number the model names, the code turns into a minute. */
  id: number;
}

/** Bytes of a subtitles file read at most (2 hours of automatic subtitles are about 2 MB). */
export const MAX_VTT_BYTES = 8 * 1024 * 1024;
const MAX_CUES = 100_000;
/** A segment closes past these characters or seconds. */
export const SEGMENT_CHARS = 240;
export const SEGMENT_SECONDS = 30;
const MAX_LINE = 2_000;

/** `hh:mm:ss.mmm` or `mm:ss.mmm` in seconds, or undefined. */
export function vttTime(text: string): number | undefined {
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return undefined;
  const last = parts.pop() ?? '';
  const dot = last.indexOf('.');
  if (dot !== 2 || last.length !== 6) return undefined;
  const numbers = [...parts, last.slice(0, 2), last.slice(3)];
  if (!numbers.every((part) => part.length > 0 && part.length <= 3 && /^[0-9]+$/.test(part))) return undefined;
  const [hours, minutes, seconds, millis] = parts.length === 2 ? numbers.map(Number) : [0, ...numbers.map(Number)];
  if (hours === undefined || minutes === undefined || seconds === undefined || millis === undefined || minutes > 59 || seconds > 59) return undefined;
  return ((hours * 3600 + minutes * 60 + seconds) * 1000 + millis) / 1000;
}

/** A line of a cue without its tags (`<c>`, `<00:00:01.200>`, `<v Nome>`), entities decoded, spaces folded. */
export function cueText(line: string): string {
  let out = '';
  let at = 0;
  while (at < line.length) {
    const open = line.indexOf('<', at);
    if (open < 0) {
      out += line.slice(at);
      break;
    }
    out += line.slice(at, open);
    const close = line.indexOf('>', open + 1);
    if (close < 0) break;
    at = close + 1;
  }
  return decodeEntities(out)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .split(' ')
    .filter((word) => word !== '')
    .join(' ')
    .slice(0, MAX_LINE);
}

/**
 * The lines of a WebVTT file in order, with the start of their cue. The
 * automatic subtitles of YouTube repeat each line in the next cue (rolling
 * captions): a line equal to one of the last two kept is dropped.
 */
export function parseVtt(text: string): Line[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Line[] = [];
  const recent: string[] = [];
  let cues = 0;
  for (let index = 0; index < lines.length && cues < MAX_CUES; index += 1) {
    const line = lines[index] ?? '';
    const arrow = line.indexOf('-->');
    if (arrow < 0) continue;
    const startText = line.slice(0, arrow).trim();
    const start = vttTime(startText);
    if (start === undefined) continue;
    cues += 1;
    for (index += 1; index < lines.length; index += 1) {
      const body = lines[index] ?? '';
      // Only a really empty line ends a cue: YouTube starts some with a line of one space.
      if (body === '') break;
      const clean = cueText(body);
      if (clean === '' || recent.includes(clean)) continue;
      out.push({ start, text: clean });
      recent.push(clean);
      if (recent.length > 2) recent.shift();
    }
  }
  return out;
}

/** Lines grouped into numbered segments of about SEGMENT_CHARS characters or SEGMENT_SECONDS seconds. */
export function toSegments(lines: readonly Line[]): Segment[] {
  const segments: Segment[] = [];
  let current: Line | undefined;
  for (const line of lines) {
    if (line.text === '' || !Number.isFinite(line.start)) continue;
    // A line far from the start of the segment opens a new one: its minute stays its own.
    if (current !== undefined && line.start - current.start >= SEGMENT_SECONDS) {
      segments.push({ id: segments.length + 1, start: current.start, text: current.text });
      current = undefined;
    }
    if (current === undefined) {
      current = { start: Math.max(0, line.start), text: line.text };
    } else {
      current.text = `${current.text} ${line.text}`;
    }
    if (current.text.length >= SEGMENT_CHARS) {
      segments.push({ id: segments.length + 1, start: current.start, text: current.text });
      current = undefined;
    }
  }
  if (current !== undefined) segments.push({ id: segments.length + 1, start: current.start, text: current.text });
  return segments;
}

/** The lines of Parakeet as the Python step gives them: `{start, text}`, checked again. */
export function readSpoken(value: unknown): Line[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CUES) return undefined;
  const lines: Line[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { start, text } = item as Record<string, unknown>;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || typeof text !== 'string') return undefined;
    const clean = cueText(text);
    if (clean !== '') lines.push({ start, text: clean });
  }
  return lines;
}

/** Where the transcript comes from: subtitles written by hand, automatic ones, or the audio heard on this Mac. */
export type TranscriptSource = 'subtitles' | 'automatic' | 'audio';

export interface SubtitleTracks {
  /** Language of the video as YouTube says it, if it does. */
  language: string | null;
  /** Languages with subtitles written by hand. */
  subtitles: readonly string[];
  /** Languages with automatic subtitles (`<lang>-orig` is the original one). */
  automatic: readonly string[];
}

export interface TrackChoice {
  lang: string;
  auto: boolean;
}

function base(lang: string): string {
  const dash = lang.indexOf('-');
  return (dash < 0 ? lang : lang.slice(0, dash)).toLowerCase();
}

function pick(langs: readonly string[], want: string): string | undefined {
  return langs.find((lang) => lang.toLowerCase() === want.toLowerCase()) ?? langs.find((lang) => base(lang) === base(want) && !lang.endsWith('-orig'));
}

/**
 * Which subtitles to download (D-273): those written by hand in the language
 * of the video, then the automatic ones of the original language, then Italian
 * or English (by hand first). Undefined: none, the audio is heard instead.
 */
export function chooseTrack(tracks: SubtitleTracks): TrackChoice | undefined {
  const original = tracks.language ?? tracks.automatic.find((lang) => lang.endsWith('-orig'))?.slice(0, -5) ?? null;
  if (original !== null) {
    const manual = pick(tracks.subtitles, original);
    if (manual !== undefined) return { lang: manual, auto: false };
    const auto = tracks.automatic.find((lang) => lang.toLowerCase() === `${original.toLowerCase()}-orig`) ?? pick(tracks.automatic, original);
    if (auto !== undefined) return { lang: auto, auto: true };
  }
  for (const want of ['it', 'en']) {
    const manual = pick(tracks.subtitles, want);
    if (manual !== undefined) return { lang: manual, auto: false };
  }
  for (const want of ['it', 'en']) {
    const auto = pick(tracks.automatic, want);
    if (auto !== undefined) return { lang: auto, auto: true };
  }
  return undefined;
}
