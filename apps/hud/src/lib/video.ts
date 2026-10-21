/**
 * The note of a YouTube video in "Pensieri" (D-273, tappa A): pure helpers.
 * The core recognizes and normalizes the address (apps/core/src/video-url.ts);
 * here the same rule decides only which button the panel shows. The minutes
 * of the note (`[12:34]`) are written by the code of the core: here they
 * become links to that second of the video.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'];
const PATH_FORMS = ['shorts', 'live', 'embed', 'v', 'e'];

/** The id of the video an address names, as the core reads it; undefined for anything else. */
export function youtubeVideoId(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username !== '' || url.password !== '' || url.port !== '') return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (host === 'youtu.be') return segments.length === 1 && VIDEO_ID.test(segments[0] ?? '') ? segments[0] : undefined;
  if (!WATCH_HOSTS.includes(host)) return undefined;
  if (segments.length === 1 && segments[0] === 'watch') {
    const ids = url.searchParams.getAll('v');
    return ids.length === 1 && VIDEO_ID.test(ids[0] ?? '') ? ids[0] : undefined;
  }
  if (segments.length === 2 && PATH_FORMS.includes(segments[0] ?? '')) return VIDEO_ID.test(segments[1] ?? '') ? segments[1] : undefined;
  return undefined;
}

export function isYoutubeVideo(value: string | null): boolean {
  return value !== null && youtubeVideoId(value) !== undefined;
}

/** What GET /api/notes/:name gives of the video of a note (D-273); null when it is not one. */
export interface NoteVideo {
  id: string;
  channel: string | null;
  duration: number | null;
  transcriptSource: string | null;
}

/** «Riassumi il video»: a note with a YouTube video not summarized yet. */
export function canSummarizeVideo(note: { url: string | null; video?: NoteVideo | null } | null): boolean {
  return note !== null && isYoutubeVideo(note.url) && (note.video ?? null) === null;
}

/** Seconds as the note writes them: mm:ss below one hour, h:mm:ss above. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${two(minutes)}:${two(rest)}` : `${two(minutes)}:${two(rest)}`;
}

/** `12:34` or `1:02:03` in seconds; undefined for anything else. */
export function seconds(text: string): number | undefined {
  const match = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const [, hours, minutes, rest] = match;
  const m = Number(minutes);
  const s = Number(rest);
  if (m > 59 || s > 59) return undefined;
  return Number(hours ?? 0) * 3600 + m * 60 + s;
}

