/**
 * The filter of the stream from the chat to Xvnc (D-264, passo 4): the
 * screen of the browser is a VNC client in the page, and the core reads every
 * byte it sends before the container gets it. RFB 3.8 only, with the
 * security type None (Xvnc listens on a Unix socket reached only through
 * `docker exec`).
 *
 * After the handshake (12 bytes of version, 1 byte of security type, 1 byte
 * of ClientInit) every client message is read whole, by its type and its
 * length:
 * - forwarded: 0 SetPixelFormat, 2 SetEncodings, 3 FramebufferUpdateRequest,
 *   150 EnableContinuousUpdates, 248 ClientFence;
 * - dropped: 4 KeyEvent and 5 PointerEvent in `view` mode (the `control` mode
 *   of passo 5 will forward them), 6 ClientCutText always;
 * - the end of the connection: 250 xvp, 251 SetDesktopSize, 255 QEMU and
 *   every unknown type, since without its length the rest of the stream can
 *   no longer be read; also a message longer than its cap.
 *
 * Pure: chunks may split a message or carry several at once.
 */

/** `view` only today; `control` (passo 5) will forward keys and pointer, never the clipboard. */
export type ScreenMode = 'view';

export type FilterClose = 'bad-version' | 'bad-security' | 'bad-init' | 'refused-type' | 'too-long';

export interface FilterStep {
  /** Whole messages (or handshake bytes) for Xvnc, in order. */
  forward: Buffer[];
  /** The connection must close; nothing after it is read. */
  close?: FilterClose;
}

export const RFB_VERSION = 'RFB 003.008\n';
const SECURITY_NONE = 1;
/** SetEncodings: noVNC asks for about 25; more is not a client of ours. */
export const MAX_ENCODINGS = 64;
/** ClientFence: the payload is at most 64 bytes by the protocol. */
export const MAX_FENCE = 64;
/** ClientCutText is always dropped, read only to skip it: past this the connection closes. */
export const MAX_CUT_TEXT = 64 * 1024;

type Phase = 'version' | 'security' | 'init' | 'messages' | 'closed';

/** What a message of a type is: forwarded, dropped, or the end. */
type Verdict = 'forward' | 'drop';

export interface RfbFilter {
  readonly mode: ScreenMode;
  push(chunk: Buffer): FilterStep;
}

export function createRfbFilter(mode: ScreenMode = 'view'): RfbFilter {
  let phase: Phase = 'version';
  let pending: Buffer = Buffer.alloc(0);
  let closed: FilterClose | undefined;

  const verdictOf = (type: number): Verdict | undefined => {
    switch (type) {
      case 0:
      case 2:
      case 3:
      case 150:
      case 248:
        return 'forward';
      case 4:
      case 5:
        // Keys and pointer: dropped in `view`; `control` (passo 5) will forward them.
        return 'drop';
      case 6:
        return 'drop';
      default:
        return undefined;
    }
  };

  /** The whole length of the message at the start of `buffer`; null when more bytes are needed to know it. */
  const lengthOf = (buffer: Buffer): number | null | FilterClose => {
    const type = buffer[0];
    switch (type) {
      case 0:
        return 20;
      case 2: {
        if (buffer.length < 4) return null;
        const count = buffer.readUInt16BE(2);
        if (count > MAX_ENCODINGS) return 'too-long';
        return 4 + 4 * count;
      }
      case 3:
      case 150:
        return 10;
      case 248: {
        if (buffer.length < 9) return null;
        const size = buffer[8] ?? 0;
        if (size > MAX_FENCE) return 'too-long';
        return 9 + size;
      }
      case 4:
        return 8;
      case 5:
        return 6;
      case 6: {
        if (buffer.length < 8) return null;
        // Signed: a negative length is the extended clipboard, its absolute value the size.
        const size = Math.abs(buffer.readInt32BE(4));
        if (size > MAX_CUT_TEXT) return 'too-long';
        return 8 + size;
      }
      default:
        return 'refused-type';
    }
  };

  const fail = (reason: FilterClose, forward: Buffer[]): FilterStep => {
    closed = reason;
    phase = 'closed';
    pending = Buffer.alloc(0);
    return { forward, close: reason };
  };

  return {
    mode,
    push(chunk) {
      if (phase === 'closed') return { forward: [], close: closed ?? 'refused-type' };
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const forward: Buffer[] = [];
      for (;;) {
        if (phase === 'version') {
          // Checked byte by byte as they come: a wrong first byte closes at once.
          const expected = Buffer.from(RFB_VERSION, 'latin1');
          const seen = pending.subarray(0, expected.length);
          if (!seen.equals(expected.subarray(0, seen.length))) return fail('bad-version', forward);
          if (pending.length < expected.length) return { forward };
          forward.push(Buffer.from(seen));
          pending = pending.subarray(expected.length);
          phase = 'security';
          continue;
        }
        if (pending.length === 0) return { forward };
        if (phase === 'security') {
          if (pending[0] !== SECURITY_NONE) return fail('bad-security', forward);
          forward.push(Buffer.from([SECURITY_NONE]));
          pending = pending.subarray(1);
          phase = 'init';
          continue;
        }
        if (phase === 'init') {
          // ClientInit: the shared flag, 0 or 1 (Xvnc runs with -AlwaysShared anyway).
          const shared = pending[0] ?? 0;
          if (shared > 1) return fail('bad-init', forward);
          forward.push(Buffer.from([shared]));
          pending = pending.subarray(1);
          phase = 'messages';
          continue;
        }
        const type = pending[0] ?? 0;
        const verdict = verdictOf(type);
        if (verdict === undefined) return fail('refused-type', forward);
        const length = lengthOf(pending);
        if (typeof length === 'string') return fail(length, forward);
        if (length === null || pending.length < length) return { forward };
        // A copy: the chunk of the WebSocket is not kept alive by what goes to Xvnc.
        if (verdict === 'forward') forward.push(Buffer.from(pending.subarray(0, length)));
        pending = pending.subarray(length);
      }
    },
  };
}
