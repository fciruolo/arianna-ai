// Frames of the Studio (I-19, D-184): the page builds a mockup's document
// (policy, Studio script, mockup) and hands it here; the core serves it back
// under a random token with a policy of its own. A `srcdoc` frame would
// inherit the chat's policy (`script-src 'self'`), which blocks the inline
// scripts and styles every mockup has.
import { randomBytes } from 'node:crypto';

/** A mockup (2 MiB) plus the Studio's script, with room to spare. */
export const MAX_FRAME_BYTES = 3 * 1024 * 1024;
/** How long a frame can be loaded after it was handed over. */
export const FRAME_TTL_MS = 10 * 60 * 1000;
/** Frames kept at once; the oldest goes first. */
export const MAX_FRAMES = 32;

export interface Frame {
  html: string;
  /** The frame that prints: the only one allowed to open the print dialog. */
  print: boolean;
}

interface Stored extends Frame {
  expires: number;
}

/** The policy of a served frame: sandboxed (opaque origin), no network, shown only in a page of the chat. */
export function frameHeaders(print: boolean): Record<string, string> {
  return {
    'content-security-policy': [
      `sandbox allow-scripts${print ? ' allow-modals' : ''}`,
      "default-src 'none'",
      "script-src 'unsafe-inline' data: blob:",
      "style-src 'unsafe-inline' data: blob:",
      'img-src data: blob:',
      'font-src data: blob:',
      'media-src data: blob:',
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'x-frame-options': 'SAMEORIGIN',
    'cross-origin-resource-policy': 'same-origin',
  };
}

export class FrameStore {
  readonly #frames = new Map<string, Stored>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Keeps a frame and answers its token: 32 hex characters. */
  put(frame: Frame): string {
    this.#sweep();
    while (this.#frames.size >= MAX_FRAMES) {
      const oldest = this.#frames.keys().next().value;
      if (oldest === undefined) break;
      this.#frames.delete(oldest);
    }
    const token = randomBytes(16).toString('hex');
    this.#frames.set(token, { ...frame, expires: this.#now() + FRAME_TTL_MS });
    return token;
  }

  /** The frame of a token still alive; it can be loaded again (a reload of the frame) until it expires. */
  get(token: string): Frame | undefined {
    this.#sweep();
    const found = this.#frames.get(token);
    return found === undefined ? undefined : { html: found.html, print: found.print };
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, frame] of this.#frames) if (frame.expires <= now) this.#frames.delete(token);
  }
}
