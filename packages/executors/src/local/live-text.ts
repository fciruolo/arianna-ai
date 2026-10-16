// Reading a local model's answer while it is written (D-249): the string
// fields of a JSON object as they come (the orchestrator's `thought` and the
// `text` of a reply, under constrained decoding), and the `<think>` block of
// a model that writes its reasoning in the answer. Pure, no dependency: fed
// the pieces of the stream, it returns what can be shown so far.

/** A new piece of a string field of the top-level object. */
export interface FieldPiece {
  key: string;
  text: string;
}

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/**
 * The string values of the top-level object of a JSON text, decoded as the
 * text arrives: escapes split over two pieces included. Nested objects and
 * arrays are walked over, their strings never reported. Malformed text is
 * not an error here: the caller parses the whole answer at the end, as
 * before; this only shows it sooner.
 */
export class JsonFieldStream {
  /** Every top-level string value read so far, whole or in part, by key. */
  readonly values = new Map<string, string>();
  #depth = 0;
  #inString = false;
  #isKey = false;
  #expectKey = false;
  #key = '';
  #lastKey: string | undefined;
  /** The key of the top-level value string being read; undefined inside a key or a nested string. */
  #current: string | undefined;
  /** Undefined outside an escape; '' right after the backslash; 'u…' while a \u escape is read. */
  #escape: string | undefined;
  #high: number | undefined;
  #pieces: FieldPiece[] = [];

  feed(chunk: string): FieldPiece[] {
    this.#pieces = [];
    for (const char of chunk) this.#char(char);
    return this.#pieces;
  }

  #char(char: string): void {
    if (this.#inString) {
      this.#inside(char);
      return;
    }
    switch (char) {
      case '{':
      case '[':
        this.#depth += 1;
        if (char === '{' && this.#depth === 1) this.#expectKey = true;
        return;
      case '}':
      case ']':
        this.#depth = Math.max(0, this.#depth - 1);
        return;
      case ',':
        if (this.#depth === 1) this.#expectKey = true;
        return;
      case '"':
        this.#inString = true;
        this.#escape = undefined;
        this.#high = undefined;
        if (this.#depth === 1 && this.#expectKey) {
          this.#isKey = true;
          this.#key = '';
          this.#expectKey = false;
          this.#current = undefined;
        } else {
          this.#isKey = false;
          this.#current = this.#depth === 1 ? this.#lastKey : undefined;
          if (this.#current !== undefined) this.values.set(this.#current, '');
        }
        return;
      default:
        return;
    }
  }

  #inside(char: string): void {
    if (this.#escape !== undefined) {
      if (this.#escape === '' && char !== 'u') {
        this.#escape = undefined;
        this.#out(ESCAPES[char] ?? char);
        return;
      }
      this.#escape += char;
      if (this.#escape.length < 5) return;
      const hex = this.#escape.slice(1);
      this.#escape = undefined;
      if (!/^[0-9a-f]{4}$/i.test(hex)) return;
      const code = Number.parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        this.#high = code;
        return;
      }
      if (code >= 0xdc00 && code <= 0xdfff && this.#high !== undefined) {
        const high = this.#high;
        this.#high = undefined;
        this.#out(String.fromCharCode(high, code));
        return;
      }
      this.#high = undefined;
      this.#out(String.fromCharCode(code));
      return;
    }
    if (char === '\\') {
      this.#escape = '';
      return;
    }
    if (char === '"') {
      this.#inString = false;
      if (this.#isKey) this.#lastKey = this.#key;
      this.#isKey = false;
      this.#current = undefined;
      return;
    }
    this.#out(char);
  }

  #out(text: string): void {
    if (this.#isKey) {
      this.#key += text;
      return;
    }
    const key = this.#current;
    if (key === undefined) return;
    this.values.set(key, (this.values.get(key) ?? '') + text);
    const last = this.#pieces.at(-1);
    if (last?.key === key) last.text += text;
    else this.#pieces.push({ key, text });
  }
}

/** A piece of an answer split at its `<think>` block. */
export interface ThinkPiece {
  part: 'thought' | 'text';
  text: string;
}

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Splits a streamed answer into the reasoning inside `<think>…</think>` and
 * the rest, as it comes. The end of a piece that could be the start of a tag
 * waits for the next piece; `end` gives it back.
 */
export class ThinkSplitter {
  #mode: 'text' | 'thought' = 'text';
  #held = '';
  /** The answer without its `<think>` blocks, so far. */
  text = '';
  /** The reasoning inside them, so far. */
  thought = '';

  feed(chunk: string): ThinkPiece[] {
    let rest = this.#held + chunk;
    this.#held = '';
    const pieces: ThinkPiece[] = [];
    for (;;) {
      const tag = this.#mode === 'text' ? OPEN : CLOSE;
      const at = rest.indexOf(tag);
      if (at >= 0) {
        this.#emit(pieces, rest.slice(0, at));
        rest = rest.slice(at + tag.length);
        this.#mode = this.#mode === 'text' ? 'thought' : 'text';
        continue;
      }
      // Keep back the longest end of `rest` that starts the tag.
      let keep = 0;
      for (let length = Math.min(tag.length - 1, rest.length); length > 0; length -= 1) {
        if (tag.startsWith(rest.slice(rest.length - length))) {
          keep = length;
          break;
        }
      }
      this.#emit(pieces, rest.slice(0, rest.length - keep));
      this.#held = rest.slice(rest.length - keep);
      return pieces;
    }
  }

  /** What was held back at the end of the stream. */
  end(): ThinkPiece[] {
    const pieces: ThinkPiece[] = [];
    this.#emit(pieces, this.#held);
    this.#held = '';
    return pieces;
  }

  #emit(pieces: ThinkPiece[], text: string): void {
    if (text === '') return;
    const part = this.#mode;
    if (part === 'text') this.text += text;
    else this.thought += text;
    const last = pieces.at(-1);
    if (last?.part === part) last.text += text;
    else pieces.push({ part, text });
  }
}
