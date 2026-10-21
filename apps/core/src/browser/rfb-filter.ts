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
 * - dropped: 4 KeyEvent and 5 PointerEvent in `view` mode, 6 ClientCutText
 *   always;
 * - the end of the connection: 250 xvp, 251 SetDesktopSize, 255 QEMU and
 *   every unknown type, since without its length the rest of the stream can
 *   no longer be read; also a message longer than its cap.
 *
 * «Prendi il controllo» (D-264, passo 5): in `control` mode keys and pointer
 * pass, never the clipboard. The mode changes on an open filter (setMode):
 * the screen that took the control, and only it.
 * - SetEncodings is rewritten without the encodings that would change the
 *   length of a key or pointer message (REFUSED_ENCODINGS): noVNC 1.7.0 asks
 *   for the QEMU keys (-258, then every key is a message 255, which closes)
 *   and the extended mouse buttons (-316, a 7-byte pointer message); Xvnc
 *   never hears of them, so noVNC never sends them. A pointer message with
 *   the bit of the extended buttons closes all the same, in both modes: its
 *   length would be wrong and the rest of the stream unreadable.
 * - Keys that reach the browser chrome are dropped (droppedKeysym: F1-F35,
 *   Super, Meta, Hyper), and every key while one of those modifiers is down:
 *   Cmd+V on a Mac becomes nothing, not a «v»; Ctrl+Shift+I, J and C (the
 *   developer tools, which a policy cannot turn off without stopping the
 *   CDP of the core: their pages are blocked by the policies of the image
 *   too).
 * - Keys pressed and clicks are counted, never their values (the event
 *   `browser.control`).
 *
 * Pure: chunks may split a message or carry several at once.
 */

export type ScreenMode = 'view' | 'control';

export type FilterClose = 'bad-version' | 'bad-security' | 'bad-init' | 'refused-type' | 'too-long' | 'extended-pointer';

/**
 * Pseudo-encodings never told to Xvnc: QEMU extended keys (-258), QEMU LED
 * state (-261), xvp (-309), extended mouse buttons (-316).
 */
export const REFUSED_ENCODINGS: readonly number[] = [-258, -261, -309, -316];

/** The bit of the button mask noVNC sets for the extended mouse buttons (a 7-byte message). */
const EXTENDED_POINTER = 0x80;
/** The three buttons whose press counts as a click (the wheel is 4-7). */
const CLICK_BUTTONS = 0x07;

/** Meta, Super and Hyper, left and right: modifiers that reach the window manager or the browser chrome. */
function chromeModifier(keysym: number): boolean {
  return (keysym >= 0xffe7 && keysym <= 0xffe8) || (keysym >= 0xffeb && keysym <= 0xffee);
}

/** Whether a keysym is dropped in control: F1-F35 and the chrome modifiers. */
export function droppedKeysym(keysym: number): boolean {
  return (keysym >= 0xffbe && keysym <= 0xffe0) || chromeModifier(keysym);
}

const CONTROL_KEYS = [0xffe3, 0xffe4];
const SHIFT_KEYS = [0xffe1, 0xffe2];
/** I, J and C, either case: with Ctrl and Shift, the developer tools. */
const DEVTOOLS_LETTERS = [0x49, 0x69, 0x4a, 0x6a, 0x43, 0x63];

/** Keys pressed and clicks forwarded in control, never their values. */
export interface InputCounts {
  keys: number;
  clicks: number;
}

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
  /** `control`: keys and pointer pass from the next message on; `view`: dropped again. */
  setMode(mode: ScreenMode): void;
  /** Keys pressed and clicks forwarded so far in control. */
  readonly counts: Readonly<InputCounts>;
  push(chunk: Buffer): FilterStep;
}

/** SetEncodings without REFUSED_ENCODINGS, its count written again. */
function rewriteEncodings(message: Buffer): Buffer {
  const count = message.readUInt16BE(2);
  const kept: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const encoding = message.readInt32BE(4 + 4 * index);
    if (!REFUSED_ENCODINGS.includes(encoding)) kept.push(encoding);
  }
  const out = Buffer.alloc(4 + 4 * kept.length);
  out[0] = 2;
  out.writeUInt16BE(kept.length, 2);
  kept.forEach((encoding, index) => out.writeInt32BE(encoding, 4 + 4 * index));
  return out;
}

export function createRfbFilter(initial: ScreenMode = 'view'): RfbFilter {
  let mode: ScreenMode = initial;
  let phase: Phase = 'version';
  let pending: Buffer = Buffer.alloc(0);
  let closed: FilterClose | undefined;
  const counts: InputCounts = { keys: 0, clicks: 0 };
  /** Chrome modifiers down now (their keysyms): every key is dropped while one is. */
  const modifiers = new Set<number>();
  /** Ctrl and Shift down now (forwarded, but read for Ctrl+Shift+I/J/C). */
  const held = new Set<number>();
  /** The button mask of the last pointer message forwarded, to count a click once. */
  let buttons = 0;

  /** In control: whether a key message passes; counts a key pressed. */
  const keyPasses = (message: Buffer): boolean => {
    const down = message[1] !== 0;
    const keysym = message.readUInt32BE(4);
    if (chromeModifier(keysym)) {
      if (down) modifiers.add(keysym);
      else modifiers.delete(keysym);
      return false;
    }
    if (droppedKeysym(keysym) || modifiers.size > 0) return false;
    if (CONTROL_KEYS.includes(keysym) || SHIFT_KEYS.includes(keysym)) {
      if (down) held.add(keysym);
      else held.delete(keysym);
    } else if (DEVTOOLS_LETTERS.includes(keysym) && CONTROL_KEYS.some((key) => held.has(key)) && SHIFT_KEYS.some((key) => held.has(key))) {
      return false;
    }
    if (down) counts.keys += 1;
    return true;
  };

  /** In control: counts a button that went down since the last pointer message. */
  const countPointer = (message: Buffer): void => {
    const mask = (message[1] ?? 0) & CLICK_BUTTONS;
    if ((mask & (buttons ^ CLICK_BUTTONS)) !== 0) counts.clicks += 1;
    buttons = mask;
  };

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
        // Keys and pointer: dropped in `view`, read one by one in `control`.
        return mode === 'control' ? 'forward' : 'drop';
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
    get mode() {
      return mode;
    },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      // Keys held when the control changed are forgotten.
      modifiers.clear();
      held.clear();
      buttons = 0;
    },
    get counts() {
      return { ...counts };
    },
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
        // The extended buttons were never told to Xvnc: such a message has another length.
        if (type === 5 && pending.length >= 2 && ((pending[1] ?? 0) & EXTENDED_POINTER) !== 0) return fail('extended-pointer', forward);
        if (length === null || pending.length < length) return { forward };
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (verdict !== 'forward') continue;
        if (type === 2) {
          forward.push(rewriteEncodings(message));
          continue;
        }
        if (type === 4 && !keyPasses(message)) continue;
        if (type === 5) countPointer(message);
        // A copy: the chunk of the WebSocket is not kept alive by what goes to Xvnc.
        forward.push(Buffer.from(message));
      }
    },
  };
}
