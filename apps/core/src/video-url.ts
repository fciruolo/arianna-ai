/**
 * The address of a YouTube video (D-273, tappa A). A link saved in kb/inbox
 * that names one video, in any of its forms (`youtube.com/watch?v=`,
 * `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, the mobile and music
 * hosts), becomes always the same address: `https://www.youtube.com/watch?v=<id>`,
 * without `t`, `si`, `list` or any other parameter. Playlists, channels and
 * every other page of YouTube are no video. A video is never downloaded by
 * itself, not even with youtube.com in `[capture] fetch_sites`: only with
 * «Riassumi il video», approved for that video.
 */

/** The id of a video: 11 characters of the URL-safe base64 alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'];
const PATH_FORMS = ['shorts', 'live', 'embed', 'v', 'e'];

export function isVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID.test(value);
}

/** The id of the video an address names, or undefined (not YouTube, a playlist, a channel, anything else). */
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
  if (host === 'youtu.be') {
    const [id, ...rest] = segments;
    return rest.length === 0 && isVideoId(id) ? id : undefined;
  }
  if (!WATCH_HOSTS.includes(host)) return undefined;
  if (segments.length === 1 && segments[0] === 'watch') {
    const ids = url.searchParams.getAll('v');
    const [id] = ids;
    return ids.length === 1 && isVideoId(id) ? id : undefined;
  }
  if (segments.length === 2 && PATH_FORMS.includes(segments[0] ?? '')) {
    const id = segments[1];
    return isVideoId(id) ? id : undefined;
  }
  return undefined;
}

/** The one address of a video, as the gateway takes it. */
export function videoUrl(id: string): string {
  if (!isVideoId(id)) throw new Error('not a video id');
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Any form of a video address normalized, or undefined when it is not one. */
export function normalizeVideoUrl(value: string): string | undefined {
  const id = youtubeVideoId(value);
  return id === undefined ? undefined : videoUrl(id);
}

/** Whether an address is a video of YouTube: never downloaded by the link downloader (D-154), by itself or with the button. */
export function isYoutubeVideo(value: string): boolean {
  return youtubeVideoId(value) !== undefined;
}

/** Where a minute of the video opens: the same address with `t`, built by the code from a number. */
export function videoAt(id: string, seconds: number): string {
  const at = Math.max(0, Math.floor(seconds));
  return `${videoUrl(id)}&t=${String(at)}s`;
}

/** Seconds as the note writes them: `m:ss` below one hour, `h:mm:ss` above. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${two(minutes)}:${two(rest)}` : `${two(minutes)}:${two(rest)}`;
}
