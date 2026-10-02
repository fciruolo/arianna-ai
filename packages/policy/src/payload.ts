// The text form of a payload fragment: what the scanner reads, what an approval
// hashes and what an adapter sends. Serialized once, so the checked text is the
// sent text even if the original object changes afterwards.
import { createHash } from 'node:crypto';

function isPlainJson(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const ok = Array.isArray(value)
    ? value.every((item) => isPlainJson(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isPlainJson(item, seen));
  seen.delete(value);
  return ok;
}

/**
 * A string as it is; plain JSON (objects, arrays, finite numbers, booleans,
 * null) as `JSON.stringify` writes it. Anything else (undefined, functions,
 * class instances, cycles) has no text the gateway could check: undefined.
 */
export function payloadText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isPlainJson(value, new Set())) return undefined;
  // A getter may still return something stringify drops: then there is no text.
  const text: unknown = JSON.stringify(value);
  return typeof text === 'string' ? text : undefined;
}

function collect(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) collect(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collect(item, out);
    }
  }
}

/**
 * The strings the scanner reads for a text form: the text itself when it is a
 * string, otherwise every key, string and number of the JSON decoded from it.
 * Escapes such as `\n` in the JSON text would hide the start of a match.
 */
export function scanParts(text: string, isJson: boolean): string[] {
  if (!isJson) return [text];
  const parts: string[] = [];
  collect(JSON.parse(text), parts);
  return parts;
}

/** Hex sha256 of a text form. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hex sha256 of the text form; undefined when the value has none. */
export function contentHash(value: unknown): string | undefined {
  const text = payloadText(value);
  return text === undefined ? undefined : sha256Hex(text);
}