/** That second of the video on YouTube. */
export function videoAt(id: string, at: number): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&t=${String(Math.max(0, Math.floor(at)))}s`;
}

/** A line of the note that starts with a minute: `- [12:34] text` or `> [12:34] text`. */
export interface TimedLine {
  at: number;
  clock: string;
  text: string;
}

/** The minute at the start of a line of the note, and the rest; undefined when it has none. */
export function timedLine(line: string, prefix: '- ' | '> '): TimedLine | undefined {
  if (!line.startsWith(`${prefix}[`)) return undefined;
  const close = line.indexOf(']', prefix.length + 1);
  if (close < 0) return undefined;
  const text = line.slice(prefix.length + 1, close);
  const at = seconds(text);
  if (at === undefined) return undefined;
  return { at, clock: text, text: line.slice(close + 1).trim() };
}

export type VideoSection =
  | { kind: 'text'; heading: string | null; text: string }
  | { kind: 'timed'; heading: string; lines: TimedLine[]; rest: string }
  | { kind: 'transcript'; lines: TimedLine[]; note: string | null };

const TIMED = ['Punti principali', 'Capitoli'];

/**
 * The body of the note of a video in its sections, as the core wrote them:
 * the points and the chapters with their minutes, the transcript apart (shown
 * closed), every other section as Markdown.
 */
export function videoSections(body: string): VideoSection[] {
  const sections: VideoSection[] = [];
  const parts = `\n${body}`.split('\n## ');
  const first = parts.shift()?.trim() ?? '';
  if (first !== '') sections.push({ kind: 'text', heading: null, text: first });
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const heading = (newline < 0 ? part : part.slice(0, newline)).trim();
    const text = newline < 0 ? '' : part.slice(newline + 1).trim();
    if (TIMED.includes(heading)) {
      const lines: TimedLine[] = [];
      const rest: string[] = [];
      for (const line of text.split('\n')) {
        const timed = timedLine(line, '- ');
        if (timed === undefined) rest.push(line);
        else lines.push(timed);
      }
      sections.push({ kind: 'timed', heading, lines, rest: rest.join('\n').trim() });
    } else if (heading === 'Trascrizione') {
      const lines: TimedLine[] = [];
      let note: string | null = null;
      for (const line of text.split('\n')) {
        const timed = timedLine(line, '> ');
        if (timed !== undefined) lines.push(timed);
        else if (line.startsWith('> ') && !line.startsWith('> [!')) note = line.slice(2).trim();
      }
      sections.push({ kind: 'transcript', lines, note });
    } else {
      sections.push({ kind: 'text', heading, text });
    }
  }
  return sections;
}

/** The text of a line of the note as the core wrote it inert: its escapes undone for reading. */
export function plainLine(text: string): string {
  return text
    .replace(/^\\#/, '#')
    .replace(/\[:\/\/\]/g, '://')
    .replace(/!\\\[/g, '![')
    .replace(/\]\\\(/g, '](')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** "12 min · Canale" of the panel; the source of the transcript in words. */
export function videoFacts(video: NoteVideo): string {
  const parts = [
    ...(video.duration === null ? [] : [video.duration >= 3600 ? clock(video.duration) : `${String(Math.max(1, Math.round(video.duration / 60)))} min`]),
    ...(video.channel === null ? [] : [video.channel]),
    ...(video.transcriptSource === null ? [] : [TRANSCRIPT_TEXT[video.transcriptSource] ?? '']),
  ];
  return parts.filter((part) => part !== '').join(' · ');
}

export const TRANSCRIPT_TEXT: Record<string, string> = {
  subtitles: 'dai sottotitoli',
  automatic: 'dai sottotitoli automatici',
  audio: 'dall’audio trascritto sul Mac',
};

/** What the job of a video is doing, in Italian (the stages of apps/core/src/video-job.ts). */
export const VIDEO_STAGE_TEXT: Record<string, string> = {
  queued: 'In coda: parte appena la macchina è libera (non durante una chiamata)',
  metadata: 'Leggo titolo, durata e sottotitoli del video…',
  subtitles: 'Scarico i sottotitoli…',
  audio: 'Niente sottotitoli: scarico l’audio…',
  transcribing: 'Trascrivo l’audio sul Mac, senza rete…',
  summarizing: 'Riassumo col modello locale…',
};

/** The state of the job as GET /api/notes/:name/video gives it. */
export interface VideoJob {
  state: 'queued' | 'running' | 'failed' | 'done';
  stage?: string;
  reason?: string;
  reasonText?: string;
}

/** The line of the panel for a job; null when there is nothing to say. */
export function videoJobText(job: VideoJob | null): string | null {
  if (job === null || job.state === 'done') return null;
  if (job.state === 'failed') return `Video non riassunto: ${job.reasonText ?? 'errore'}.`;
  if (job.state === 'queued') return VIDEO_STAGE_TEXT.queued ?? null;
  return VIDEO_STAGE_TEXT[job.stage ?? 'metadata'] ?? 'Al lavoro sul video…';
}

/** The text of the confirmation card: what leaves, what stays, the limits. */
export const VIDEO_CONFIRM_LINES: readonly string[] = [
  'Esce l’indirizzo del video verso YouTube e Google, dal tuo collegamento di casa; nient’altro dei tuoi dati.',
  'Prima provo i sottotitoli; solo se mancano scarico l’audio, lo trascrivo su questo Mac senza rete e lo cancello.',
  'Un video più lungo di 2 ore non si riassume.',
  'Le condizioni d’uso di YouTube vietano lo scaricamento: lo fai per uso personale, a tuo rischio.',
];
